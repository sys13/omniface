import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildManifest, facet, mcpTools, type App } from '../src/index.ts'

// OpenAPI marks a deprecated op with `deprecated: true`; MCP has no such flag, so the marker goes at the front of the tool description an agent reads.

const f = facet()
const op = (traits: Record<string, unknown>, description = 'Search tasks') =>
  f.op({ description, input: z.object({ q: z.string() }), output: z.object({ ok: z.boolean() }) })
    .traits({ readonly: true, ...traits })
    .handle(() => ({ ok: true }))

const manifestOf = (ops: Record<string, any>, mcp: any = true) =>
  buildManifest(f.app({ name: 'acme', ops, facets: { mcp, rest: true } }) as unknown as App<any>)
const describe1 = (traits: Record<string, unknown>, description?: string) =>
  mcpTools(manifestOf({ search: { run: op(traits, description) } }))[0]!.description

describe('deprecated ops on MCP', () => {
  it('puts the message in front of the description', () => {
    expect(describe1({ deprecated: 'Use tasks_list with q.' })).toBe('Deprecated: Use tasks_list with q. Search tasks')
  })

  it('marks a bare deprecated trait without a message', () => {
    expect(describe1({ deprecated: true })).toBe('Deprecated. Search tasks')
  })

  it('does not add a second marker to a description that has one', () => {
    expect(describe1({ deprecated: 'Use x.' }, 'Deprecated: Use x. Search tasks')).toBe('Deprecated: Use x. Search tasks')
  })

  it('leaves other ops alone', () => {
    expect(describe1({})).toBe('Search tasks')
  })

  it('marks the action line of a grouped op', () => {
    const m = manifestOf(
      { search: { run: op({ deprecated: 'Use list.' }) } },
      { tools: { tasks: { description: 'Tasks', ops: ['search.run'] } } },
    )
    expect(mcpTools(m)[0]!.description).toContain('- run: Deprecated: Use list. Search tasks.')
  })
})
