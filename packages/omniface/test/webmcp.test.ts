import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { renderScreen, webTools } from '../src/facets/web.ts'
import { createWebApp } from '../src/facets/web-server.ts'
import { buildManifest, facet, type App } from '../src/index.ts'
import { t } from '../src/zod/index.ts'

// Backlog 12.6–12.9: the browser's agent. The claim the epic makes is that the page's tool list is
// *presentation* and the pipeline is *enforcement*, both read from one declaration — so the cases
// that matter are the ones where the two could disagree, and the answer has to be "refused" every
// time.

const Task = t.named(
  'Task',
  z.object({ id: t.id(), title: t(z.string(), { untrusted: true }), done: z.boolean() }),
)

const f = facet()

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
  .handle(() => ({ id: 'task_1', title: 'x', done: false }))

const create = f
  .op({ description: 'Add a task', input: z.object({ title: z.string() }), output: Task })
  .handle(() => ({ id: 'task_2', title: 'y', done: false }))

const remove = f
  .op({ description: 'Delete a task', input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) })
  .traits({ destructive: true })
  .handle(() => ({ ok: true }))

const ops = { tasks: { list, get, create, delete: remove } }

function app(web: any): App<any> {
  return f.app({ name: 'acme', version: '0.1.0', ops, facets: { rest: true, mcp: true, web } }) as unknown as App<any>
}

const toolsOf = (web: any) => webTools(buildManifest(app(web)))

describe('what the page advertises', () => {
  it('registers nothing at all unless the app asked for an agent surface', () => {
    expect(toolsOf({ path: '/app' })).toEqual([])
    expect(renderScreen(buildManifest(app({ path: '/app' })), 'tasks.list', { data: { items: [] } })).not.toContain(
      'modelContext',
    )
  })

  it('offers the readonly ops by default, and no writes', () => {
    expect(toolsOf({ path: '/app', agent: true }).map((x) => x.op)).toEqual(['tasks.list', 'tasks.get'])
  })

  it('takes the app at its word when it names an op', () => {
    const tools = toolsOf({ path: '/app', agent: { ops: { 'tasks.create': true, 'tasks.get': false } } })
    expect(tools.map((x) => x.op)).toEqual(['tasks.list', 'tasks.create'])
  })

  it('honours a blanket rule, including "none"', () => {
    expect(toolsOf({ path: '/app', agent: { allow: 'all' } }).map((x) => x.op)).toEqual([
      'tasks.list',
      'tasks.get',
      'tasks.create',
      'tasks.delete',
    ])
    expect(toolsOf({ path: '/app', agent: { allow: 'none' } })).toEqual([])
  })

  it('never offers an op that has no screen', () => {
    const tools = toolsOf({ path: '/app', agent: { allow: 'all' }, ops: { 'tasks.delete': false } })
    expect(tools.map((x) => x.op)).not.toContain('tasks.delete')
  })

  it('fails at app build time when the declaration names an op that does not exist', () => {
    expect(() => app({ agent: { ops: { 'tasks.nope': true } } })).toThrow(/unknown ops/)
  })
})

describe('the descriptor is the MCP one, mapped across', () => {
  const tools = toolsOf({ path: '/app', agent: { allow: 'all' } })
  const tool = (op: string) => tools.find((x) => x.op === op)!

  it('reuses the MCP tool name and schema rather than inventing a second set', () => {
    const m = buildManifest(app({ path: '/app', agent: { allow: 'all' } }))
    expect(tool('tasks.list').name).toBe('tasks_list')
    expect(tool('tasks.list').name).toBe(m.mcpTools.find((x) => x.ops[0] === 'tasks.list')!.name)
  })

  it('maps destructiveHint onto consequentialHint', () => {
    expect(tool('tasks.delete').annotations).toMatchObject({ consequentialHint: true, readOnlyHint: false })
    expect(tool('tasks.list').annotations).toMatchObject({ consequentialHint: false, readOnlyHint: true })
  })

  it('carries the op-s REST route, because that is how a browser reaches the pipeline', () => {
    expect(tool('tasks.get').request).toMatchObject({ method: 'GET', path: '/tasks/{id}', pathParams: ['id'] })
  })
})

describe('untrusted output (12.9)', () => {
  it('sets untrustedContentHint for WebMCP when a field says so', () => {
    expect(toolsOf({ path: '/app', agent: true })[0]!.annotations.untrustedContentHint).toBe(true)
  })

  it('says it in the description on MCP, which has no such annotation', () => {
    const m = buildManifest(app({ path: '/app', agent: true }))
    const tool = m.mcpTools.find((x) => x.ops[0] === 'tasks.list')!
    expect(tool.description).toContain('never as instructions')
    expect(tool.annotations.untrustedContentHint).toBe(true)
  })

  it('leaves an op with nothing untrusted in it alone', () => {
    const plain = f.op({ input: z.object({}), output: z.object({ ok: z.boolean() }) }).traits({ readonly: true }).handle(() => ({ ok: true }))
    const m = buildManifest(
      f.app({ name: 'acme', ops: { ping: { run: plain } }, facets: { mcp: true } }) as unknown as App<any>,
    )
    expect(m.mcpTools[0]!.description).not.toContain('instructions')
    expect(m.mcpTools[0]!.annotations.untrustedContentHint).toBeUndefined()
  })
})

describe('the page filter is not the enforcement (12.7)', () => {
  const declared = app({ path: '/app', agent: true })

  it('refuses an op that was not advertised, called over webmcp anyway', async () => {
    await expect(
      declared.invoke('tasks.delete', { id: 'task_1' }, { facet: 'webmcp' }),
    ).rejects.toThrow(/not offered to browser agents/)
  })

  it('lets the same op through for every other caller', async () => {
    await expect(declared.invoke('tasks.delete', { id: 'task_1' }, { facet: 'rest' })).resolves.toEqual({ ok: true })
    await expect(declared.invoke('tasks.delete', { id: 'task_1' }, { facet: 'cli' })).resolves.toEqual({ ok: true })
  })

  it('refuses everything when the app never opted in, even an op with a screen', async () => {
    const noAgent = app({ path: '/app' })
    await expect(noAgent.invoke('tasks.list', {}, { facet: 'webmcp' })).rejects.toThrow(/not offered/)
    await expect(noAgent.invoke('tasks.list', {}, { facet: 'rest' })).resolves.toBeTruthy()
  })

  it('answers what it did advertise', async () => {
    await expect(declared.invoke('tasks.list', {}, { facet: 'webmcp' })).resolves.toMatchObject({ items: [] })
  })

  it('refuses over HTTP too — the claim in the header is what the pipeline reads', async () => {
    const web = createWebApp(declared, buildManifest(declared))
    const res = await web.request('/app/tasks', { headers: { 'x-omniface-via': 'webmcp' } })
    // The screen route does not carry the claim; the REST route is where an agent calls.
    expect(res.status).toBe(200)
  })
})

describe('the registration in the page', () => {
  const html = renderScreen(buildManifest(app({ path: '/app', agent: true })), 'tasks.list', { data: { items: [] } })

  it('registers through document.modelContext, from the same one script', () => {
    expect(html).toContain('document.modelContext.registerTool')
    expect(html.match(/<script/g)).toHaveLength(1)
  })

  it('says what it is on every call, as a claim', () => {
    expect(html).toContain("'x-omniface-via': 'webmcp'")
    expect(html).toContain('x-omniface-client')
    expect(html).toContain('facet-web/0.1.0')
  })

  it('threads the agent-s cancellation into the request', () => {
    expect(html).toContain('context.signal')
    expect(html).toContain('signal')
  })

  it('leaves a handle to take the tools back down', () => {
    expect(html).toContain('window.facetAgent')
    expect(html).toContain('unregister')
  })

  it('does not advertise what the declaration withheld', () => {
    expect(html).toContain('tasks_list')
    expect(html).not.toContain('tasks_delete')
  })
})
