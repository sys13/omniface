import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildManifest, errors, facet, inspectOp, toJSONSchema, type FacetsConfig, type OpIds } from '../src/index.ts'
import { buildOpenApi } from '../src/facets/openapi.ts'
import { redact, stripInternal } from '../src/jsonschema.ts'
import { scopes } from '../src/plugins/index.ts'
import { t } from '../src/zod/index.ts'
import { cliOf, cliSettings, mcpOf, mcpTools, restOf, sdkOf } from 'omniface'

const Note = t.named('Note', z.object({ id: t.id(), body: z.string(), email: t(z.email(), { pii: true }).optional(), secret: t(z.string(), { internal: true }) }))

function notesOps() {
  const f = facet()
  const note = { id: 'n1', body: 'hi', secret: 's' }
  const ops = {
    notes: {
      create: f.op({ input: Note.pick({ body: true }), output: Note }).handle(() => note),
      list: f.op({ input: t.pageInput(), output: t.page(Note) }).traits({ readonly: true, paginated: true }).handle(() => ({ items: [note], nextCursor: null })),
      get: f.op({ input: Note.pick({ id: true }), output: Note }).traits({ readonly: true }).handle(() => note),
      update: f.op({ input: Note.pick({ id: true, body: true }), output: Note }).traits({ idempotent: true }).handle(() => note),
      archive: f.op({ input: Note.pick({ id: true }), output: Note }).handle(() => note),
      delete: f.op({ input: Note.pick({ id: true }), output: z.object({ ok: z.boolean() }) }).traits({ destructive: true }).handle(() => ({ ok: true })),
      search: f.op({ input: z.object({ q: z.string() }), output: z.object({ ids: z.array(z.string()) }) }).traits({ readonly: true }).handle(() => ({ ids: [] })),
      reindex: f.op({ output: z.object({ ok: z.boolean() }) }).traits({ internal: true }).handle(() => ({ ok: true })),
    },
  }
  return { f, ops }
}

type NoteFacets = FacetsConfig<OpIds<ReturnType<typeof notesOps>['ops']>>

function notesApp(facets?: NoteFacets) {
  const { f, ops } = notesOps()
  return f.app({ name: 'notes', ops, facets })
}

describe('conventions', () => {
  const m = buildManifest(notesApp())
  const rest = Object.fromEntries(m.ops.map((o) => [o.id, restOf(o) && `${restOf(o)!.method} ${restOf(o)!.path}`]))

  it('derives REST bindings from op names and inputs', () => {
    expect(rest).toEqual({
      'notes.create': 'POST /notes',
      'notes.list': 'GET /notes',
      'notes.get': 'GET /notes/{id}',
      'notes.update': 'PATCH /notes/{id}',
      'notes.archive': 'POST /notes/{id}/archive',
      'notes.delete': 'DELETE /notes/{id}',
      'notes.search': 'GET /notes/search',
    })
  })

  it('hides internal ops from every facet', () => {
    expect(m.ops.map((o) => o.id)).not.toContain('notes.reindex')
    expect(mcpTools(m).map((t) => t.name)).not.toContain('notes_reindex')
  })

  it('names CLI commands and MCP tools by convention, with a positional id', () => {
    const get = m.ops.find((o) => o.id === 'notes.get')!
    expect(cliOf(get)).toEqual({ command: ['notes', 'get'], args: ['id'] })
    expect(mcpOf(get)).toEqual({ tool: 'notes_get', description: 'notes.get' })
  })

  it('turns traits into MCP annotations', () => {
    const tool = (name: string) => mcpTools(m).find((t) => t.name === name)!.annotations
    expect(tool('notes_get')).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
    expect(tool('notes_delete')).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(tool('notes_update')).toMatchObject({ idempotentHint: true })
  })

  it('publishes schemas without internal fields', () => {
    const get = m.ops.find((o) => o.id === 'notes.get')!
    expect(Object.keys(get.output.properties)).toEqual(['id', 'body', 'email'])
    expect(get.output.required).not.toContain('secret')
  })
})

describe('overrides', () => {
  it('applies typed per-facet overrides', () => {
    const m = buildManifest(
      notesApp({
        rest: { ops: { 'notes.archive': { method: 'PUT', path: '/archive/{id}' }, 'notes.search': false } },
        cli: { binName: 'nt', ops: { 'notes.search': { command: 'find', args: ['q'] } } },
        mcp: { ops: { 'notes.get': { name: 'read_note', description: 'Read one note' } } },
      }),
    )
    const op = (id: string) => m.ops.find((o) => o.id === id)!
    expect(restOf(op('notes.archive'))).toMatchObject({ method: 'PUT', path: '/archive/{id}', pathParams: ['id'] })
    expect(restOf(op('notes.search'))).toBeNull()
    expect(cliOf(op('notes.search'))).toEqual({ command: ['find'], args: ['q'] })
    expect(cliSettings(m)).toEqual({ binName: 'nt' })
    expect(mcpTools(m).find((t) => t.name === 'read_note')!.description).toBe('Read one note')
  })

  it('groups ops into one intent-level MCP tool, and stops listing them individually', () => {
    const m = buildManifest(notesApp({ mcp: { tools: { manage_notes: { description: 'Work with notes', ops: ['notes.create', 'notes.update', 'notes.get'] } } } }))
    const names = mcpTools(m).map((t) => t.name)
    expect(names).toContain('manage_notes')
    expect(names).not.toContain('notes_create')
    const group = mcpTools(m).find((t) => t.name === 'manage_notes')!
    expect(group.inputSchema.properties.action.enum).toEqual(['create', 'update', 'get'])
    expect(group.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(group.description).toContain('Actions:')
  })

  it('omitting a facet turns it off; facets: undefined turns on every facet but web', () => {
    const m = buildManifest(notesApp({ rest: true }))
    // A facet that is off has no key at all: the record of what is on replaces the booleans.
    expect(Object.keys(m.facets)).toEqual(['rest'])
    expect(mcpTools(m)).toEqual([])
    // `web` stays off: it is opt-in even under `facets: undefined` (app.ts, WebConfig).
    expect(Object.keys(buildManifest(notesApp()).facets)).toEqual(['rest', 'mcp', 'cli', 'sdk', 'events'])
  })

  it('rejects overrides on unknown ops at runtime (and at compile time)', () => {
    const { f, ops } = notesOps()
    expect(() =>
      f.app({
        name: 'notes',
        ops,
        // @ts-expect-error — 'notes.nope' is not an op id
        facets: { mcp: { ops: { 'notes.nope': { description: 'x' } } } },
      }),
    ).toThrow(/unknown ops.*notes\.nope/)
  })
})

describe('gates', () => {
  it('refuses to start when ops declare scopes but nothing enforces them', () => {
    const f = facet()
    expect(() =>
      f.app({ name: 'x', ops: { a: f.op({ output: z.object({}) }).traits({ scope: 'a:read' }).handle(() => ({})) } }),
    ).toThrow(/no plugin enforces them/)
    const g = facet({ plugins: [scopes()] })
    expect(() => g.app({ name: 'x', ops: { a: g.op({ output: z.object({}) }).traits({ scope: 'a:read' }).handle(() => ({})) } })).not.toThrow()
  })

  it('checks plugin prerequisites and order', () => {
    const needsAuth = { name: 'needsAuth', requires: ['auth'] }
    expect(() => facet({ plugins: [needsAuth] })).toThrow(/requires "auth"/)
  })

  it('rejects op id collisions between the app and plugins', () => {
    const plugin = { name: 'p', ops: { notes: { get: facet().op({ output: z.object({}) }).handle(() => ({})) } } }
    const f = facet({ plugins: [plugin] })
    expect(() => f.app({ name: 'x', ops: { notes: { get: f.op({ output: z.object({}) }).handle(() => ({})) } } })).toThrow(/collides/)
  })
})

describe('pipeline', () => {
  it('validates output against the schema and reports a clear internal error', async () => {
    const f = facet()
    const app = f.app({ name: 'x', ops: { bad: f.op({ output: z.object({ n: z.number() }) }).handle(() => ({ n: 'nope' }) as any) } })
    await expect(app.invoke('bad', {}, { facet: 'internal' })).rejects.toMatchObject({ code: 'internal', message: /does not match its schema/ })
  })

  it('turns unknown handler errors into internal, and keeps FacetErrors', async () => {
    const f = facet()
    const app = f.app({
      name: 'x',
      ops: {
        boom: f.op({ output: z.object({}) }).handle(() => {
          throw new Error('secret db detail')
        }),
        gone: f.op({ output: z.object({}) }).handle(() => {
          throw errors.notFound('nope')
        }),
      },
    })
    await expect(app.invoke('boom', {}, { facet: 'rest' })).rejects.toMatchObject({ code: 'internal', message: 'Internal error' })
    await expect(app.invoke('gone', {}, { facet: 'rest' })).rejects.toMatchObject({ code: 'not_found', message: 'nope' })
  })

  it('runs hooks in stage order regardless of plugin order, and wraps outermost-first', async () => {
    const seen: string[] = []
    const f = facet({
      plugins: [
        { name: 'late', hooks: { authorize: () => void seen.push('authorize') }, wrap: async (_i, next) => (seen.push('wrap:late'), next()) },
        { name: 'early', hooks: { authenticate: () => void seen.push('authenticate'), after: () => void seen.push('after') } },
      ],
    })
    const app = f.app({ name: 'x', ops: { a: f.op({ output: z.object({}) }).handle(() => (seen.push('handle'), {})) } })
    await app.invoke('a', {}, { facet: 'internal' })
    expect(seen).toEqual(['wrap:late', 'authenticate', 'authorize', 'handle', 'after'])
  })

  it('lets a hook respond without running the handler', async () => {
    let ran = false
    const f = facet({ plugins: [{ name: 'cache', hooks: { idempotency: (inv) => inv.respond({ cached: true }) } }] })
    const app = f.app({ name: 'x', ops: { a: f.op({ output: z.object({ cached: z.boolean() }) }).handle(() => ((ran = true), { cached: false })) } })
    expect(await app.invoke('a', {}, { facet: 'internal' })).toEqual({ cached: true })
    expect(ran).toBe(false)
  })
})

describe('schema layer', () => {
  it('copies traits into JSON Schema through wrappers, pick and extend', () => {
    const json = toJSONSchema(Note.pick({ email: true }).extend({ n: z.number() }), 'output')
    expect(json.properties.email).toMatchObject({ 'x-omniface-pii': true, format: 'email' })
  })

  it('mirrors traits into zod’s own metadata registry', () => {
    const s = t(z.string(), { pii: true, description: 'd' })
    expect(z.globalRegistry.get(s)).toMatchObject({ 'x-omniface-pii': true, description: 'd' })
  })

  it('names shared types', () => {
    expect(toJSONSchema(Note, 'output')['x-omniface-name']).toBe('Note')
  })

  it('strips internal and redacts pii, including nested arrays', () => {
    const schema = toJSONSchema(t.page(Note), 'output')
    const value = { items: [{ id: '1', body: 'b', email: 'a@b.co', secret: 'x' }], nextCursor: null }
    expect(stripInternal(value, schema)).toEqual({ items: [{ id: '1', body: 'b', email: 'a@b.co' }], nextCursor: null })
    expect(redact(value, schema)).toMatchObject({ items: [{ email: '[redacted]', secret: 'x' }] })
  })
})

describe('openapi + inspect', () => {
  const app = notesApp()
  const m = buildManifest(app)
  const doc = buildOpenApi(m)

  it('emits OpenAPI 3.1 with path params, query params, bodies and traits', () => {
    expect(doc.openapi).toBe('3.1.0')
    const get = doc.paths['/notes/{id}'].get
    expect(get.operationId).toBe('notes.get')
    expect(get.parameters).toEqual([expect.objectContaining({ name: 'id', in: 'path', required: true })])
    const patch = doc.paths['/notes/{id}'].patch
    expect(Object.keys(patch.requestBody.content['application/json'].schema.properties)).toEqual(['body'])
    expect(patch.parameters.map((p: { name: string }) => p.name)).toContain('Idempotency-Key')
    expect(doc.paths['/notes'].get.parameters.map((p: { name: string }) => p.name)).toEqual(['cursor', 'limit'])
    expect(doc.paths['/notes/{id}'].delete['x-omniface-traits']).toEqual({ destructive: true })
  })

  it('shows one op on every facet', () => {
    const i = inspectOp(app, 'notes.delete', m)
    expect(i.facets['rest']?.snippet).toContain('curl -X DELETE')
    expect(i.facets['cli']?.snippet).toBe('notes notes delete string --yes')
    expect(i.facets['sdk']?.snippet).toContain('client.notes.delete(')
    expect((i.facets['mcp']?.detail as { tool: { name: string } }).tool.name).toBe('notes_delete')
    expect(i.pipeline.stages.find((s) => s.stage === 'handle')!.plugins).toEqual(['handler'])
  })
})
