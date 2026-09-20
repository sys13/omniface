import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { facet } from '../src/index.ts'
import { lint, OVERRIDE_BUDGET } from '../src/lint.ts'
import { t } from '../src/zod/index.ts'

// Backlog 4.3 and 4.5: the two guardrails that keep traits and overrides honest.

const f = facet()

const ops = (n: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `op${i}`,
      f.op({ description: `Op ${i}`, input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) }).handle(() => ({ ok: true })),
    ]),
  )

// The unused-trait rule is opt-in and process-wide, so it is asked for explicitly here, exactly
// as `omniface lint` asks for it.
const findings = (app: Parameters<typeof lint>[0], rule: string) =>
  lint(app, undefined, { unusedTraits: true }).filter((x) => x.rule === rule)

describe('unused-trait lint (4.3)', () => {
  it('says nothing about traits every op reaches', () => {
    const Email = t(z.email(), { pii: true })
    const app = f.app({
      name: 'reached',
      ops: { thing: { get: f.op({ description: 'Get', input: z.object({ email: Email }), output: z.object({ ok: z.boolean() }) }).handle(() => ({ ok: true })) } },
    })
    expect(findings(app, 'unused-trait')).toEqual([])
  })

  it('catches traits left behind on a schema no op reaches', () => {
    // The field was tagged, then dropped from the op: the declaration outlives what it protected.
    const Orphan = t(z.email(), { sensitive: true, description: 'api token' })
    void Orphan
    const app = f.app({
      name: 'orphaned',
      ops: { thing: { get: f.op({ description: 'Get', input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) }).handle(() => ({ ok: true })) } },
    })
    const found = findings(app, 'unused-trait')
    expect(found).toHaveLength(1)
    expect(found[0]!.message).toContain('sensitive: true')
    expect(found[0]!.message).toContain('api token')
    expect(found[0]!.message).toContain('affect nothing')
    expect(found[0]!.level).toBe('warn')
  })

  // Worth pinning: the rule was written expecting schema methods to strand traits, and they don't.
  // zod's clones stay visible to the adapter's conversion callback, so the traits still land in the
  // JSON Schema — and the rule stays quiet, which is the correct answer rather than a missed catch.
  it.each(['min', 'nullable', 'optional', 'describe'] as const)('does not fire for .%s(), which keeps its traits', (method) => {
    const base = t(z.string(), { pii: true })
    const field = method === 'min' ? base.min(1) : method === 'describe' ? base.describe('d') : base[method]()
    const app = f.app({
      name: `kept-${method}`,
      ops: { thing: { get: f.op({ description: 'Get', input: z.object({ token: field }), output: z.object({ ok: z.boolean() }) }).handle(() => ({ ok: true })) } },
    })
    expect(findings(app, 'unused-trait')).toEqual([])
    expect(JSON.stringify(app.ops.get('thing.get')!.inputSchema)).toContain('x-omniface-pii')
  })

  it('stays quiet once any app has reached the schema, so a fresh app per case is not a finding', () => {
    const Shared = t(z.email(), { pii: true })
    const build = () =>
      f.app({
        name: 'repeat',
        ops: { thing: { get: f.op({ description: 'Get', input: z.object({ email: Shared }), output: z.object({ ok: z.boolean() }) }).handle(() => ({ ok: true })) } },
      })
    build()
    // A second app built from the same schemas: the first app's instances are no longer the ones
    // being linted, but they were reached once, which is what the rule asks.
    expect(findings(build(), 'unused-trait')).toEqual([])
  })
})

describe('override budget lint (4.5)', () => {
  it('allows a few overrides', () => {
    const app = f.app({
      name: 'few',
      ops: ops(12),
      facets: { rest: { ops: { op0: { path: '/zero' }, op1: { path: '/one' } } } },
    })
    expect(findings(app, 'override-budget')).toEqual([])
  })

  it('warns once a facet is mostly overrides', () => {
    const app = f.app({
      name: 'many',
      ops: ops(6),
      facets: { rest: { ops: { op0: { path: '/a' }, op1: { path: '/b' }, op2: { path: '/c' }, op3: { path: '/d' } } } },
    })
    const found = findings(app, 'override-budget')
    expect(found).toHaveLength(1)
    expect(found[0]!.message).toContain('4 of 6 rest ops')
    expect(found[0]!.message).toContain('rename the ops instead')
  })

  it('never accuses a small app, however overridden', () => {
    const app = f.app({ name: 'tiny', ops: ops(2), facets: { rest: { ops: { op0: { path: '/a' }, op1: { path: '/b' } } } } })
    expect(findings(app, 'override-budget')).toEqual([])
    expect(OVERRIDE_BUDGET.min).toBe(3)
  })

  it('does not count turning a projection off, which is step 2 not step 3', () => {
    const app = f.app({
      name: 'off',
      ops: ops(6),
      facets: { rest: { ops: { op0: false, op1: false, op2: false, op3: false } } },
    })
    expect(findings(app, 'override-budget')).toEqual([])
  })
})
