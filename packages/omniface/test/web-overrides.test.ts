import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { renderIndex, renderScreen } from '../src/facets/web.ts'
import { buildManifest, facet, type App } from '../src/index.ts'
import { t } from '../src/zod/index.ts'

// Backlog 12.4: the override ladder for web — step 2 and step 3 of docs/DX.md. Every case here is
// presentation over a screen the projection already derived; the ones that would *add* a screen,
// a field or an action are the cases that have to fail, which is the fence E12 is held to.

const f = facet()

const Task = t.named(
  'Task',
  z.object({ id: t.id(), title: z.string(), done: z.boolean(), createdAt: t.datetime() }),
)

const list = f
  .op({ input: z.object({ cursor: z.string().optional() }), output: z.object({ items: z.array(Task), nextCursor: z.string().nullable() }) })
  .traits({ readonly: true, paginated: true })
  .handle(() => ({ items: [], nextCursor: null }))

const get = f.op({ input: z.object({ id: z.string() }), output: Task }).traits({ readonly: true }).handle(() => null as any)

const create = f
  .op({ input: z.object({ title: z.string(), done: z.boolean().optional() }), output: Task })
  .handle(() => null as any)

const archive = f
  .op({ input: z.object({ id: z.string() }), output: Task })
  .traits({ destructive: true })
  .handle(() => null as any)

const ops = { tasks: { list, get, create, archive } }

function manifest(web: any) {
  return buildManifest(f.app({ name: 'acme', version: '0.1.0', ops, facets: { web } }) as unknown as App<any>)
}

const screen = (m: ReturnType<typeof manifest>, id: string) => m.ops.find((o) => o.id === id)!.web!

const row = { id: 'task_1', title: 'Water the plants', done: false, createdAt: '2026-09-18T10:00:00.000Z' }

describe('labels', () => {
  it('renames a screen and its fields without touching the op', () => {
    const m = manifest({ ops: { 'tasks.list': { title: 'Everything', labels: { title: 'What', done: 'Finished?' } } } })
    expect(screen(m, 'tasks.list').title).toBe('Everything')
    const html = renderScreen(m, 'tasks.list', { data: { items: [row] } })
    expect(html).toContain('<th scope="col" data-field="title">What</th>')
    expect(html).toContain('<th scope="col" data-field="done">Finished?</th>')
    expect(html).not.toContain('>Title</th>')
  })

  it('labels a form control too, and still validates against the real field name', () => {
    const m = manifest({ ops: { 'tasks.create': { labels: { title: 'Headline' } } } })
    const html = renderScreen(m, 'tasks.create')
    expect(html).toContain('Headline')
    expect(html).toContain('name="title"')
  })
})

describe('which fields a screen shows', () => {
  it('takes the columns an app names, in the order it names them', () => {
    const m = manifest({ ops: { 'tasks.list': { fields: ['title', 'id'] } } })
    expect(screen(m, 'tasks.list').fields).toEqual(['title', 'id'])
    const html = renderScreen(m, 'tasks.list', { data: { items: [row] } })
    expect(html.indexOf('data-field="title">Title</th>')).toBeLessThan(html.indexOf('data-field="id">Id</th>'))
    expect(html).not.toContain('Created at')
  })

  it('narrows a detail and a form the same way', () => {
    const m = manifest({ ops: { 'tasks.get': { fields: ['title'] }, 'tasks.create': { fields: ['title'] } } })
    expect(renderScreen(m, 'tasks.get', { data: row })).not.toContain('Created at')
    expect(renderScreen(m, 'tasks.create')).not.toContain('name="done"')
  })
})

describe('ordering and hiding', () => {
  it('puts the nav in the order the app asked for', () => {
    const m = manifest({ ops: { 'tasks.create': { order: 1 }, 'tasks.list': { order: 2 } } })
    const html = renderIndex(m)
    expect(html.indexOf('href="/app/tasks/new"')).toBeLessThan(html.indexOf('href="/app/tasks"'))
  })

  it('takes a screen out of the nav without taking away its route', () => {
    const m = manifest({ ops: { 'tasks.create': { hidden: true } } })
    expect(renderIndex(m)).not.toContain('/app/tasks/new')
    expect(screen(m, 'tasks.create').path).toBe('/tasks/new')
    expect(renderScreen(m, 'tasks.create')).toContain('action="/app/tasks/new"')
  })
})

describe('which op an action calls', () => {
  it('replaces the derived action list with the ops the app named, in order', () => {
    const m = manifest({ ops: { 'tasks.get': { actions: ['tasks.archive'] } } })
    const html = renderScreen(m, 'tasks.get', { data: row, params: { id: 'task_1' } })
    expect(html).toContain('/app/tasks/task_1/archive')
    expect(html).not.toContain('/app/tasks/task_1/edit')
  })

  it('fails at app build time when an action names an op that does not exist', () => {
    expect(() => manifest({ ops: { 'tasks.get': { actions: ['tasks.nope'] } } })).toThrow(/unknown ops.*tasks.nope/s)
  })

  it('fails the same way for where a write lands, and allows `back`', () => {
    expect(() => manifest({ ops: { 'tasks.create': { then: 'tasks.nope' } } })).toThrow(/unknown ops/)
    expect(screen(manifest({ ops: { 'tasks.create': { then: 'back' } } }), 'tasks.create').then).toBe('back')
    expect(screen(manifest({ ops: { 'tasks.create': { then: 'tasks.get' } } }), 'tasks.create').then).toBe('tasks.get')
  })
})

describe('confirmations', () => {
  it('lets an app write the question', () => {
    const m = manifest({ ops: { 'tasks.archive': { confirm: 'Archive this task? It leaves the list.' } } })
    const html = renderScreen(m, 'tasks.archive', { params: { id: 'task_1' } })
    expect(html).toContain('data-confirm="Archive this task? It leaves the list."')
    expect(html).toContain('Archive this task? It leaves the list.')
  })

  it('lets an app add a question to an op that is not destructive', () => {
    const m = manifest({ ops: { 'tasks.create': { confirm: true } } })
    expect(screen(m, 'tasks.create').confirm).toBe(true)
    expect(renderScreen(m, 'tasks.create')).toContain('data-confirm')
  })

  it('lets an app take one away, and says so in the manifest so `omniface diff` sees it', () => {
    const m = manifest({ ops: { 'tasks.archive': { confirm: false } } })
    expect(screen(m, 'tasks.archive').confirm).toBe(false)
    expect(renderScreen(m, 'tasks.archive', { params: { id: 'task_1' } })).not.toContain('data-confirm')
  })
})

describe('the route', () => {
  it('takes a path an app writes, and reads its params back out of it', () => {
    const m = manifest({ ops: { 'tasks.get': { path: '/inbox/{id}' } } })
    expect(screen(m, 'tasks.get')).toMatchObject({ path: '/inbox/{id}', pathParams: ['id'] })
    expect(renderScreen(m, 'tasks.get', { data: row, params: { id: 'task_1' } })).toContain('acme')
  })
})
