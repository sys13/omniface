import { describe, expect, it } from 'vitest'
import { createHarness, createSampleApp, pluginCases } from '@omniface/testing'
import { usage } from '../src/index.ts'

// Every plugin should have these two tests: the generated kit, and whatever the plugin is *for*.

describe('conformance', () => {
  for (const c of pluginCases({ plugin: () => usage() })) {
    it(c.name, async () => expect(await c.run()).toEqual([]))
  }
})

describe('what the plugin is for', () => {
  it('counts calls, whichever facet they arrive on', async () => {
    const harness = createHarness(createSampleApp([usage()]))
    await harness.call('rest', 'items.list')
    await harness.call('cli', 'items.list')
    await harness.call('mcp', 'items.get', { id: 'item_1' })
    const summary = await harness.call('sdk', 'usage.summary')
    expect(summary).toEqual({ ok: true, value: { total: 3, ops: { 'items.get': 1, 'items.list': 2 } } })
  })

  it('serves its own route under its own namespace', async () => {
    const harness = createHarness(createSampleApp([usage()]))
    await harness.call('rest', 'items.list')
    const res = await harness.fetch('http://facet.test/_usage/summary.json')
    expect(await res.json()).toEqual({ 'items.list': 1 })
  })

  it('decorates a REST answer without changing it', async () => {
    const harness = createHarness(createSampleApp([usage()]))
    const res = await harness.fetch('http://facet.test/items')
    expect(res.headers.get('x-usage-op')).toBe('items.list')
    expect(await res.json()).toMatchObject({ items: [{ id: 'item_1' }] })
  })
})
