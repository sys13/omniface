import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createWebApp, WEB_CSP } from '../src/facets/web-server.ts'
import { buildManifest, facet, type App } from '../src/index.ts'
import { createServer } from '../src/server.ts'
import { t } from '../src/zod/index.ts'

// Backlog 12.5: the screens, mounted. The claims worth testing are the ones a console can get
// wrong in a way an API cannot: ambient cookie authority (so: CSRF), a page that may run script
// (so: its own CSP), and a write that re-runs on reload (so: redirect, not render).

const Task = t.named('Task', z.object({ id: t.id(), title: z.string(), done: z.boolean() }))

type Row = { id: string; title: string; done: boolean }

let store: Row[] = []
let seen: { op: string; facet: string }[] = []

const f = facet({
  plugins: [
    {
      name: 'watcher',
      hooks: { authenticate: (inv: any) => void seen.push({ op: inv.op.id, facet: inv.facet }) },
    } as any,
  ],
})

const list = f
  .op({
    description: 'Every task',
    input: z.object({ cursor: z.string().optional() }),
    output: z.object({ items: z.array(Task), nextCursor: z.string().nullable() }),
  })
  .traits({ readonly: true, paginated: true })
  .handle(() => ({ items: store, nextCursor: null }))

const get = f
  .op({ input: z.object({ id: z.string() }), output: Task })
  .traits({ readonly: true })
  .handle(({ input }: any) => {
    const row = store.find((r) => r.id === input.id)
    if (!row) throw new Error('nope')
    return row
  })

const create = f
  .op({ input: z.object({ title: z.string().min(3), done: z.boolean().optional() }), output: Task })
  .handle(({ input }: any) => {
    const row = { id: `task_${store.length + 1}`, title: input.title, done: input.done ?? false }
    store.push(row)
    return row
  })

const remove = f
  .op({ input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) })
  .traits({ destructive: true })
  .handle(({ input }: any) => {
    store = store.filter((r) => r.id !== input.id)
    return { ok: true }
  })

const hidden = f
  .op({ input: z.object({}), output: z.object({ ok: z.boolean() }) })
  .traits({ internal: true })
  .handle(() => ({ ok: true }))

const app = f.app({
  name: 'acme',
  version: '0.1.0',
  ops: { tasks: { list, get, create, delete: remove, secret: hidden } },
  facets: { rest: true, web: { path: '/app', ops: { 'tasks.create': { then: 'tasks.get' } } } },
}) as unknown as App<any>

const manifest = buildManifest(app)
const web = () => createWebApp(app, manifest, { newToken: () => 'tok'.repeat(8) })

const TOKEN = 'tok'.repeat(8)

beforeEach(() => {
  store = [{ id: 'task_1', title: 'Water the plants', done: false }]
  seen = []
})

const getPage = (path: string, headers: Record<string, string> = {}) =>
  web().request(path, { headers })

const post = (path: string, body: Record<string, string>, headers: Record<string, string> = { cookie: `facet_csrf=${TOKEN}` }) =>
  web().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  })

describe('the routes are the projection', () => {
  it('puts a static route ahead of the one with a parameter', async () => {
    // Without the ordering, /app/tasks/new is answered by the detail screen with an id of "new".
    const html = await (await getPage('/app/tasks/new')).text()
    expect(html).toContain('<form method="post" action="/app/tasks/new"')
  })

  it('serves the index and every screen under the mount path', async () => {
    expect((await getPage('/app')).status).toBe(200)
    expect((await getPage('/app/tasks')).status).toBe(200)
    expect((await getPage('/app/tasks/task_1')).status).toBe(200)
    expect((await getPage('/app/tasks/new')).status).toBe(200)
  })

  it('mounts nothing for an op with no screen, and nothing outside the mount path', async () => {
    // `tasks.secret` is `internal`: it is not in the manifest at all, so there is no route to it.
    expect((await getPage('/app/secret')).status).toBe(404)
    expect((await getPage('/app/tasks/task_1/secret')).status).toBe(404)
    expect((await getPage('/tasks')).status).toBe(404)
  })

  it('answers a table with the op, through the same pipeline every other facet uses', async () => {
    const html = await (await getPage('/app/tasks')).text()
    expect(html).toContain('Water the plants')
    expect(seen).toEqual([{ op: 'tasks.list', facet: 'web' }])
  })

  it('shows a form without running anything', async () => {
    await getPage('/app/tasks/new')
    expect(seen).toEqual([])
  })

  it('renders an error in the one error model when the op refuses', async () => {
    const res = await getPage('/app/tasks/nope')
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('Internal')
  })
})

describe('a page gets its own security posture', () => {
  it('sends the page CSP, not the API one', async () => {
    const res = await getPage('/app/tasks')
    expect(res.headers.get('content-security-policy')).toBe(WEB_CSP)
    expect(WEB_CSP).toContain("form-action 'self'")
    expect(WEB_CSP).toContain("frame-ancestors 'none'")
  })

  it('leaves the REST facet under the API posture it already had', async () => {
    const server = createServer(app)
    const rest = await server.request('/tasks')
    expect(rest.headers.get('content-security-policy')).not.toBe(WEB_CSP)
    const page = await server.request('/app/tasks')
    expect(page.headers.get('content-security-policy')).toBe(WEB_CSP)
  })
})

describe('CSRF on every write', () => {
  it('sets a token on a GET and puts the same one in the form', async () => {
    const res = await getPage('/app/tasks/new')
    expect(res.headers.get('set-cookie')).toContain(`facet_csrf=${TOKEN}`)
    expect(res.headers.get('set-cookie')).toContain('SameSite=Lax')
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
    expect(await res.text()).toContain(`name="_csrf" value="${TOKEN}"`)
  })

  it('refuses a write whose token does not match the cookie', async () => {
    const res = await post('/app/tasks/new', { title: 'From elsewhere', _csrf: 'wrong' })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('Expired form')
    expect(store).toHaveLength(1)
    expect(seen).toEqual([])
  })

  it('refuses a write with no token at all', async () => {
    expect((await post('/app/tasks/new', { title: 'No token' }, {})).status).toBe(403)
    expect(store).toHaveLength(1)
  })

  it('accepts the form the person was actually looking at', async () => {
    const res = await post('/app/tasks/new', { title: 'Renew the domain', _csrf: TOKEN })
    expect(res.status).toBe(303)
    expect(store.map((r) => r.title)).toContain('Renew the domain')
  })
})

describe('a write lands somewhere', () => {
  it('redirects rather than rendering, so a reload does not run it twice', async () => {
    const res = await post('/app/tasks/new', { title: 'Renew the domain', _csrf: TOKEN })
    expect(res.status).toBe(303)
    // `then: 'tasks.get'`, with the id the op just returned.
    expect(res.headers.get('location')).toBe('/app/tasks/task_2')
  })

  it('falls back to the resource table when there is nowhere named', async () => {
    const res = await post('/app/tasks/task_1/delete', { _csrf: TOKEN })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/app/tasks')
    expect(store).toHaveLength(0)
  })
})

describe('what the form sends is what the op gets', () => {
  it('coerces a checkbox to a boolean, absent meaning false', async () => {
    await post('/app/tasks/new', { title: 'With a box', done: 'true', _csrf: TOKEN })
    expect(store.at(-1)).toMatchObject({ done: true })
    await post('/app/tasks/new', { title: 'Without a box', _csrf: TOKEN })
    expect(store.at(-1)).toMatchObject({ done: false })
  })

  it('takes the route param from the URL, not from the body', async () => {
    const res = await post('/app/tasks/task_1/delete', { id: 'task_999', _csrf: TOKEN })
    expect(res.status).toBe(303)
    expect(store).toHaveLength(0)
  })

  it('re-renders the form with the values and the error against the field', async () => {
    const res = await post('/app/tasks/new', { title: 'ab', _csrf: TOKEN })
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('value="ab"')
    expect(html).toContain('Invalid input')
    expect(html).toMatch(/Too small|at least 3/i)
    expect(store).toHaveLength(1)
  })
})

// #83: the mount order in `createServer` only decides anything when a screen route and a REST
// route are the same route. With the default mount the two sets are disjoint, so this app moves
// the screens to the root: `tasks.list` takes GET /tasks, which is where REST answers too.
const rootApp = f.app({
  name: 'acme',
  version: '0.1.0',
  ops: { tasks: { list, get, create, delete: remove, secret: hidden } },
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
