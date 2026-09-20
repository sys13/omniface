import { describe, expect, it } from 'vitest'
import { definePlugin, errors } from 'omniface'
import { apiKeys, audit, idempotency, logging, memoryIdempotencyStore, otel, rateLimit, scopes } from 'omniface/plugins'
import { createSampleApp, pluginCases, runPluginConformance, type PluginConformanceOptions } from '../src/index.ts'

// Backlog 3.3: the kit a plugin has to pass before anyone installs it, run here against the
// plugins that ship with facet — and against plugins built to fail, so the kit is known to bite.

const silent = { sink: () => {} }

const suites: Record<string, PluginConformanceOptions> = {
  logging: { plugin: () => logging(silent) },
  audit: { plugin: () => audit({ sink: () => {} }) },
  otel: { plugin: () => otel({ tracer: undefined, meter: undefined, api: undefined }) },
  idempotency: { plugin: () => idempotency({ store: memoryIdempotencyStore() }) },
  // apiKeys contributes scoped ops of its own, so something has to be able to authorize them:
  // Gate 1 refuses to start an app whose declared scopes nobody enforces.
  apiKeys: {
    plugin: () => apiKeys({ prefix: 'test_', keys: [{ key: 'test_key', principalId: 'u1', scopes: ['*'] }] }),
    before: () => [scopes()],
    apiKey: 'test_key',
  },
  rateLimit: { plugin: () => rateLimit({ limit: '1000/min' }) },
}

for (const [name, options] of Object.entries(suites)) {
  describe(`the ${name} plugin conforms`, () => {
    for (const c of pluginCases(options)) {
      it(c.name, async () => expect(await c.run()).toEqual([]))
    }
  })
}

describe('a plugin that enforces scopes', () => {
  // The sample app can declare a scope on every op, which is what an authorizing plugin needs to
  // have something to enforce — and what makes "refuses anonymous callers identically" meaningful.
  const options: PluginConformanceOptions = {
    plugin: () => scopes(),
    before: () => [apiKeys({ prefix: 'test_', keys: [{ key: 'test_key', principalId: 'u1', scopes: ['*'] }] })],
    apiKey: 'test_key',
    scope: 'items:use',
    deniesAnonymous: true,
  }
  for (const c of pluginCases(options)) {
    it(c.name, async () => expect(await c.run()).toEqual([]))
  }
})

describe('the kit catches what it is for', () => {
  it('catches a plugin that only rejects on one facet', async () => {
    const drifting = definePlugin({
      name: 'drifting',
      hooks: {
        authorize(inv) {
          if (inv.facet === 'mcp') throw errors.forbidden('not over MCP')
        },
      },
    })
    const failures = await runPluginConformance({ plugin: () => drifting })
    expect(failures.map((f) => f.name)).toContain('drifting · every facet agrees on every op')
    expect(failures.flatMap((f) => f.problems).join('\n')).toContain('mcp')
  })

  it('catches a plugin that changes an app it has nothing to do with', async () => {
    const meddling = definePlugin({
      name: 'meddling',
      hooks: {
        validate(inv) {
          if (inv.op.id === 'items.get') throw errors.conflict('nope')
        },
      },
    })
    const failures = await runPluginConformance({ plugin: () => meddling })
    expect(failures.map((f) => f.name)).toContain("meddling · leaves the app's own answers alone")
  })

  it('catches an adapter route that is not mounted where it says it is', async () => {
    const lying = definePlugin({
      name: 'lying',
      adapters: { rest: { routes: [{ method: 'GET', path: '/ping', handler: () => new Response(null, { status: 404 }) }] } },
    })
    const failures = await runPluginConformance({ plugin: () => lying })
    expect(failures.flatMap((f) => f.problems).join('\n')).toContain('declared but not mounted')
  })

  it('catches a hook in a stage that does not exist', async () => {
    const bogus = definePlugin({ name: 'bogus', hooks: { nonsense: () => {} } as never })
    const failures = await runPluginConformance({ plugin: () => bogus })
    expect(failures.flatMap((f) => f.problems).join('\n')).toContain('not a pipeline stage')
  })
})

describe('the sample app', () => {
  it('declares four ops with no schema library installed', () => {
    expect([...createSampleApp().ops.keys()]).toEqual(['items.list', 'items.get', 'items.create', 'items.remove'])
  })

  // Every op actually run, because a sample app that fails identically on all four facets would
  // sail through "every facet agrees" — the kit compares the facets, not the app.
  it('answers each of its ops', async () => {
    const app = createSampleApp()
    const call = (id: string, input: unknown) => app.invoke(id, input, { facet: 'rest' })
    await expect(call('items.list', {})).resolves.toEqual({ items: [{ id: 'item_1', title: 'Seeded', done: false }], nextCursor: null })
    await expect(call('items.get', { id: 'item_1' })).resolves.toEqual({ id: 'item_1', title: 'Seeded', done: false })
    await expect(call('items.create', { title: 'New' })).resolves.toEqual({ id: 'item_2', title: 'New', done: false })
    await expect(call('items.remove', { id: 'item_1' })).resolves.toEqual({ id: 'item_1' })
    await expect(call('items.get', { id: 'item_1' })).rejects.toThrow(/No item/)
  })

  it('refuses input its schemas do not accept', async () => {
    const app = createSampleApp()
    await expect(app.invoke('items.get', {}, { facet: 'rest' })).rejects.toThrow(/Missing required field "id"/)
    await expect(app.invoke('items.create', { title: 42 }, { facet: 'rest' })).rejects.toThrow(/Expected a string/)
  })

  it('starts fresh for each caller, so cases cannot reach one another', async () => {
    await createSampleApp().invoke('items.remove', { id: 'item_1' }, { facet: 'rest' })
    await expect(createSampleApp().invoke('items.get', { id: 'item_1' }, { facet: 'rest' })).resolves.toMatchObject({ id: 'item_1' })
  })
})
