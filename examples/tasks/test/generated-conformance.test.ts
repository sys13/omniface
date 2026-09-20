import { conformanceCases, conformanceCoverage } from '@omniface/testing'
import { describe, expect, it } from 'vitest'
import fixtures from '../src/conformance.fixtures.ts'

/**
 * Nothing here names an op. The cases come from the definition: every op the app and its plugins
 * declare, on every facet it is projected to. Adding an op adds its cases; the only hand-written
 * inputs live in conformance.fixtures.ts, which `omniface conformance` reads too — so the command and
 * this suite run the same cases rather than two drifting copies of them.
 */

const cases = conformanceCases(fixtures)

describe('generated conformance', () => {
  it('covers every op in the app', () => {
    const ops = [...new Set(cases.map((c) => c.op))].sort()
    expect(ops).toEqual([
      'agentToken.mint',
      'apiKeys.create',
      'apiKeys.list',
      'apiKeys.revoke',
      'auth.whoami',
      'tasks.complete',
      'tasks.create',
      'tasks.delete',
      'tasks.get',
      'tasks.list',
      'tasks.update',
    ])
    // Derived cases, not hand-written ones: several per op, across four facets.
    expect(cases.length).toBeGreaterThan(30)
    // The `idempotent` trait earns its own check, on every facet that can carry a key.
    expect(cases.find((c) => c.name === 'tasks.complete · idempotent')?.channels).toEqual(['rest', 'sdk', 'cli', 'mcp', 'web'])
  })

  it('has nothing left that an input would buy more cases for', () => {
    const coverage = conformanceCoverage(fixtures)
    // Every op either has the input it needs or says in the fixtures why it cannot have one, so
    // there is no case the definition could generate that this app is not already running.
    expect(coverage.needInput).toEqual([])
    expect(coverage.cases.generated).toBe(cases.length)
    expect(coverage.cases.possible).toBe(coverage.cases.generated)
  })

  it('proves a destructive op agrees across facets, each against its own app', () => {
    // Four facets deleting the same row would leave three not_founds, so the case that would
    // otherwise be unrunnable gets a fresh app per facet.
    const agree = cases.find((c) => c.name === 'tasks.delete · agree')
    expect(agree?.channels).toEqual(['rest', 'sdk', 'cli', 'mcp', 'web'])
  })

  for (const c of cases) {
    it(c.name, async () => {
      const { problems } = await c.run()
      expect(problems).toEqual([])
    })
  }
})
