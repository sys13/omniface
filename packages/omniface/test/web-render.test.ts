import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { renderIndex, renderScreen } from '../src/facets/web.ts'
import { buildManifest, facet, type App } from '../src/index.ts'
import { MASK, presentFields, presentValue, tableColumns } from '../src/presentation.ts'
import { t } from '../src/zod/index.ts'

// Backlog 12.2 (the renderer) and 12.3 (field traits on screen). The epic's fence is testable, so
// it is tested: a screen that is not a declared op cannot be rendered at all, and every rule about
// what a field looks like comes from `presentation.ts` — the same table the CLI's output reads.

const f = facet()

const Task = t.named(
  'Task',
  z.object({
    id: t.id(),
    title: z.string(),
    done: z.boolean(),
    priority: z.enum(['low', 'high']),
    apiSecret: t(z.string(), { sensitive: true }),
    ownerEmail: t(z.email(), { pii: true }),
    createdAt: t.datetime(),
    ledgerRef: t(z.string(), { internal: true }),
  }),
)

const list = f
  .op({
    description: 'Every task',
    input: z.object({ cursor: z.string().optional() }),
    output: z.object({ items: z.array(Task), nextCursor: z.string().nullable() }),
  })
  .traits({ readonly: true, paginated: true })
  .handle(() => ({ items: [], nextCursor: null }))

const get = f
  .op({ description: 'One task', input: z.object({ id: z.string() }), output: Task })
  .traits({ readonly: true })
  .handle(() => null as any)

const create = f
  .op({
    description: 'Add a task',
    input: z.object({
      title: z.string(),
      priority: z.enum(['low', 'high']).optional(),
      done: z.boolean().optional(),
      apiSecret: t(z.string(), { sensitive: true }).optional(),
      notes: t(z.string(), { deprecated: 'use title' }).optional(),
    }),
    output: Task,
  })
  .handle(() => null as any)

const remove = f
  .op({ description: 'Delete a task', input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) })
  .traits({ destructive: true })
  .handle(() => ({ ok: true }))

const app = f.app({
  name: 'acme',
  version: '0.1.0',
  description: 'A tiny task tracker',
  ops: { tasks: { list, get, create, delete: remove } },
  facets: { web: true },
}) as unknown as App<any>

const manifest = buildManifest(app)

const row = {
  id: 'task_1',
  title: 'Water the <b>plants</b>',
  done: false,
  priority: 'low',
  apiSecret: 'sk_live_9',
  ownerEmail: 'sam@example.com',
  createdAt: '2026-09-18T10:00:00.000Z',
}

describe('the renderer only renders declared ops', () => {
  it('refuses an op with no screen, and says what to do instead', () => {
    const noWeb = buildManifest(f.app({ name: 'acme', ops: { tasks: { get } } }) as unknown as App<any>)
    expect(() => renderScreen(noWeb, 'tasks.get')).toThrow(/no screen.*write your own app against the SDK/s)
  })

  it('has no way to name a screen that is not an op', () => {
    expect(() => renderScreen(manifest, 'dashboard')).toThrow(/no screen/)
  })
})

describe('the page itself', () => {
  const html = renderScreen(manifest, 'tasks.list', { data: { items: [row], nextCursor: null } })

  it('is one self-contained document: no framework, no build step, no dependency', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html.match(/<style/g)).toHaveLength(1)
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+stylesheet/)
  })

  it('navigates to the screens that need no id, and not to the ones that do', () => {
    expect(html).toContain('href="/app/tasks"')
    expect(html).toContain('href="/app/tasks/new"')
    expect(html).not.toContain('href="/app/tasks/%7Bid%7D"')
    expect(html).not.toContain('{id}')
  })

  it('escapes what the data says', () => {
    expect(html).toContain('Water the &lt;b&gt;plants&lt;/b&gt;')
    expect(html).not.toContain('<b>plants</b>')
  })
})

describe('a table comes from the row schema', () => {
  const html = renderScreen(manifest, 'tasks.list', { data: { items: [row], nextCursor: 'c2' } })

  it('shows the same columns the CLI would, with human labels', () => {
    expect(tableColumns((manifest.ops[0]!.output as any).properties.items.items, manifest.ops[0]!.output)).toEqual([
      'id',
      'title',
      'done',
      'priority',
      'apiSecret',
      'ownerEmail',
    ])
    expect(html).toContain('<th scope="col" data-field="ownerEmail">Owner email</th>')
  })

  it('links the first cell of a row to the detail screen', () => {
    expect(html).toContain('href="/app/tasks/task_1"')
  })

  it('offers the next page when the op is paginated and there is one', () => {
    expect(html).toContain('?cursor=c2')
    expect(renderScreen(manifest, 'tasks.list', { data: { items: [row], nextCursor: null } })).not.toContain('cursor=')
  })

  it('says so plainly when there is nothing', () => {
    expect(renderScreen(manifest, 'tasks.list', { data: { items: [] } })).toContain('Nothing here yet.')
  })
})

/**
 * What is left of 12.3 here, and why.
 *
 * *Which* fields reach a screen and *what* they say is now a generated case — `presentation` in
 * `@omniface/testing`, which reads the rendered HTML, asks `presentation.ts` what the op should
 * show, and diffs both against the REST payload for the same call. It runs against the shipped
 * example app, where the traits are the ones that actually ship. Asserting the same things again
 * against the fixture below would be a second copy of the rules, maintained separately from the
 * app it describes, which is the drift this project exists to stop.
 *
 * So this block keeps only the two things the generated case cannot see: the markup a value is
 * wrapped in (a mask is a mask *with a reveal*, a datetime is a `<time>` the island can rewrite),
 * and the pure-module contract that the CLI reads the same table.
 */
describe('how a value is wrapped (12.3)', () => {
  const detail = renderScreen(manifest, 'tasks.get', { data: row, params: { id: 'task_1' } })

  it('offers a sensitive value behind a deliberate reveal rather than only hiding it', () => {
    expect(detail).toContain(MASK)
    expect(detail).toContain('class="reveal"')
    // The mask is what is on screen; the value is only reachable by asking for it.
    expect(detail).not.toMatch(new RegExp(`>${'sk_live_9'}<`))
  })

  it('marks a datetime for the island to make relative', () => {
    expect(detail).toContain('<time datetime="2026-09-18T10:00:00.000Z">')
  })

  it('reads the same rules the CLI reads, rather than a second copy', () => {
    const fields = presentFields(manifest.ops.find((o) => o.id === 'tasks.get')!.output)
    expect(fields.map((x) => x.name)).not.toContain('ledgerRef')
    expect(fields.find((x) => x.name === 'apiSecret')).toMatchObject({ display: 'masked', sensitive: true })
    expect(fields.find((x) => x.name === 'createdAt')!.display).toBe('datetime')
    expect(presentValue('sk_live_9', { display: 'masked' })).toBe(MASK)
  })
})

describe('a form comes from the input schema', () => {
  const html = renderScreen(manifest, 'tasks.create')

  it('posts to its own screen, so it works with the script turned off', () => {
    expect(html).toContain('<form method="post" action="/app/tasks/new"')
  })

  it('picks a control per field, and marks what is required', () => {
    expect(html).toContain('<select id="f-priority" name="priority">')
    expect(html).toContain('<input id="f-done" name="done" type="checkbox"')
    expect(html).toContain('<input id="f-title" name="title" required type="text"')
    expect(html).toContain('type="password"')
  })

  it('marks a deprecated field rather than quietly dropping it', () => {
    expect(html).toContain('deprecated: use title')
  })

  it('carries a CSRF token when one is given, and nothing when it is not', () => {
    expect(renderScreen(manifest, 'tasks.create', { csrfToken: 'tok' })).toContain('name="_csrf" value="tok"')
    expect(html).not.toContain('_csrf')
  })

  it('gives back what the person typed, with the error against the field', () => {
    const again = renderScreen(manifest, 'tasks.create', {
      values: { title: 'Kept' },
      error: { title: 'Invalid input', fields: { title: 'Too short' } },
    })
    expect(again).toContain('value="Kept"')
    expect(again).toContain('Too short')
    expect(again).toContain('Invalid input')
  })

  it('drops the route param from the form — the URL already carries it', () => {
    const del = renderScreen(manifest, 'tasks.delete', { params: { id: 'task_1' } })
    expect(del).toContain('action="/app/tasks/task_1/delete"')
    expect(del).not.toContain('name="id"')
  })
})

describe('a destructive op asks first', () => {
  const html = renderScreen(manifest, 'tasks.delete', { params: { id: 'task_1' } })

  it('confirms, warns, and says so in the markup rather than only in script', () => {
    expect(html).toContain('data-confirm="Delete task? This cannot be undone."')
    expect(html).toContain('This cannot be undone.')
    expect(html).toContain('class="danger"')
  })

  it('leaves a non-destructive form alone', () => {
    expect(renderScreen(manifest, 'tasks.create')).not.toContain('data-confirm')
  })
})

describe('the index', () => {
  const html = renderIndex(manifest)

  it('lists the screens that need no id, and the app description', () => {
    expect(html).toContain('A tiny task tracker')
    expect(html).toContain('href="/app/tasks"')
    expect(html).toContain('href="/app/tasks/new"')
    expect(html).not.toContain('/app/tasks/%7Bid%7D')
  })

  it('follows the mount path the app chose', () => {
    const moved = buildManifest(
      f.app({ name: 'acme', ops: { tasks: { list, get } }, facets: { web: { path: '/console' } } }) as unknown as App<any>,
    )
    expect(renderIndex(moved)).toContain('href="/console/tasks"')
  })
})
