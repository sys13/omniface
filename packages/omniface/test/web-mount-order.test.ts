import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineFacet, facet, registerFacet, type App } from '../src/index.ts'
import { createServer } from '../src/server.ts'
import { t } from '../src/zod/index.ts'

// The mount order in `createServer` only decides anything when a screen route and a REST route
// are the same route. With the default mount the two sets are disjoint, so every app here moves
// the screens to the root: `tasks.list` takes GET /tasks, which is where REST answers too.
//
// These apps have their own ops and their own store rather than borrowing web-serve.test.ts's. A
// test there that writes to its store would otherwise change what these read, and the failure
// would look like a bug in mounting rather than in the fixture.

const Task = t.named('Task', z.object({ id: t.id(), title: z.string(), done: z.boolean() }))

type Row = { id: string; title: string; done: boolean }

let store: Row[] = []

beforeEach(() => {
  store = [{ id: 'task_1', title: 'Water the plants', done: false }]
})

const f = facet()

const ops = {
  tasks: {
    list: f
      .op({
        description: 'Every task',
        input: z.object({ cursor: z.string().optional() }),
        output: z.object({ items: z.array(Task), nextCursor: z.string().nullable() }),
      })
      .traits({ readonly: true, paginated: true })
      .handle(() => ({ items: store, nextCursor: null })),
    get: f
      .op({ input: z.object({ id: z.string() }), output: Task })
      .traits({ readonly: true })
      .handle(({ input }: any) => {
        const row = store.find((r) => r.id === input.id)
        if (!row) throw new Error('nope')
        return row
      }),
    create: f
      .op({ input: z.object({ title: z.string().min(3), done: z.boolean().optional() }), output: Task })
      .handle(({ input }: any) => {
        const row = { id: `task_${store.length + 1}`, title: input.title, done: input.done ?? false }
        store.push(row)
        return row
      }),
    delete: f
      .op({ input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) })
      .traits({ destructive: true })
      .handle(({ input }: any) => {
        store = store.filter((r) => r.id !== input.id)
        return { ok: true }
      }),
    secret: f
      .op({ input: z.object({}), output: z.object({ ok: z.boolean() }) })
      .traits({ internal: true })
      .handle(() => ({ ok: true })),
  },
}

const rootApp = f.app({
  name: 'acme',
  version: '0.1.0',
  ops,
  facets: { rest: true, web: { path: '' } },
}) as unknown as App<any>

describe('a screen and a REST route on the same path', () => {
  it('gives the route to the screen', async () => {
    const res = await createServer(rootApp).request('/tasks', { headers: { accept: 'text/html' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<h2 class="screen">')
    expect(html).toContain('Water the plants')
  })

  it('leaves REST answering where nothing collides', async () => {
    // POST /tasks is `tasks.create`; the screen for it is GET/POST /tasks/new. Without this the
    // first assertion would also pass if the web facet had swallowed every route.
    const res = await createServer(rootApp).request('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'From the API' }),
    })
    expect(res.headers.get('content-type')).toContain('json')
    expect(res.status).toBeLessThan(300)
    expect(store.map((r) => r.title)).toContain('From the API')
  })
})

// The three shipped facets all set a `mountOrder`, so the fixture above cannot see what an unset
// one does. This one registers a served facet that does not set it, claiming a route the web
// facet already claims. Unset sorts last, so the screen still wins; if unset read as `0` this
// facet would mount ahead of `web` (1) and `rest` (2) and answer instead.
// The route docs/FACETS.md documents for an out-of-tree facet's config key.
declare module '../src/index.ts' {
  interface FacetsConfig {
    latecomer?: boolean
  }
}

const latecomer = defineFacet<true, null>({
  name: 'latecomer',
  defaultOn: false,
  normalize: (value) => (value === true ? true : null),
  project: () => null,
  serve: {
    // No `mountOrder`. That is the point of the fixture.
    create: () => {
      const hono = new Hono()
      hono.all('/tasks', (c) => c.text('latecomer'))
      hono.all('/latecomer', (c) => c.text('latecomer'))
      return hono
    },
  },
})
registerFacet(latecomer)

const lateApp = f.app({
  name: 'acme',
  version: '0.1.0',
  ops,
  facets: { rest: true, web: { path: '' }, latecomer: true },
}) as unknown as App<any>

describe('a served facet that does not set a mountOrder', () => {
  it('mounts after every facet that does', async () => {
    const res = await createServer(lateApp).request('/tasks', { headers: { accept: 'text/html' } })
    expect(await res.text()).not.toBe('latecomer')
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('is mounted, so the assertion above is about order and not about absence', async () => {
    const res = await createServer(lateApp).request('/latecomer')
    expect(await res.text()).toBe('latecomer')
  })
})
