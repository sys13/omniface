import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { diffManifests } from '../src/diff.ts'
import { buildManifest, facet, type App } from '../src/index.ts'
import { inspectOp } from '../src/inspect.ts'
import { t } from '../src/zod/index.ts'

// Backlog 12.1: the web projection in the manifest. The epic's claim is that a web console is a
// *projection of declared ops*, like REST and the CLI are, rather than an application — so the
// test of it is that the screen falls out of traits and schemas with nothing new declared.

const f = facet()

const Task = t.named(
  'Task',
  z.object({
    id: t.id(),
    title: z.string(),
    ownerEmail: t(z.email(), { pii: true }),
    secretNote: t(z.string(), { internal: true }),
  }),
)

const list = f
  .op({ input: z.object({ cursor: z.string().optional() }), output: z.object({ items: z.array(Task), nextCursor: z.string().nullable() }) })
  .traits({ readonly: true, paginated: true })
  .handle(() => ({ items: [], nextCursor: null }))

const get = f.op({ input: z.object({ id: z.string() }), output: Task }).traits({ readonly: true }).handle(() => null as any)

const create = f.op({ input: z.object({ title: z.string() }), output: Task }).handle(() => null as any)

const update = f.op({ input: z.object({ id: z.string(), title: z.string() }), output: Task }).handle(() => null as any)

const remove = f
  .op({ input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) })
  .traits({ destructive: true })
  .handle(() => ({ ok: true }))

const complete = f
  .op({ input: z.object({ id: z.string() }), output: Task })
  .traits({ idempotent: true })
  .handle(() => null as any)

const ops = { tasks: { list, get, create, update, delete: remove, complete } }

function app(facets: any = { web: true }): App<any> {
  return f.app({ name: 'acme', version: '0.1.0', ops, facets }) as unknown as App<any>
}

const screens = (a: App<any> = app()) => Object.fromEntries(buildManifest(a).ops.map((o) => [o.id, o.web]))

describe('the web facet is opt-in', () => {
  it('is off when facets is omitted, unlike the four MVP facets', () => {
    const m = buildManifest(f.app({ name: 'acme', ops }) as unknown as App<any>)
    expect(m.facets).toMatchObject({ rest: true, mcp: true, cli: true, sdk: true, web: false })
    expect(m.web).toBeNull()
    expect(m.ops.every((o) => o.web === null)).toBe(true)
  })

  it('mounts at /app by default and takes a path', () => {
    expect(buildManifest(app()).web).toEqual({ path: '/app', agent: false, agentCredential: 'session' })
    expect(buildManifest(app({ web: { path: '/console' } })).web).toEqual({
      path: '/console',
      agent: false,
      agentCredential: 'session',
    })
  })

  it('drops an op the app opts out of', () => {
    expect(screens(app({ web: { ops: { 'tasks.delete': false } } }))['tasks.delete']).toBeNull()
  })

  it('refuses an override naming an op that does not exist', () => {
    expect(() => f.app({ name: 'acme', ops, facets: { web: { ops: { 'tasks.nope': false } } } as any })).toThrow(
      /unknown ops/,
    )
  })
})

describe('the screen kind is derived, never declared', () => {
  const s = screens()

  it('makes a paginated read a table over the row fields', () => {
    expect(s['tasks.list']).toMatchObject({ kind: 'table', path: '/tasks', pathParams: [], title: 'Tasks' })
    expect(s['tasks.list']!.fields).toEqual(['id', 'title', 'ownerEmail'])
  })

  it('makes a single read a detail at the id route', () => {
    expect(s['tasks.get']).toMatchObject({ kind: 'detail', path: '/tasks/{id}', pathParams: ['id'], title: 'Task' })
  })

  it('makes a write a form, over the input minus what the route carries', () => {
    expect(s['tasks.create']).toMatchObject({ kind: 'form', path: '/tasks/new', title: 'New task', fields: ['title'] })
    expect(s['tasks.update']).toMatchObject({ kind: 'form', path: '/tasks/{id}/edit', title: 'Edit task', fields: ['title'] })
  })

  it('routes an op that is not CRUD under its subject', () => {
    expect(s['tasks.complete']).toMatchObject({ kind: 'form', path: '/tasks/{id}/complete', title: 'Complete task' })
  })

  it('labels an op with no subject in its route by the action alone', () => {
    const whoami = f.op({ input: z.object({}), output: z.object({ id: z.string() }) }).traits({ readonly: true }).handle(() => ({ id: 'a' }))
    const m = buildManifest(f.app({ name: 'acme', ops: { auth: { whoami } }, facets: { web: true } }) as unknown as App<any>)
    expect(m.ops[0]!.web).toMatchObject({ kind: 'detail', path: '/auth/whoami', title: 'Whoami' })
  })

  it('adds a confirmation for destructive, and only for destructive', () => {
    expect(s['tasks.delete']).toMatchObject({ path: '/tasks/{id}/delete', title: 'Delete task', confirm: true })
    expect(s['tasks.create']!.confirm).toBe(false)
    expect(s['tasks.complete']!.confirm).toBe(false)
  })

  it('never puts an internal field on a screen', () => {
    for (const screen of Object.values(screens())) expect(screen!.fields).not.toContain('secretNote')
  })
})

describe('an internal op has no screen at all', () => {
  it('is absent from the manifest, so it cannot be rendered', () => {
    const hidden = f.op({ input: z.object({}), output: z.object({}) }).traits({ internal: true }).handle(() => ({}))
    const m = buildManifest(f.app({ name: 'acme', ops: { ...ops, secret: { run: hidden } }, facets: { web: true } }) as unknown as App<any>)
    expect(m.ops.find((o) => o.id === 'secret.run')).toBeUndefined()
  })
})

describe('the rest of the toolchain sees the projection without being taught', () => {
  it('omniface inspect reports the screen and a URL you can open', () => {
    const a = app()
    expect(inspectOp(a, 'tasks.get').web).toMatchObject({
      url: 'http://localhost:3000/app/tasks/string',
      screen: { kind: 'detail' },
    })
    expect(inspectOp(a, 'tasks.list').web!.url).toBe('http://localhost:3000/app/tasks')
  })

  it('omniface diff reports turning the facet on, and moving it', () => {
    const off = buildManifest(app({ rest: true }))
    const on = buildManifest(app())
    const added = diffManifests(off, on).changes.filter((c) => c.rule === 'facet-added')
    expect(added.map((c) => c.facets.join())).toContain('web')
    const moved = diffManifests(on, buildManifest(app({ web: { path: '/console' } }))).changes
    expect(moved.find((c) => c.rule === 'web-mount-moved')?.level).toBe('breaking')
  })

  it('reports a screen that became a different page as breaking', () => {
    const before = buildManifest(app())
    const loud = f.op({ input: z.object({ id: z.string() }), output: Task }).handle(() => null as any)
    const after = buildManifest(
      f.app({ name: 'acme', version: '0.1.0', ops: { tasks: { ...ops.tasks, get: loud } }, facets: { web: true } }) as unknown as App<any>,
    )
    const changes = diffManifests(before, after).changes.filter((c) => c.op === 'tasks.get' && c.facets.includes('web'))
    expect(changes.map((c) => c.rule)).toContain('web-screen-kind-changed')
    expect(changes.find((c) => c.rule === 'web-screen-kind-changed')!.level).toBe('breaking')
  })

  it('reports a newly destructive op as breaking on the web too, like it does on the CLI', () => {
    const before = buildManifest(app())
    const dangerous = f
      .op({ input: z.object({ id: z.string() }), output: Task })
      .traits({ destructive: true })
      .handle(() => null as any)
    const after = buildManifest(
      f.app({ name: 'acme', version: '0.1.0', ops: { tasks: { ...ops.tasks, complete: dangerous } }, facets: { web: true } }) as unknown as App<any>,
    )
    const change = diffManifests(before, after).changes.find((c) => c.rule === 'web-confirm-added')
    expect(change).toMatchObject({ op: 'tasks.complete', level: 'breaking' })
  })
})
