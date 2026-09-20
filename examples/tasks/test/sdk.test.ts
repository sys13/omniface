import { createClient, FacetClientError } from '@omniface/client'
import { buildManifest, createServer } from 'omniface'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createTasksApp, DEV_KEYS, type TasksApp } from '../src/app.ts'

function setup(options: { apiKey?: string; withManifest?: boolean } = {}) {
  const app = createTasksApp({ logSink: () => {} })
  const server = createServer(app)
  const requests: Request[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    requests.push(req.clone())
    return server.fetch(req)
  }
  const client = createClient<TasksApp>({
    baseUrl: 'http://facet.test',
    apiKey: options.apiKey ?? DEV_KEYS.admin,
    fetch: fetchFn,
    retries: 0,
    ...(options.withManifest ? { manifest: buildManifest(app) } : {}),
  })
  return { client, requests }
}

describe('inferred TypeScript client', () => {
  it('is fully typed from the app definition, with no codegen', async () => {
    const { client } = setup()
    const task = await client.tasks.create({ title: 'Typed' })
    expectTypeOf(task.title).toEqualTypeOf<string>()
    expectTypeOf(task.priority).toEqualTypeOf<'low' | 'normal' | 'high'>()
    expectTypeOf(client.tasks.get).parameter(0).toEqualTypeOf<{ id: string }>()
    // Plugin-contributed ops are typed too.
    const me = await client.auth.whoami()
    expectTypeOf(me.scopes).toEqualTypeOf<string[]>()
    // @ts-expect-error — title is required
    await expect(client.tasks.create({})).rejects.toThrow()
    expect(task).toMatchObject({ title: 'Typed', done: false })
  })

  it('fetches the manifest once when none is embedded', async () => {
    const { client, requests } = setup()
    await client.tasks.create({ title: 'a' })
    await client.tasks.list()
    expect(requests.filter((r) => r.url.endsWith('/.well-known/facet.json'))).toHaveLength(1)
  })

  it('iterates every page of a paginated op', async () => {
    const { client } = setup({ withManifest: true })
    for (let i = 1; i <= 7; i++) await client.tasks.create({ title: `T${i}` })
    const titles: string[] = []
    for await (const task of client.tasks.list.iterate({ limit: 3 })) {
      expectTypeOf(task.title).toEqualTypeOf<string>()
      titles.push(task.title)
    }
    expect(titles).toEqual(['T7', 'T6', 'T5', 'T4', 'T3', 'T2', 'T1'])
  })

  it('throws typed errors carrying the server error model', async () => {
    const { client } = setup({ withManifest: true })
    const err = await client.tasks.get({ id: 'task_missing' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FacetClientError)
    expect(err).toMatchObject({ code: 'not_found', status: 404, message: 'No task "task_missing"' })
    expect((err as FacetClientError).requestId).toMatch(/^req_/)
  })

  it('sends an idempotency key for idempotent writes only, and identifies itself', async () => {
    const { client, requests } = setup({ withManifest: true })
    await client.tasks.create({ title: 'x' })
    await client.tasks.complete({ id: 'task_1' })
    const [create, complete] = requests
    expect(create!.headers.get('idempotency-key')).toBeNull()
    expect(complete!.headers.get('idempotency-key')).toMatch(/[0-9a-f-]{36}/)
    expect(complete!.headers.get('x-omniface-via')).toBe('sdk')
    expect(new URL(complete!.url).pathname).toBe('/tasks/task_1/complete')
  })

  it('retries a rate-limited call after Retry-After', async () => {
    const app = createTasksApp({ limit: { requests: 1, windowSeconds: 1 }, logSink: () => {} })
    const server = createServer(app)
    const client = createClient<TasksApp>({
      baseUrl: 'http://facet.test',
      apiKey: DEV_KEYS.admin,
      manifest: buildManifest(app),
      fetch: async (i, init) => server.fetch(new Request(i, init)),
      retries: 1,
    })
    await client.auth.whoami()
    const started = Date.now()
    await expect(client.auth.whoami()).resolves.toMatchObject({ id: 'user_admin' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })
})
