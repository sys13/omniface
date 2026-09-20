import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { findFixtures, runConformanceFor } from '../src/conformance-run.ts'
import { facet } from '../src/index.ts'
import tasksApp from '../../../examples/tasks/src/app.ts'

// Backlog 4.1: the generated suite as a command. The cases themselves are proven in
// packages/testing; what is checked here is the plumbing the CLI adds around them.

const ROOT = resolve(import.meta.dirname, '../../..')
const ENTRY = resolve(ROOT, 'examples/tasks/src/app.ts')
// A path in a directory with no fixtures beside it, for the zero-config mode.
const BARE_ENTRY = resolve(ROOT, 'examples/tasks/test/app.ts')

describe('omniface conformance', () => {
  it('finds fixtures by convention beside the entry', () => {
    expect(findFixtures(ENTRY)).toBe(resolve(ROOT, 'examples/tasks/src/conformance.fixtures.ts'))
  })

  it('finds none when the convention was not followed', () => {
    expect(findFixtures(BARE_ENTRY)).toBeUndefined()
  })

  it('runs contract checks with no fixtures, no credential and no setup', async () => {
    const result = await runConformanceFor(BARE_ENTRY, tasksApp, { only: ['tasks.list'] })
    expect(result.mode).toBe('contract')
    expect(result.total).toBe(1)
    expect(result.failures).toEqual([])
    // Nothing was called, so there is nothing to say about coverage.
    expect(result.coverage).toBeUndefined()
  })

  it('runs the calling checks too once fixtures are found, and reports coverage', async () => {
    const result = await runConformanceFor(ENTRY, tasksApp, { only: ['tasks.get'] })
    expect(result.mode).toBe('full')
    expect(result.fixtures).toBe(resolve(ROOT, 'examples/tasks/src/conformance.fixtures.ts'))
    expect(result.failures).toEqual([])
    // More than the single contract case: the fixtures' input and setup unlock the rest.
    expect(result.total).toBeGreaterThan(1)
    expect(result.coverage?.needInput).toEqual([])
  })

  it('reports a deliberate divergence as a named failure, not an exception', async () => {
    const f = facet()
    const diverged = f.app({
      name: 'diverged',
      ops: {
        things: {
          list: f
            .op({ description: 'List', input: z.object({}), output: z.object({ items: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() }) })
            .traits({ readonly: true })
            .handle(() => ({ items: [], nextCursor: null })),
        },
      },
      // A column the output has no field for: the CLI would advertise one nothing fills.
      facets: { cli: { ops: { 'things.list': { columns: ['nonsense'] } } } },
    })
    const result = await runConformanceFor(BARE_ENTRY, diverged, { only: ['things.list'] })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.name).toBe('things.list · contract')
    expect(result.failures[0]!.problems).toContain('CLI column "nonsense" is not an output field')
  })

  it('refuses fixtures that cannot give each case a fresh app', async () => {
    await expect(runConformanceFor(ENTRY, tasksApp, { fixtures: resolve(ROOT, 'examples/tasks/src/app.ts') })).rejects.toThrow(
      /fresh app/,
    )
  })

  it('says where to look when the fixtures path is wrong', async () => {
    await expect(runConformanceFor(ENTRY, tasksApp, { fixtures: resolve(ROOT, 'nope.ts') })).rejects.toThrow(/No fixtures at/)
  })
})
