import { STAGES, adapterProblems, buildManifest, createServer, facet, restNamespace, type App, type Manifest, type Plugin } from 'omniface'
import { CHANNELS, createHarness, outcomesAgree, type Channel, type Outcome } from './harness.ts'
import { createSampleApp } from './sample-app.ts'

/**
 * Conformance for a plugin, not for an app.
 *
 * A plugin is the one thing in facet that can quietly break every facet at once: it fills pipeline
 * stages every call goes through, it contributes ops that must project like any other, and — since
 * backlog 3.1 — it may reach into a facet through its `adapters` slot. These are the cases that say
 * what "behaves" means, run against a sample app on every facet, so a plugin written outside this
 * repo can prove itself before anyone installs it:
 *
 * ```ts
 * for (const c of pluginCases({ plugin: () => myPlugin() })) {
 *   it(c.name, async () => expect(await c.run()).toEqual([]))
 * }
 * ```
 *
 * What it cannot check is what the plugin is *for*: that is the plugin's own tests. What it checks
 * is that being installed does not change what facet promises — every facet still agrees, ops still
 * project, and nothing in the `adapters` slot has been used to decide whether an operation runs.
 */

export type PluginConformanceOptions = {
  /** A fresh plugin instance per case: one case's state can never reach another's. */
  plugin: () => Plugin<any, any>
  /** Plugins installed before it, in order — whatever its `requires` names. */
  before?: () => Plugin<any, any>[]
  /** The app to try it against. Default: the sample app shipped with this package. */
  app?: (plugins: Plugin<any, any>[]) => App
  /** A credential the plugin accepts, if it authenticates. Some cases need one. */
  apiKey?: string
  /**
   * The plugin refuses anonymous callers (it is an auth plugin). Cases that would otherwise read
   * that refusal as a regression expect it instead.
   */
  deniesAnonymous?: boolean
  /** A scope every sample op declares, for a plugin that authorizes. Implies `apiKey`. */
  scope?: string
}

export type PluginCase = {
  /** `my-plugin · every facet agrees` — use it as the test name. */
  name: string
  /** Empty means the plugin conformed. Each entry is one human-readable problem. */
  run: () => Promise<string[]>
}

// ---------------------------------------------------------------------------------------------
// Building the app under test

type Built = { app: App; manifest: Manifest }

function build(options: PluginConformanceOptions, withPlugin: boolean): Built {
  const plugins = [...(options.before?.() ?? []), ...(withPlugin ? [options.plugin()] : [])]
  const app = options.app
    ? options.app(plugins)
    : createSampleApp(plugins, options.scope ? { scope: options.scope } : {})
  return { app, manifest: buildManifest(app) }
}

/** The ops the app itself declares, as opposed to the ones any plugin contributes. */
function appOps(manifest: Manifest): string[] {
  return manifest.ops.filter((o) => o.source === 'app').map((o) => o.id)
}

function contributedOps(manifest: Manifest, pluginName: string): string[] {
  return manifest.ops.filter((o) => o.source === `plugin "${pluginName}"`).map((o) => o.id)
}

/** Inputs the kit can supply without knowing the app: none required, or an id that exists. */
function sampleInput(manifest: Manifest, id: string): Record<string, unknown> | undefined {
  const op = manifest.ops.find((o) => o.id === id)
  if (!op) return undefined
  const required = (op.input.required ?? []) as string[]
  if (!required.length) return {}
  if (required.length === 1 && required[0] === 'id') return { id: 'item_1' }
  return undefined
}

const describeOutcome = (outcome: Outcome) => (outcome.ok ? 'ok' : outcome.code)

/**
 * One op on every facet it reaches. A read shares one app, so the facets can be compared on
 * values; a write gets a fresh app per facet, because "delete it four times" is not a drift test —
 * the first facet would win and the other three would rightly answer `not_found`.
 */
async function callEveryFacet(
  options: PluginConformanceOptions,
  id: string,
  input: Record<string, unknown>,
  apiKey: string | undefined,
): Promise<Partial<Record<Channel, Outcome>>> {
  const shared = createHarness(build(options, true).app, { apiKey: options.apiKey })
  const op = shared.manifest.ops.find((o) => o.id === id)
  const readonly = Boolean(op?.traits.readonly)
  if (readonly) return shared.callAll(id, input, { apiKey })
  const outcomes: Partial<Record<Channel, Outcome>> = {}
  for (const channel of shared.channelsFor(id)) {
    const harness = createHarness(build(options, true).app, { apiKey: options.apiKey })
    outcomes[channel] = await harness.call(channel, id, input, { apiKey })
  }
  return outcomes
}

// ---------------------------------------------------------------------------------------------
// Cases

export function pluginCases(options: PluginConformanceOptions): PluginCase[] {
  const plugin = options.plugin()
  const name = plugin.name
  const cases: PluginCase[] = []
  const add = (label: string, run: () => Promise<string[]>) =>
    cases.push({
      name: `${name} · ${label}`,
      // One case that cannot even be driven is a finding, not a crashed suite.
      run: async () => {
        try {
          return await run()
        } catch (err) {
          return [`could not run: ${err instanceof Error ? err.message : String(err)}`]
        }
      },
    })

  add('installs, and the app still projects to every facet', async () => {
    const { manifest } = build(options, true)
    const problems: string[] = []
    for (const facetName of ['rest', 'mcp', 'cli', 'sdk'] as const) {
      if (!manifest.facets[facetName]) problems.push(`the ${facetName} facet disappeared once the plugin was installed`)
    }
    if (!manifest.ops.length) problems.push('the app has no ops left')
    return problems
  })

  add('is shaped like a plugin', async () => {
    const problems: string[] = []
    if (!plugin.name || /\s/.test(plugin.name)) problems.push(`"${plugin.name}" is not a usable plugin name`)
    for (const stage of Object.keys(plugin.hooks ?? {})) {
      if (!(STAGES as readonly string[]).includes(stage)) problems.push(`hooks.${stage} is not a pipeline stage`)
      if (stage === 'handle') problems.push('a plugin may not fill the `handle` stage; that is the op\'s')
    }
    if (plugin.adapters) problems.push(...adapterProblems({ plugin: plugin.name, ...plugin.adapters }))
    return problems
  })

  add('refuses to be installed twice', async () => {
    try {
      facet({ plugins: [...(options.before?.() ?? []), options.plugin(), options.plugin()] })
      return ['installing the plugin twice was accepted; plugin names must be unique']
    } catch {
      return []
    }
  })

  if ((plugin.requires ?? []).length) {
    add('says what it requires, and is refused without it', async () => {
      try {
        facet({ plugins: [options.plugin()] })
        return [`installs with none of ${plugin.requires!.join(', ')} present`]
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return plugin.requires!.some((r) => message.includes(r)) ? [] : [`the refusal does not name what is missing: ${message}`]
      }
    })
  }

  add('every facet agrees on every op', async () => {
    const { manifest } = build(options, true)
    const problems: string[] = []
    for (const id of manifest.ops.map((o) => o.id)) {
      const input = sampleInput(manifest, id)
      if (!input) continue
      const outcomes = await callEveryFacet(options, id, input, options.apiKey)
      problems.push(...outcomesAgree(outcomes, { compareValues: false }).map((p) => `${id}: ${p}`))
    }
    return problems
  })

  // Transparency: installing a plugin must not change what an app that does not use it answers.
  // An auth plugin legitimately does change it, which is what `deniesAnonymous` says.
  // Skipped when the sample app declares a scope: an app whose ops nobody can authorize does not
  // start at all (Gate 1), so there is no "without the plugin" to compare against.
  if (!options.scope && (!options.deniesAnonymous || options.apiKey)) {
    add('leaves the app\'s own answers alone', async () => {
      const withPlugin = build(options, true)
      const problems: string[] = []
      for (const id of appOps(withPlugin.manifest)) {
        const input = sampleInput(withPlugin.manifest, id)
        if (!input) continue
        const before = createHarness(build(options, false).app)
        const after = createHarness(build(options, true).app, { apiKey: options.apiKey })
        for (const channel of after.channelsFor(id)) {
          const baseline = await before.call(channel, id, input, { apiKey: undefined })
          const actual = await after.call(channel, id, input, { apiKey: options.apiKey })
          if (describeOutcome(baseline) !== describeOutcome(actual)) {
            problems.push(`${id} on ${channel}: ${describeOutcome(actual)} with the plugin, ${describeOutcome(baseline)} without it`)
          }
        }
      }
      return problems
    })
  }

  if (options.deniesAnonymous) {
    add('refuses an anonymous caller the same way on every facet', async () => {
      const { manifest } = build(options, true)
      const problems: string[] = []
      for (const id of appOps(manifest)) {
        const op = manifest.ops.find((o) => o.id === id)!
        // A `public` op is declared open on purpose; refusing it would be the bug.
        if (op.traits.public) continue
        const input = sampleInput(manifest, id)
        if (!input) continue
        const outcomes = await callEveryFacet(options, id, input, undefined)
        problems.push(...outcomesAgree(outcomes, { compareValues: false }).map((p) => `${id}: ${p}`))
        for (const [channel, outcome] of Object.entries(outcomes) as [Channel, Outcome][]) {
          if (outcome.ok) problems.push(`${id} on ${channel}: answered an anonymous caller`)
        }
      }
      return problems
    })
  }

  add('projects the ops it contributes onto every facet', async () => {
    const { manifest } = build(options, true)
    const problems: string[] = []
    for (const id of contributedOps(manifest, name)) {
      const op = manifest.ops.find((o) => o.id === id)!
      for (const facetName of CHANNELS) {
        const bound = facetName === 'sdk' ? op.sdk : op[facetName]
        if (manifest.facets[facetName] && !bound) problems.push(`${id} has no ${facetName} binding`)
      }
      const input = sampleInput(manifest, id)
      if (!input) continue
      const outcomes = await callEveryFacet(options, id, input, options.apiKey)
      problems.push(...outcomesAgree(outcomes, { compareValues: false }).map((p) => `${id}: ${p}`))
    }
    return problems
  })

  if (plugin.adapters) {
    add('stays inside the adapters slot', async () => {
      const { app, manifest } = build(options, true)
      const problems: string[] = []
      const declared = manifest.adapters.find((a) => a.plugin === name)
      const routes = plugin.adapters!.rest?.routes ?? []

      if (routes.length && !declared?.rest?.routes.length) problems.push('REST routes are missing from the manifest')
      for (const route of declared?.rest?.routes ?? []) {
        if (!route.path.startsWith(`${restNamespace(name)}/`)) {
          problems.push(`route ${route.method} ${route.path} is outside the plugin namespace ${restNamespace(name)}`)
        }
        const shadowed = manifest.ops.find((o) => o.rest?.path === route.path)
        if (shadowed) problems.push(`route ${route.method} ${route.path} shadows the op ${shadowed.id}`)
      }

      // Gate 1, checked rather than assumed: an op still answers as itself with the plugin's
      // routes mounted alongside it.
      const server = createServer(app)
      for (const route of declared?.rest?.routes ?? []) {
        const res = await server.fetch(new Request(`http://facet.test${route.path.replace(/:[^/]+/g, 'x')}`, { method: route.method }))
        if (res.status === 404) problems.push(`route ${route.method} ${route.path} is declared but not mounted`)
      }

      for (const command of plugin.adapters!.cli?.commands ?? []) {
        const op = manifest.ops.find((o) => o.id === command.op)
        if (!op) problems.push(`CLI command "${command.command}" names the unknown op ${command.op}`)
        else if (manifest.facets.cli && !op.cli) problems.push(`CLI command "${command.command}" names ${op.id}, which has no CLI binding`)
      }
      return problems
    })
  }

  return cases
}

/** Run every case and return only the failures. For a one-shot check outside a test runner. */
export async function runPluginConformance(
  options: PluginConformanceOptions,
): Promise<{ name: string; problems: string[] }[]> {
  const failures: { name: string; problems: string[] }[] = []
  for (const c of pluginCases(options)) {
    const problems = await c.run()
    if (problems.length) failures.push({ name: c.name, problems })
  }
  return failures
}
