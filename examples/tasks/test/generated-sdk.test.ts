import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build, buildManifest, createServer } from 'omniface'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTasksApp, DEV_KEYS } from '../src/app.ts'

const run = promisify(execFile)
const repoRoot = new URL('../../../', import.meta.url).pathname

/**
 * The generated SDK package (backlog 5.1): what a consumer outside this repo installs.
 *
 * The inferred client is covered by `sdk.test.ts`; it cannot be, because it infers its types from
 * the server module. This one is built from the manifest alone, and the two things worth proving
 * about it are that its types are real TypeScript that describe the app, and that the package it
 * emits actually runs against a server.
 */
describe('the generated SDK package', () => {
  let dir: string
  let sdkDir: string

  beforeAll(async () => {
    // Built inside the example app, not a system temp directory: the generated package asks for
    // `@omniface/client` by name, and resolving it the way Node actually would — walking up to the
    // app's node_modules — is part of what is being proven.
    const under = join(repoRoot, 'examples/tasks/.facet')
    await mkdir(under, { recursive: true })
    dir = await mkdtemp(join(under, 'sdk-test-'))
    await build(createTasksApp({ logSink: () => {} }), dir)
    sdkDir = join(dir, 'sdk')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('emits a package named after the app, on top of @omniface/client', async () => {
    const pkg = JSON.parse(await read('package.json')) as { name: string; dependencies: Record<string, string> }
    expect(pkg.name).toBe('tasks-sdk')
    expect(pkg.dependencies['@omniface/client']).toMatch(/^\^\d+\./)
  })

  it('declares the app types by name, with traits carried into the documentation', async () => {
    const dts = await read('index.d.ts')
    // `t.named('Task', …)` is one type shared by every method that returns a task, not an
    // anonymous shape repeated per operation.
    expect(dts).toContain('export interface Task {')
    expect(dts).toMatch(/complete\(input: TaskId\): Promise<Task>/)
    expect(dts).toMatch(/create\(input: TasksCreateInput\): Promise<Task>/)
    expect(dts).toContain('priority: "low" | "normal" | "high"')
    // A `pii` field that is also nullable keeps its note: the trait sits on a union branch.
    expect(dts).toContain('Personal data (pii)')
    // `internal` fields are gone before the manifest exists, so they cannot reach the SDK.
    expect(dts).not.toContain('internalScore')
    // The traits an SDK consumer has to act on are said in the method's own documentation.
    expect(dts).toContain('Irreversible.')
    expect(dts).toContain('Throws `FacetClientError` with code: `not_found`.')
  })

  it('type-checks, and the types reject what the app rejects', async () => {
    await writeFile(
      join(sdkDir, 'usage.ts'),
      [
        `import { createTasksClient, type Task } from './index.js'`,
        `const client = createTasksClient({ baseUrl: 'https://api.example.com', apiKey: 'k' })`,
        `export async function ok(): Promise<Task> {`,
        `  const page = await client.tasks.list({ limit: 10 })`,
        `  const all: Task[] = await client.tasks.list.autoPaginate()`,
        `  for await (const task of client.tasks.list.iterate()) void task.title`,
        `  void page.nextCursor`,
        `  void all`,
        `  return client.tasks.create({ title: 'Typed', priority: 'high' })`,
        `}`,
        `// @ts-expect-error — title is required`,
        `export const missingRequired = client.tasks.create({})`,
        `// @ts-expect-error — 'urgent' is not one of the priorities`,
        `export const badEnum = client.tasks.create({ title: 'x', priority: 'urgent' })`,
        `// @ts-expect-error — the op is get, not fetch`,
        `export const noSuchMethod = client.tasks.fetch({ id: 'task_1' })`,
        '',
      ].join('\n'),
    )
    await writeFile(
      join(sdkDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2023',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          // The generated package's own dependency, pointed at the workspace source.
          paths: { '@omniface/client': [join(repoRoot, 'packages/client/src/index.ts')] },
        },
        include: ['usage.ts', 'index.d.ts'],
      }),
    )
    // A `@ts-expect-error` that is not an error is itself an error, so the wrong types fail this
    // either way round: too loose and the expected errors vanish, too tight and `ok()` stops
    // compiling.
    const result = await run(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', sdkDir], { encoding: 'utf8' }).catch(
      (err: { stdout?: string; message: string }) => ({ stdout: err.stdout ?? err.message }),
    )
    expect(result.stdout.trim()).toBe('')
  }, 60_000)

  it('runs against a live app, with the same errors and pagination as every other facet', async () => {
    const app = createTasksApp({ logSink: () => {} })
    const server = createServer(app)
    const requests: Request[] = []
    const { createTasksClient } = (await import(pathToFileURL(join(sdkDir, 'index.mjs')).href)) as {
      createTasksClient: (o: Record<string, unknown>) => any
    }
    const client = createTasksClient({
      baseUrl: 'http://facet.test',
      apiKey: DEV_KEYS.admin,
      retries: 0,
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        const req = new Request(input, init)
        requests.push(req.clone())
        return server.fetch(req)
      },
    })

    const created = await client.tasks.create({ title: 'From the generated SDK' })
    expect(created).toMatchObject({ title: 'From the generated SDK', done: false })

    for (let i = 1; i <= 6; i++) await client.tasks.create({ title: `T${i}` })
    const collected = await client.tasks.list.autoPaginate({ limit: 2 })
    expect(collected).toHaveLength(7)
    const iterated: string[] = []
    for await (const task of client.tasks.list.iterate({ limit: 2 })) iterated.push(task.title)
    expect(iterated).toEqual(collected.map((t: { title: string }) => t.title))

    const err = await client.tasks.get({ id: 'task_missing' }).catch((e: unknown) => e as Error & { code: string })
    expect(err).toMatchObject({ name: 'FacetClientError', code: 'not_found', status: 404 })

    // The embedded manifest means no discovery round trip, and the package names itself in the
    // server's logs and audit rather than borrowing `@omniface/client`'s name.
    expect(requests.filter((r) => r.url.endsWith('/.well-known/facet.json'))).toHaveLength(0)
    expect(requests[0]!.headers.get('x-omniface-client')).toBe('tasks-sdk/0.1.0')
    expect(requests[0]!.headers.get('x-omniface-via')).toBe('sdk')
  })

  it('has exactly the ops the manifest has, named the way the manifest names them', async () => {
    const manifest = buildManifest(createTasksApp({ logSink: () => {} }))
    const dts = await read('index.d.ts')
    const expected = manifest.ops.filter((op) => op.sdk)

    for (const op of expected) {
      const name = op.sdk!.method[op.sdk!.method.length - 1]!
      // A method is either a signature or — when it is paginated — a reference to its own
      // callable interface. Anything else means the op did not reach the SDK.
      const declared = new RegExp(`^ +(?:readonly ${name}: \\w+Method|${name}\\(input\\??: \\w+\\): Promise<\\w+>)$`, 'm')
      expect(dts, `${op.id} is missing from the generated SDK`).toMatch(declared)
      if (op.rest) expect(dts).toContain(`\`${op.rest.method} ${op.rest.path}\``)
    }
    // And nothing extra: an SDK with a method the app does not have is the drift this repo exists
    // to prevent, and it would not be caught by checking each op in turn.
    // Only the client interface: the callable interfaces above it have `iterate` and
    // `autoPaginate` members that are sugar, not ops.
    const clientInterface = dts.slice(dts.indexOf('export interface TasksClient {'))
    const methods = [...clientInterface.matchAll(/^ +(?:readonly (\w+): \w+Method|(\w+)\(input\??: )/gm)].map((m) => m[1] ?? m[2])
    expect(methods.sort()).toEqual(expected.map((op) => op.sdk!.method[op.sdk!.method.length - 1]!).sort())
  })

  it('writes an OpenAPI document an outside generator can read', async () => {
    // What `examples/tasks/sdks/` feeds to Stainless, Speakeasy, Fern and the open-source
    // generators. None of those runs in CI, so the input they share is checked here instead.
    const doc = JSON.parse(await readFile(join(dir, 'openapi.json'), 'utf8')) as Record<string, any>
    const pointers = [...JSON.stringify(doc).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]!)
    expect(pointers.length).toBeGreaterThan(0)
    for (const pointer of pointers) {
      expect(pointer, 'every reference belongs in components').toMatch(/^#\/components\/schemas\//)
      expect(doc.components.schemas[pointer.slice('#/components/schemas/'.length)], `dangling ${pointer}`).toBeDefined()
    }
    // The named type is one model, not one per method that returns it.
    expect(doc.components.schemas.Task).toBeDefined()
    expect(doc.paths['/tasks']['post'].responses['201'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Task',
    })
    // And the extensions a generator needs to agree with the other facets.
    expect(doc.paths['/tasks'].get['x-omniface-pagination']).toMatchObject({ style: 'cursor', items: 'items' })
    expect(doc.paths['/tasks/{id}'].delete['x-omniface-traits']).toMatchObject({ destructive: true })
    expect(doc.paths['/tasks'].post['x-omniface-sdk']).toEqual({ method: ['tasks', 'create'] })
  })

  async function read(name: string): Promise<string> {
    return readFile(join(sdkDir, name), 'utf8')
  }
})
