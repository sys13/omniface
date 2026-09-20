import { conformanceCases, runConformance, type ConformanceOptions } from '@omniface/testing'
import { definePlugin, errors, facet, type App } from 'omniface'
import { apiKeys, idempotency, scopes } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'

const KEY = 'test_admin_key'
const READER_KEY = 'test_reader_key'
const Thing = t.named('Thing', z.object({ id: t.id({ example: 'thing_1' }), label: z.string().min(1) }))

type Broken = { restPath?: string; leakyAuth?: boolean; noIdempotency?: boolean }

/** A two-op app, plus whichever deliberate break the case is proving the suite catches. */
function createApp(broken: Broken = {}): App {
  const leaky = definePlugin({
    name: 'leaky-auth',
    hooks: { authenticate: (inv) => void (inv.principal = { id: 'ghost', kind: 'user', scopes: ['*'] }) },
  })
  const f = facet({
    plugins: [
      ...(broken.leakyAuth ? [leaky] : []),
      ...(broken.noIdempotency ? [] : [idempotency()]),
      apiKeys({
        keys: [
          { key: KEY, principalId: 'user_admin', scopes: ['*'] },
          { key: READER_KEY, principalId: 'user_reader', scopes: ['things:read'] },
        ],
      }),
      scopes(),
    ],
  })
  const things = new Map<string, z.infer<typeof Thing>>([['thing_1', { id: 'thing_1', label: 'Seeded' }]])
  let touches = 1
  return f.app({
    name: 'things',
    ops: {
      things: {
        get: f
          .op({ input: Thing.pick({ id: true }), output: Thing, errors: ['not_found'] })
          .traits({ readonly: true, scope: 'things:read' })
          .handle(({ input }) => {
            const thing = things.get(input.id)
            if (!thing) throw errors.notFound(`No thing "${input.id}"`)
            return thing
          }),
        // Its repeat is observable: every real run returns a new id, so a replay is unmistakable.
        touch: f
          .op({ input: z.object({ label: z.string() }), output: Thing })
          .traits({ idempotent: true, scope: 'things:write' })
          .handle(({ input }) => {
            const thing = { id: `thing_${++touches}`, label: input.label }
            things.set(thing.id, thing)
            return thing
          }),
        list: f
          .op({ output: z.object({ items: z.array(Thing) }) })
          .traits({ readonly: true, scope: 'things:read' })
          .handle(() => ({ items: [...things.values()] })),
      },
    },
    facets: {
      rest: broken.restPath ? { ops: { 'things.get': { path: broken.restPath } } } : true,
      sdk: true,
      cli: true,
      mcp: true,
    },
  })
}

const options = (broken: Broken = {}): ConformanceOptions => ({
  app: () => createApp(broken),
  apiKey: KEY,
  unprivileged: { apiKey: READER_KEY, scopes: ['things:read'] },
  ops: { 'things.get': { input: { id: 'thing_1' } }, 'things.touch': { input: { label: 'touched' } } },
})

describe('generated conformance', () => {
  it('derives cases from the definition, including plugin-contributed ops', () => {
    const cases = conformanceCases(options())
    expect([...new Set(cases.map((c) => c.op))].sort()).toEqual([
      'apiKeys.create',
      'apiKeys.list',
      'apiKeys.revoke',
      'auth.whoami',
      'things.get',
      'things.list',
      'things.touch',
    ])
    // Every op is at least checked for contract drift, and the traits decide the rest.
    expect(cases.filter((c) => c.check === 'contract')).toHaveLength(7)
    expect(cases.find((c) => c.name === 'things.get · not_found')).toBeDefined()
    expect(cases.find((c) => c.name === 'auth.whoami · anonymous')?.check).toBe('anonymous')
    // A public op is never asked to refuse, and a scoped one is never asked to answer.
    expect(cases.find((c) => c.name === 'things.list · not_found')).toBeUndefined()
  })

  it('passes against a healthy app', async () => {
    expect(await runConformance(options())).toEqual([])
  })

  it('catches a REST path that names a field the op does not have', async () => {
    const failures = await runConformance(options({ restPath: '/things/{thingId}' }))
    const contract = failures.find((f) => f.name === 'things.get · contract')
    expect(contract?.problems).toContain('REST path param "thingId" is not an input field')
    // Only that op is affected, and the cases it breaks say so instead of crashing the run.
    expect(failures.every((f) => f.name.startsWith('things.get'))).toBe(true)
    expect(failures.find((f) => f.name === 'things.get · not_found')?.problems[0]).toMatch(/could not run/)
  })

  it('carries an idempotency key on every facet, and catches a server that ignores it', async () => {
    const failures = await runConformance(options({ noIdempotency: true }))
    const idempotent = failures.find((f) => f.name === 'things.touch · idempotent')
    // Every facet has its own way to carry the key: a header, a CLI flag, MCP tool-call _meta.
    expect(idempotent?.problems).toEqual([
      'rest: the same key ran the op again instead of replaying the first result',
      'sdk: the same key ran the op again instead of replaying the first result',
      'cli: the same key ran the op again instead of replaying the first result',
      'mcp: the same key ran the op again instead of replaying the first result',
    ])
  })

  it('catches a scoped op that answers an anonymous caller', async () => {
    const failures = await runConformance(options({ leakyAuth: true }))
    const names = failures.map((f) => f.name)
    expect(names).toContain('things.get · anonymous')
    expect(names).toContain('things.list · anonymous')
    expect(failures.find((f) => f.name === 'things.list · anonymous')!.problems.join(' ')).toContain(
      'expected a scoped op to refuse an anonymous caller',
    )
  })

  it('reports every facet the drift reaches, not just the first', async () => {
    const failures = await runConformance(options({ leakyAuth: true }))
    const problems = failures.find((f) => f.name === 'things.list · anonymous')!.problems
    expect(problems.filter((p) => p.startsWith('rest:'))).toHaveLength(1)
    expect(problems.filter((p) => p.startsWith('mcp:'))).toHaveLength(1)
    expect(problems.filter((p) => p.startsWith('cli:'))).toHaveLength(1)
    expect(problems.filter((p) => p.startsWith('sdk:'))).toHaveLength(1)
  })
})
