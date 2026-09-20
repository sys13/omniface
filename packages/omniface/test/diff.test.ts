import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { loadManifestSource, runDiff } from '../src/diff-run.ts'
import { diffManifests, formatDiff, verdict, type ChangeLevel, type FacetKey } from '../src/diff.ts'
import { buildManifest, facet, type App } from '../src/index.ts'
import { scopes } from '../src/plugins/index.ts'
import { t } from '../src/zod/index.ts'
// `buildManifest` takes the erased `App`; the example app's ops tree is fully inferred, and the
// two only meet through a cast, exactly as the CLI's dynamic import does.
import tasksAppTyped from '../../../examples/tasks/src/app.ts'

const tasksApp = tasksAppTyped as unknown as App

// Backlog 4.2: the breaking-change diff. The point of the epic's row is the *per facet* verdict —
// "breaks the Python SDK and a CLI flag, not MCP" — so almost every case here asserts which facets
// a change lands on, not only that it was noticed.

// `scopes()` is present because one case moves the `scope` trait, and an app that declares a
// scope no plugin enforces refuses to start.
const f = facet({ plugins: [scopes()] })

const Task = z.object({ id: z.string(), title: z.string(), priority: z.enum(['low', 'high']) })

type Tweak = {
  input?: z.ZodObject<any>
  output?: z.ZodObject<any>
  traits?: Record<string, unknown>
  errors?: readonly any[]
  facets?: any
  name?: string
  version?: string
  description?: string
  extraOps?: Record<string, any>
  drop?: boolean
}

/** One app, one op, with exactly the corner under test moved. */
function app(tweak: Tweak = {}): App<any> {
  const get = f
    .op({
      description: tweak.description ?? 'Get one thing',
      input: tweak.input ?? z.object({ id: z.string() }),
      output: tweak.output ?? Task,
      errors: tweak.errors ?? (['not_found'] as const),
    })
    .traits({ readonly: true, ...(tweak.traits ?? {}) })
    .handle(() => ({ id: 'a', title: 't', priority: 'low' as const }))
  return f.app({
    name: tweak.name ?? 'acme',
    version: tweak.version ?? '0.1.0',
    ops: { things: { ...(tweak.drop ? {} : { get }), ...(tweak.extraOps ?? {}) } },
    facets: tweak.facets ?? { rest: true, sdk: true, mcp: true, cli: { binName: 'acme' } },
  })
}

const diff = (before: Tweak, after: Tweak) => diffManifests(buildManifest(app(before)), buildManifest(app(after)))

/** The one change with this rule, so a case fails loudly rather than silently matching nothing. */
function only(d: ReturnType<typeof diffManifests>, rule: string) {
  const found = d.changes.filter((c) => c.rule === rule)
  expect(found, `expected exactly one \`${rule}\` change, got: ${d.changes.map((c) => c.rule).join(', ')}`).toHaveLength(1)
  return found[0]!
}

const expectChange = (d: ReturnType<typeof diffManifests>, rule: string, level: ChangeLevel, facets: FacetKey[]) => {
  const change = only(d, rule)
  expect(change.level).toBe(level)
  expect(change.facets).toEqual(facets)
  return change
}

const ALL: FacetKey[] = ['rest', 'mcp', 'cli', 'sdk']

describe('no change', () => {
  it('finds nothing between a manifest and itself', () => {
    const d = diffManifests(buildManifest(tasksApp), buildManifest(tasksApp))
    expect(d.changes).toEqual([])
    expect(d.breakingFacets).toEqual([])
    expect(verdict(d)).toBe('No change: every facet is identical.')
    expect(d.suggestedBump).toBe('patch')
  })
})

describe('ops appearing and disappearing', () => {
  it('reports a removed op as breaking on every facet it was on', () => {
    const d = diff({}, { drop: true })
    expect(expectChange(d, 'op-removed', 'breaking', ALL).op).toBe('things.get')
    expect(d.breakingFacets).toEqual(ALL)
  })

  it('reports a new op as additive', () => {
    const extra = f.op({ description: 'New', output: z.object({ ok: z.boolean() }) }).handle(() => ({ ok: true }))
    const d = diff({}, { extraOps: { ping: extra } })
    expect(expectChange(d, 'op-added', 'additive', ALL).op).toBe('things.ping')
    expect(d.breakingFacets).toEqual([])
    expect(verdict(d)).toContain('Compatible on every facet')
  })

  it('reports an op hidden from one facet on that facet alone', () => {
    const d = diff({}, { facets: { rest: true, sdk: true, mcp: { ops: { 'things.get': false } }, cli: { binName: 'acme' } } })
    expectChange(d, 'op-unprojected', 'breaking', ['mcp'])
    expect(d.breakingFacets).toEqual(['mcp'])
    expect(d.compatibleFacets).toEqual(['rest', 'cli', 'sdk'])
  })
})

describe('input schemas', () => {
  it('a new required field breaks every facet, an optional one breaks none', () => {
    const required = diff({}, { input: z.object({ id: z.string(), tenant: z.string() }) })
    expect(expectChange(required, 'input-field-added-required', 'breaking', ALL).detail).toContain('optional first')

    const optional = diff({}, { input: z.object({ id: z.string(), tenant: z.string().optional() }) })
    expectChange(optional, 'input-field-added', 'additive', ALL)
    expect(optional.breakingFacets).toEqual([])
  })

  it('tightening an existing field is breaking, loosening it is not', () => {
    const base = { input: z.object({ id: z.string(), note: z.string().optional() }) }
    const tightened = diff(base, { input: z.object({ id: z.string(), note: z.string() }) })
    expectChange(tightened, 'input-field-required', 'breaking', ALL)

    const loosened = diff({ input: z.object({ id: z.string(), note: z.string() }) }, base)
    expectChange(loosened, 'input-field-optional', 'additive', ALL)
  })

  it('a removed input field is breaking, and says why on each facet', () => {
    const d = diff({ input: z.object({ id: z.string(), note: z.string() }) }, {})
    const change = expectChange(d, 'input-field-removed', 'breaking', ALL)
    expect(change.message).toContain('`note`')
    expect(change.detail).toContain('CLI flag')
  })

  it('a retyped field is breaking', () => {
    const d = diff({}, { input: z.object({ id: z.number() }) })
    expect(expectChange(d, 'input-field-retyped', 'breaking', ALL).message).toContain('is number, was string')
  })
})

describe('output schemas', () => {
  it('a removed output field is breaking; a new one is not', () => {
    const removed = diff({}, { output: Task.omit({ priority: true }) })
    expectChange(removed, 'output-field-removed', 'breaking', ALL)

    const added = diff({}, { output: Task.extend({ owner: z.string() }) })
    expectChange(added, 'output-field-added', 'additive', ALL)
  })

  it('an output field that may now be absent is breaking, unlike the same move on input', () => {
    const d = diff({}, { output: Task.extend({ priority: Task.shape.priority.optional() }) })
    expectChange(d, 'output-field-optional', 'breaking', ALL)
  })

  it('enum widening is breaking on output and additive on input, and narrowing is the reverse', () => {
    const wider = z.enum(['low', 'high', 'urgent'])
    const out = diff({}, { output: Task.extend({ priority: wider }) })
    expect(expectChange(out, 'output-enum-widened', 'breaking', ALL).detail).toContain('exhaustive switch')

    const inputBase = { input: z.object({ id: z.string(), priority: Task.shape.priority }) }
    const inWider = diff(inputBase, { input: z.object({ id: z.string(), priority: wider }) })
    expectChange(inWider, 'input-enum-widened', 'additive', ALL)
    const inNarrower = diff(inputBase, { input: z.object({ id: z.string(), priority: z.enum(['low']) }) })
    expectChange(inNarrower, 'input-enum-narrowed', 'breaking', ALL)
  })

  it('walks into nested objects and arrays, and names the path a caller would use', () => {
    const before = { output: z.object({ items: z.array(z.object({ id: z.string(), title: z.string() })) }) }
    const after = { output: z.object({ items: z.array(z.object({ id: z.string() })) }) }
    const d = diff(before, after)
    expect(only(d, 'output-field-removed').message).toContain('`items[].title`')
  })

  it('does not loop on a recursive schema', () => {
    const Node: z.ZodType<any> = t.named('Node', z.object({ id: z.string(), get children() { return z.array(Node) } })) as z.ZodType<any>
    const recursive = { output: z.object({ root: Node }) as z.ZodObject<any> }
    expect(diff(recursive, recursive).changes).toEqual([])
  })
})

describe('type names', () => {
  it('treats a renamed type as breaking for the SDK and OpenAPI, not for MCP or the CLI', () => {
    // Two instances, not one renamed: names are keyed by schema instance, so naming the same
    // object twice would rename both sides of the diff at once.
    const d = diff(
      { output: t.named('Task', Task.extend({})) as z.ZodObject<any> },
      { output: t.named('TaskRow', Task.extend({})) as z.ZodObject<any> },
    )
    const change = expectChange(d, 'type-renamed', 'breaking', ['rest', 'sdk'])
    expect(change.message).toContain('Task → TaskRow')
    expect(d.breakingFacets).toEqual(['rest', 'sdk'])
    expect(verdict(d)).toBe('Breaks rest and sdk, not mcp and cli.')
  })
})

describe('traits', () => {
  it('reads a new destructive trait as breaking for the CLI alone', () => {
    const d = diff({}, { traits: { readonly: false, destructive: true } })
    const change = expectChange(d, 'trait-destructive', 'breaking', ['cli'])
    expect(change.detail).toContain('--yes')
    expect(d.breakingFacets).toEqual(['cli'])
  })

  it('reads a new scope as breaking everywhere, and a dropped one as additive', () => {
    const tightened = diff({}, { traits: { scope: 'things:read' } })
    expectChange(tightened, 'trait-scope', 'breaking', ALL)
    const relaxed = diff({ traits: { scope: 'things:read' } }, {})
    expectChange(relaxed, 'trait-scope', 'additive', ALL)
  })

  it('reads losing pagination as breaking and gaining it as additive', () => {
    const page = { input: t.pageInput({}) as z.ZodObject<any>, output: t.page(Task) as z.ZodObject<any>, traits: { paginated: true } }
    const lost = diff(page, { ...page, traits: {} })
    expect(expectChange(lost, 'trait-paginated', 'breaking', ALL).detail).toContain('nextCursor')
    expectChange(diff({ ...page, traits: {} }, page), 'trait-paginated', 'additive', ALL)
  })

  it('reads a hint-only trait change as neutral', () => {
    const d = diff({}, { traits: { idempotent: true } })
    expectChange(d, 'trait-idempotent', 'neutral', ALL)
    expect(d.breakingFacets).toEqual([])
  })

  it('reads a new declared error as additive', () => {
    const d = diff({}, { errors: ['not_found', 'conflict'] as const })
    expect(expectChange(d, 'errors-added', 'additive', ALL).message).toContain('conflict')
  })
})

describe('per-facet bindings', () => {
  it('reports a moved REST route on rest alone', () => {
    const d = diff({}, { facets: { rest: { ops: { 'things.get': { path: '/v2/things/:id' } } }, sdk: true, mcp: true, cli: { binName: 'acme' } } })
    const change = expectChange(d, 'rest-route-changed', 'breaking', ['rest'])
    expect(change.message).toContain('/v2/things/:id')
    expect(d.compatibleFacets).toEqual(['mcp', 'cli', 'sdk'])
  })

  it('reports a renamed MCP tool on mcp alone, and a reworded description as neutral', () => {
    const renamed = diff({}, { facets: { rest: true, sdk: true, mcp: { ops: { 'things.get': { name: 'fetch_thing' } } }, cli: { binName: 'acme' } } })
    expectChange(renamed, 'mcp-tool-renamed', 'breaking', ['mcp'])

    const reworded = diff({}, { facets: { rest: true, sdk: true, mcp: { ops: { 'things.get': { description: 'Fetch it' } } }, cli: { binName: 'acme' } } })
    expectChange(reworded, 'mcp-description-changed', 'neutral', ['mcp'])
    expect(reworded.breakingFacets).toEqual([])
  })

  it('reports a renamed CLI command and a changed positional on cli alone', () => {
    const renamed = diff({}, { facets: { rest: true, sdk: true, mcp: true, cli: { binName: 'acme', ops: { 'things.get': { command: 'thing show' } } } } })
    expectChange(renamed, 'cli-command-renamed', 'breaking', ['cli'])

    const positional = diff({}, { facets: { rest: true, sdk: true, mcp: true, cli: { binName: 'acme', ops: { 'things.get': { args: [] } } } } })
    expectChange(positional, 'cli-args-changed', 'breaking', ['cli'])
  })

  it('reports changed table columns as presentation, not a break', () => {
    const d = diff({}, { facets: { rest: true, sdk: true, mcp: true, cli: { binName: 'acme', ops: { 'things.get': { columns: ['id'] } } } } })
    expectChange(d, 'cli-columns-changed', 'neutral', ['cli'])
  })

  it('reports a renamed CLI binary and a turned-off facet', () => {
    const renamed = diff({}, { facets: { rest: true, sdk: true, mcp: true, cli: { binName: 'acme2' } } })
    expect(expectChange(renamed, 'cli-bin-renamed', 'breaking', ['cli']).detail).toContain('ACME_')

    const off = diff({}, { facets: { rest: true, sdk: true, cli: { binName: 'acme' } } })
    expectChange(off, 'facet-removed', 'breaking', ['mcp'])
  })

  it('reports a renamed SDK package, which breaks the import rather than a call', () => {
    // The package name is what a consumer wrote in their own package.json, so renaming it is a
    // break that no change to any op would show.
    const renamed = diff({}, { facets: { rest: true, mcp: true, cli: { binName: 'acme' }, sdk: { packageName: '@acme/sdk-v2' } } })
    expect(expectChange(renamed, 'sdk-package-renamed', 'breaking', ['sdk']).detail).toContain("import")
  })
})

describe('the report', () => {
  it('leads with which facets break and which do not', () => {
    const d = diff({}, { traits: { readonly: false, destructive: true } })
    const text = formatDiff(d)
    expect(text).toContain('BREAKING (1)')
    expect(text).toContain('Breaks cli, not rest, mcp and sdk.')
    expect(text).toContain('Suggested version bump: minor')
  })

  it('hides neutral noise on request', () => {
    const d = diff({}, { description: 'Get one thing, by id' })
    expect(formatDiff(d)).toContain('op-description-changed')
    const quiet = formatDiff(d, { quiet: true })
    expect(quiet).not.toContain('op-description-changed')
    expect(quiet).toContain('neutral change(s) hidden')
  })

  it('suggests no bump when nothing observable changed', () => {
    const d = diff({}, {})
    expect(d.counts).toEqual({ breaking: 0, additive: 0, neutral: 0 })
    expect(formatDiff(d)).toContain('No change')
  })
})

describe('omniface diff, the command', () => {
  const ENTRY = resolve(import.meta.dirname, '../../../examples/tasks/src/app.ts')

  it('loads either side from an app module', async () => {
    const source = await loadManifestSource(ENTRY)
    expect(source.kind).toBe('app')
    expect(source.manifest.name).toBe('tasks')
  })

  it('diffs a built manifest against the working tree', async () => {
    const dir = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : (await import('node:os')).tmpdir()
    const path = resolve(dir, `facet-diff-${process.pid}.json`)
    const baseline = buildManifest(tasksApp)
    // The published version, one field poorer than the working tree.
    const stale = structuredClone(baseline)
    const list = stale.ops.find((o) => o.id === 'tasks.list')!
    delete (list.output.properties as any).nextCursor
    await (await import('node:fs/promises')).writeFile(path, JSON.stringify(stale))

    const result = await runDiff(path, ENTRY)
    expect(result.sources.before.kind).toBe('manifest')
    expect(result.sources.after.kind).toBe('app')
    expect(result.changes.map((c) => c.rule)).toContain('output-field-added')
  })

  it('refuses a file that is not a manifest, by name', async () => {
    const dir = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : (await import('node:os')).tmpdir()
    const path = resolve(dir, `not-a-manifest-${process.pid}.json`)
    await (await import('node:fs/promises')).writeFile(path, '{"hello":true}')
    await expect(loadManifestSource(path)).rejects.toThrow('is not a facet manifest')
    await expect(loadManifestSource(resolve(dir, 'missing.json'))).rejects.toThrow('omniface build')
  })
})
