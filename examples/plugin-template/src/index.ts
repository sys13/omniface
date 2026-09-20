import { definePlugin, op, type Invocation, type StandardSchemaV1 } from 'omniface'

/**
 * A facet plugin, start to finish — copy this directory and replace the behaviour.
 *
 * `usage()` counts what an app is asked to do: one counter per op, readable through an op it
 * contributes (so every facet can read it), through a JSON route of its own, and as a response
 * header on REST. It is small on purpose; what it demonstrates is the *shape*:
 *
 * - `hooks` — one function per pipeline stage, running for every facet, never per facet;
 * - `ops` — operations the plugin contributes, projected like the app's own;
 * - `adapters` — the per-facet slot: presentation only, never a decision about whether an op runs;
 * - the `Ctx` type parameter — what handlers get on `ctx`.
 *
 * The rules a plugin has to keep are in docs/PLUGINS.md, and `@omniface/testing`'s `pluginCases()`
 * checks the ones that can be checked (see `test/conformance.test.ts`).
 */

export type UsageOptions = {
  /** Where the counts live. Default: a Map in this process. */
  store?: UsageStore
  /** Refuse to answer `usage.summary` to an anonymous caller. Default false. */
  scope?: string
}

export type UsageStore = {
  increment(opId: string): void | Promise<void>
  read(): Record<string, number> | Promise<Record<string, number>>
}

export function memoryUsageStore(): UsageStore {
  const counts = new Map<string, number>()
  return {
    increment: (opId) => void counts.set(opId, (counts.get(opId) ?? 0) + 1),
    read: () => Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
  }
}

/** What the plugin puts on `ctx` for handlers. */
export type UsageContext = { usage: { count: () => Promise<number> } }

export type UsageSummary = { total: number; ops: Record<string, number> }

/**
 * A schema is anything that implements Standard Schema; a plugin should not force a schema library
 * on the apps that install it. This one carries its own JSON Schema, which is what the facets
 * advertise. With Zod (or any registered adapter) in your own plugin, `z.object({ … })` does both.
 */
const summarySchema: StandardSchemaV1<UsageSummary, UsageSummary> & {
  '~standard': { jsonSchema: { input: () => Record<string, unknown>; output: () => Record<string, unknown> } }
} = {
  '~standard': {
    version: 1,
    vendor: 'example-plugin-template',
    validate: (value: unknown) =>
      value && typeof value === 'object'
        ? { value: value as UsageSummary }
        : { issues: [{ message: 'Expected an object' }] },
    jsonSchema: {
      input: () => ({ type: 'object', properties: {} }),
      output: () => ({
        type: 'object',
        properties: { total: { type: 'integer' }, ops: { type: 'object', additionalProperties: { type: 'integer' } } },
        required: ['total', 'ops'],
      }),
    },
  },
}

export function usage(options: UsageOptions = {}) {
  const store = options.store ?? memoryUsageStore()

  const ops = {
    usage: {
      summary: op({
        description: 'How many times each operation has been called',
        output: summarySchema,
      })
        // Traits are how an op tells every facet what it is. A plugin's ops declare them like
        // any other: this one is a read, and it may declare a scope the app's `scopes()` enforces.
        .traits({ readonly: true, ...(options.scope ? { scope: options.scope } : { public: true }) })
        .handle(async () => {
          const counts = await store.read()
          return { total: Object.values(counts).reduce((a, b) => a + b, 0), ops: counts }
        }),
    },
  }

  return definePlugin<UsageContext, typeof ops>({
    name: 'usage',
    ops,

    // One hook, one stage, every facet. `after` runs once an op has answered, which is exactly
    // when a call is worth counting. A hook that decided *whether* the op ran would belong in
    // `authorize` — and would then apply to every facet at once, which is the point.
    hooks: {
      async after(inv: Invocation) {
        if (inv.op.id !== 'usage.summary') await store.increment(inv.op.id)
      },
      validate(inv) {
        inv.ctx.usage = {
          count: async () => (await store.read())[inv.op.id] ?? 0,
        }
      },
    },

    // The per-facet slot. Everything here is presentation: it finds credentials, adds endpoints of
    // its own, decorates answers and declares what the out-of-process facets should show. None of
    // it can stop an operation, and none of it is handed an `Invocation`.
    adapters: {
      rest: {
        routes: [
          {
            method: 'GET',
            path: '/summary.json',
            summary: 'Usage counts, for a scraper that does not speak the API',
            // Served at `/_usage/summary.json`: a plugin route can never shadow an op's.
            handler: async () => Response.json(await store.read()),
          },
        ],
        headers: ({ op: opId, ok }) => (ok ? { 'x-usage-op': opId } : undefined),
      },
      mcp: {
        instructions: 'Call usage_summary to see how often each tool has been used.',
      },
      cli: {
        // An alias for the op above: a plugin command runs the pipeline like everything else.
        commands: [{ command: 'usage', summary: 'How often each command has been used', op: 'usage.summary' }],
      },
    },
  })
}
