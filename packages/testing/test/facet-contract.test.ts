import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  build,
  buildManifest,
  diffManifests,
  facet,
  inspectOp,
  projectionOf,
  registerFacet,
  type App,
  type ManifestOp,
} from 'omniface'
import { conformanceCases } from '../src/index.ts'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The gate #27 asks for: a facet added as a module reaches the manifest, `omniface inspect`, the
 * docs, `omniface diff` and the conformance contract check **by landing once**.
 *
 * `probe` is a test fixture, not a facet omniface ships — the issue's fence rules a sixth facet
 * out of this change, and the point here is the contract rather than the facet. It is deliberately
 * the smallest thing that satisfies the contract: a projection, a diff rule, a presentation, a
 * settings blob and a contract check, and no `serve` hook at all.
 *
 * What this proves: nothing in `manifest.ts`, `inspect.ts`, `diff.ts`, `build.ts` or the
 * conformance contract check was edited for `probe`, and all five answer for it.
 *
 * What it does not prove: that a *served* facet needs no edit outside its module (`probe` has no
 * server), and that the live conformance channels — `harness.ts`'s `CHANNELS`, which actually
 * calls an op over each protocol — grow with it. They do not; that is still a hand-written list.
 */

type ProbeProjection = { slug: string; shouted: string }

registerFacet({
  name: 'probe',
  defaultOn: false,
  normalize: (value) => (value === undefined || value === false ? null : value === true ? {} : (value as object)),
  // Refuses one op on purpose, so the conformance contract check has something to report.
  project: ({ op }) => (op.id.endsWith('.skip') ? null : { slug: op.path.join('-'), shouted: op.id.toUpperCase() }),
  settings: () => ({ greeting: 'hello' }),
  diff: (before: ProbeProjection, after: ProbeProjection, { op }) =>
    before.slug === after.slug ? [] : [{ level: 'breaking' as const, rule: 'probe-slug-changed', message: `${op}: probe slug moved.` }],
  present: (_ctx, projection: ProbeProjection) => ({
    label: 'Probe',
    short: projection.slug,
    snippet: `probe ${projection.slug}`,
    line: `- Probe: \`${projection.slug}\``,
  }),
  summary: () => 'a probe',
  contract: (_ctx, projection: ProbeProjection | null) => (projection ? [] : ['no probe binding']),
})

const probeOf = (op: ManifestOp) => projectionOf<ProbeProjection>(op, 'probe')

function app(overrides: Record<string, unknown> = {}, description = 'A probe subject') {
  const f = facet()
  const ops = {
    notes: {
      get: f
        .op({ input: z.object({ id: z.string() }), output: z.object({ id: z.string(), body: z.string() }) })
        .traits({ readonly: true })
        .handle(({ input }) => ({ id: input.id, body: 'b' })),
      skip: f
        .op({ input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) })
        .traits({ readonly: true })
        .handle(({ input }) => ({ id: input.id })),
    },
  }
  return f.app({
    name: 'probe-app',
    version: '0.1.0',
    description,
    ops,
    facets: { rest: true, ...overrides, probe: true } as never,
  }) as unknown as App
}

describe('a facet added as a module lands once', () => {
  it('reaches the manifest, under its own name, without manifest.ts knowing it exists', () => {
    const m = buildManifest(app())
    expect(Object.keys(m.facets)).toEqual(['rest', 'probe'])
    expect(m.facets['probe']).toEqual({ greeting: 'hello' })
    expect(probeOf(m.ops[0]!)).toEqual({ slug: 'notes-get', shouted: 'NOTES.GET' })
    expect(probeOf(m.ops.find((o) => o.id === 'notes.skip')!)).toBeNull()
  })

  it('reaches omniface inspect', () => {
    const shown = inspectOp(app(), 'notes.get').facets['probe']
    expect(shown).toMatchObject({ label: 'Probe', short: 'notes-get', snippet: 'probe notes-get' })
  })

  it('reaches llms.txt, both the summary line and the per-op line', async () => {
    const out = await mkdtemp(join(tmpdir(), 'facet-probe-'))
    await build(app(), out)
    const llms = await readFile(join(out, 'llms.txt'), 'utf8')
    expect(llms).toContain('and a probe.')
    expect(llms).toContain('- Probe: `notes-get`')
  })

  it('reaches omniface diff, for the facet being turned on and for its own rule', () => {
    const off = buildManifest(
      (() => {
        const f = facet()
        const ops = { notes: { get: f.op({ input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) }).traits({ readonly: true }).handle(({ input }) => input) } }
        return f.app({ name: 'probe-app', version: '0.1.0', ops, facets: { rest: true } }) as unknown as App
      })(),
    )
    const on = buildManifest(app())
    const turnedOn = diffManifests(off, on)
    expect(turnedOn.changes.find((c) => c.rule === 'facet-added' && c.facets[0] === 'probe')).toBeTruthy()

    // The facet's own rule, run by diff.ts without diff.ts knowing the rule exists.
    const moved = structuredClone(on)
    ;(moved.ops[0]!.facets['probe'] as ProbeProjection).slug = 'notes-fetch'
    const change = diffManifests(moved, on).changes.find((c) => c.rule === 'probe-slug-changed')
    expect(change).toMatchObject({ level: 'breaking', op: 'notes.get', facets: ['probe'] })
  })

  it('reaches the generated conformance contract check, and can fail it', async () => {
    const cases = conformanceCases({ app: () => app(), apiKey: 'k' })
    const clean = cases.find((c) => c.op === 'notes.get' && c.check === 'contract')!
    expect((await clean.run()).problems).toEqual([])

    // The op probe refuses. The suite reports it because probe said so — nothing was added to
    // `conformance.ts` to teach it about a facet called probe.
    const missing = cases.find((c) => c.op === 'notes.skip' && c.check === 'contract')!
    expect((await missing.run()).problems).toContain('no probe binding')
  })
})
