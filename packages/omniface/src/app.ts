import { adapterProblems, type PluginAdapters } from './adapters.ts'
import { agentMayCall, type WebAgentConfig } from './agent.ts'
import { FacetError, errors, toFacetError } from './errors.ts'
import { eventSchema, type Emit, type EmittedEvent, type EventDefinition, type EventSink } from './event.ts'
import { facetModules } from './facet.ts'
import './facets/builtin.ts'
import type { OAuthResourceConfig } from './facets/oauth.ts'
import type { EventsConfig } from './facets/events.facet.ts'
import type { SecurityConfig } from './facets/security.ts'
import { stripInternal, toJSONSchema } from './jsonschema.ts'
import { conventionalCommand, type HttpMethod } from './naming.ts'
import { anonymous, createOpFactory, isOp, type FacetName, type Op, type OpFactory, type OpsTree } from './op.ts'
import { STAGES, type Credential, type HookStage, type Invocation, type Plugin, type RegisteredOp } from './plugin.ts'
import { validate } from './standard.ts'

// ---------------------------------------------------------------------------------------------
// Types

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never

type CtxOfPlugins<P extends readonly Plugin<any, any>[]> = [P[number]] extends [never]
  ? {}
  : UnionToIntersection<P[number] extends infer X ? (X extends Plugin<infer C, any> ? C : never) : never>

type OpsOfPlugins<P extends readonly Plugin<any, any>[]> = [P[number]] extends [never]
  ? {}
  : UnionToIntersection<P[number] extends infer X ? (X extends Plugin<any, infer O> ? O : never) : never>

type Depth = [never, 0, 1, 2, 3, 4, 5, 6]

/** Every op id in a tree, as a string literal union: 'tasks.create' | 'tasks.list' | … */
export type OpIds<T, Prefix extends string = '', D extends number = 6> = [D] extends [never]
  ? never
  : string extends keyof T
    ? string
    : {
        [K in keyof T & string]: T[K] extends Op<any, any> ? `${Prefix}${K}` : OpIds<T[K], `${Prefix}${K}.`, Depth[D]>
      }[keyof T & string]

export type RestOverride = { method?: HttpMethod; path?: string; status?: number }
export type RestConfig<Id extends string = string> = {
  ops?: Partial<Record<Id, RestOverride | false>>
  /**
   * CORS, CSRF and security headers. On by default, closed to cross-origin traffic until an
   * origin is named; `false` turns it off entirely. See {@link SecurityConfig}.
   */
  security?: SecurityConfig | false
}

export type McpOverride = { name?: string; description?: string; maxItems?: number }
export type McpToolGroup<Id extends string = string> = { description: string; ops: Id[] }
export type McpConfig<Id extends string = string> = {
  ops?: Partial<Record<Id, McpOverride | false>>
  /** Intent-level tools that group several ops. Grouped ops are not also listed individually. */
  tools?: Record<string, McpToolGroup<Id>>
}

export type CliOverride = { command?: string; args?: string[]; columns?: string[] }
export type CliConfig<Id extends string = string> = {
  binName?: string
  ops?: Partial<Record<Id, CliOverride | false>>
}

export type SdkConfig = { packageName?: string }

/**
 * What an app may say about one screen. Step 2–3 of the override ladder (docs/DX.md): everything
 * here is presentation over a screen the projection already derived. There is deliberately no way
 * to add a screen, a field the op does not have, or an action that is not an op — that is the
 * fence in E12, and `actions`/`then` are typed as op ids so crossing it fails `tsc`.
 */
export type WebOverride<Id extends string = string> = {
  /** The screen's heading, and how it is named in the nav. */
  title?: string
  /** The route, under the facet's mount path. `{id}` placeholders name input fields. */
  path?: string
  /** Which fields the screen shows, in this order. Must be fields the op declares. */
  fields?: string[]
  /** Per-field labels, replacing the ones derived from the field names. */
  labels?: Record<string, string>
  /** Ask before running, or stop asking. A string is the question. */
  confirm?: boolean | string
  /** Which ops appear as actions on this screen, in this order. Replaces the derived list. */
  actions?: Id[]
  /** Where a successful write lands: another op's screen, or `back` to the one it came from. */
  then?: Id | 'back'
  /** Where the screen sits in the nav. Lower first; unset sorts after everything set. */
  order?: number
  /** Keep the route, take it out of the nav. */
  hidden?: boolean
}

/**
 * The web facet: the app's declared ops as screens. Opt-in — unlike the four MVP facets it is not
 * on when `facets` is omitted, because a screen is something a person lands on and that should be
 * a decision, not a default.
 */
export type WebConfig<Id extends string = string> = {
  /** Where the screens mount. Default `/app`. */
  path?: string
  ops?: Partial<Record<Id, WebOverride<Id> | false>>
  /**
   * Offer the page's operations to the agent in the visitor's browser, over WebMCP. Absent means
   * no tool is registered and a call claiming to come from one is refused — see {@link
   * WebAgentConfig}, which is read both by what the page advertises and by what the pipeline
   * allows, so the two cannot drift.
   */
  agent?: boolean | WebAgentConfig<Id>
}

/**
 * What an app says about its facets. The five omniface ships are named here for autocomplete; a
 * facet authored elsewhere adds its own key by merging into this interface, which is why it is an
 * interface and not a type alias:
 *
 * ```ts
 * declare module 'omniface' {
 *   interface FacetsConfig { zapier?: boolean | ZapierConfig }
 * }
 * ```
 *
 * Nothing at runtime reads these keys. `normalizeFacets` walks the facet registry.
 */
export interface FacetsConfig<Id extends string = string> {
  rest?: boolean | RestConfig<Id>
  mcp?: boolean | McpConfig<Id>
  cli?: boolean | CliConfig<Id>
  sdk?: boolean | SdkConfig
  web?: boolean | WebConfig<Id>
  events?: boolean | EventsConfig
}

export type AppConfig<T extends OpsTree, Ids extends string = OpIds<T>> = {
  name: string
  version?: string
  description?: string
  ops: T
  /** Omitted: every MVP facet is on. Present: only the facets listed. */
  facets?: FacetsConfig<Ids>
  /**
   * Where a caller goes to get a credential (RFC 9728). Not under a facet, because it is not one
   * facet's answer: REST serves the document and MCP points at it, and a copy under each would be
   * two places for the same answer to be given differently. See {@link OAuthResourceConfig} — it
   * is discovery only, and omniface never becomes an authorization server.
   */
  oauth?: OAuthResourceConfig
}

export type InvokeInit = {
  facet: FacetName
  credential?: Credential
  idempotencyKey?: string
  requestId?: string
  client?: { name?: string; version?: string }
  /** The raw request headers, when the facet has any. Auth adapters read cookie sessions from here. */
  headers?: Headers
}

/**
 * The app's facet configs, keyed by facet name — each facet's own `normalize` decides what its
 * value means, and `null` is off. Open, like everything else keyed by facet name: a facet reads
 * its slot back with a cast it owns, and nothing else looks inside.
 */
export type NormalizedFacets = Record<string, any>

export interface App<T extends OpsTree = OpsTree> {
  readonly kind: 'omniface.app'
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly ops: ReadonlyMap<string, RegisteredOp>
  readonly plugins: readonly Plugin<any, any>[]
  /** Per-facet adapters contributed by plugins, in install order. Facets read them; ops do not. */
  readonly adapters: readonly PluginAdapters[]
  readonly facets: NormalizedFacets
  /** The app's protected-resource declaration, when it named an authorization server. */
  readonly oauth?: OAuthResourceConfig
  /** Run one op through the full pipeline. Every facet calls this; nothing else runs handlers. */
  invoke(id: string, rawInput: unknown, init: InvokeInit): Promise<unknown>
  /**
   * Receive every event the app's ops emit, whichever facet the call came in on. Returns the
   * function that stops it.
   *
   * This is the in-process sink, and it is the only one that exists today. A webhook sender, an
   * SSE stream and a queue producer are each a story of their own (`docs/BACKLOG.md` 9.2, 9.3,
   * 9.6); what this settles is that none of them re-declares the event, because there is one
   * place an event is declared and it is the op.
   */
  subscribe(sink: EventSink): () => void
  /** Type-only: the op tree, for inferred clients. */
  readonly '~ops'?: T
}

export interface Facet<Ctx, PluginOps extends OpsTree> {
  readonly op: OpFactory<Ctx>
  readonly plugins: readonly Plugin<any, any>[]
  /** Override keys may name the app's ops and every plugin-contributed op. */
  app<const T extends OpsTree>(config: AppConfig<T, OpIds<T & PluginOps>>): App<T & PluginOps>
}

// ---------------------------------------------------------------------------------------------
// facet() and app()

export function facet(): Facet<{}, {}>
export function facet<const P extends readonly Plugin<any, any>[]>(config: {
  plugins: P
}): Facet<CtxOfPlugins<P>, OpsOfPlugins<P> extends OpsTree ? OpsOfPlugins<P> : {}>
export function facet(config: { plugins?: readonly Plugin<any, any>[] } = {}): Facet<any, any> {
  const plugins = config.plugins ?? []
  const seen = new Set<string>()
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) throw new Error(`facet: plugin "${plugin.name}" is installed twice`)
    for (const req of plugin.requires ?? []) {
      if (!seen.has(req)) {
        throw new Error(`facet: plugin "${plugin.name}" requires "${req}" to be installed before it`)
      }
    }
    seen.add(plugin.name)
  }
  return {
    op: createOpFactory(),
    plugins,
    app: (appConfig) => createApp(appConfig, plugins) as any,
  }
}

function flatten(tree: OpsTree, source: string, prefix: string[], out: Map<string, RegisteredOp>): void {
  for (const [key, value] of Object.entries(tree)) {
    const path = [...prefix, key]
    const id = path.join('.')
    if (isOp(value)) {
      if (out.has(id)) {
        throw new Error(`facet: op "${id}" from ${source} collides with one from ${out.get(id)!.source}`)
      }
      out.set(id, {
        id,
        path,
        op: value,
        inputSchema: toJSONSchema(value.input, 'input'),
        outputSchema: toJSONSchema(value.output, 'output'),
        source,
      })
    } else if (value && typeof value === 'object') {
      flatten(value as OpsTree, source, path, out)
    }
  }
}

/**
 * What the app wrote, asked of each registered facet in turn. Omitting `facets` entirely gives
 * every facet its `defaultOn` answer — which is on for the four MVP facets and off for `web`,
 * because a screen is something a person lands on. See {@link WebConfig}.
 */
function normalizeFacets(facets: FacetsConfig | undefined): NormalizedFacets {
  const out: NormalizedFacets = {}
  for (const module of facetModules()) {
    const written = facets ? (facets as Record<string, unknown>)[module.name] : module.defaultOn
    out[module.name] = module.normalize(written)
  }
  return out
}

/**
 * Every op id a facet's config names has to exist. Each facet says which keys of its own config
 * are op ids (`references`) and what else it needs true (`check`); this walks the registry and
 * asks, so a typo in a new facet's override key is caught by the same message as a typo in
 * `rest.ops`.
 */
function checkOverrides(ops: ReadonlyMap<string, RegisteredOp>, facets: NormalizedFacets, name: string): void {
  const unknown: string[] = []
  for (const module of facetModules()) {
    const config = facets[module.name]
    if (config == null) continue
    for (const { where, ids } of module.references?.(config) ?? []) {
      for (const id of ids) if (!ops.has(id)) unknown.push(`${where}: "${id}"`)
    }
    module.check?.(config, ops, { name })
  }
  if (unknown.length) throw new Error(`facet: overrides reference unknown ops: ${unknown.join(', ')}`)
}

function collectAdapters(
  ops: ReadonlyMap<string, RegisteredOp>,
  plugins: readonly Plugin<any, any>[],
  facets: NormalizedFacets,
): PluginAdapters[] {
  const collected = plugins.flatMap((p) => (p.adapters ? [{ plugin: p.name, ...p.adapters }] : []))
  const problems = collected.flatMap(adapterProblems)

  // What each plugin declares is checked on its own by `adapterProblems`; what two plugins declare
  // *together* can only be checked here. A name that resolves to two things is drift by definition,
  // and on the CLI and the SDK it would surface in another process, far from the cause.
  const cliCommands = new Map<string, string>()
  for (const [id, reg] of ops) {
    if (!facets['cli']) break
    const override = (facets['cli'] as CliConfig).ops?.[id]
    if (override === false) continue
    const command = override?.command ? override.command.split(/\s+/) : conventionalCommand(reg.path)
    cliCommands.set(command.join(' '), `op "${id}"`)
  }
  const cliFlags = new Map<string, string>()
  const sdkOptions = new Map<string, string>()
  const claim = (taken: Map<string, string>, key: string, owner: string, what: string) => {
    const already = taken.get(key)
    if (already) problems.push(`${owner}: ${what} is already ${already}`)
    else taken.set(key, owner)
  }

  for (const adapters of collected) {
    const owner = `plugin "${adapters.plugin}"`
    // A CLI command a plugin contributes is an alias for an op, so the op has to exist. Checked
    // here rather than at first use: the CLI runs from a manifest, in another process.
    for (const command of adapters.cli?.commands ?? []) {
      if (!ops.has(command.op)) problems.push(`${owner}: CLI command "${command.command}" names unknown op "${command.op}"`)
      claim(cliCommands, command.command, owner, `the CLI command "${command.command}"`)
    }
    for (const flag of adapters.cli?.flags ?? []) claim(cliFlags, flag.name, owner, `the CLI flag "--${flag.name}"`)
    for (const option of adapters.sdk?.options ?? []) claim(sdkOptions, option.name, owner, `the SDK option "${option.name}"`)
  }

  if (problems.length) throw new Error(`facet: invalid plugin facet adapters:\n- ${problems.join('\n- ')}`)
  return collected
}

let requestCounter = 0
function newRequestId(): string {
  requestCounter = (requestCounter + 1) % 1e9
  return `req_${Date.now().toString(36)}${requestCounter.toString(36)}`
}

function createApp<T extends OpsTree>(config: AppConfig<T, string>, plugins: readonly Plugin<any, any>[]): App<T> {
  const ops = new Map<string, RegisteredOp>()
  flatten(config.ops, 'app', [], ops)
  for (const plugin of plugins) if (plugin.ops) flatten(plugin.ops, `plugin "${plugin.name}"`, [], ops)
  const facets = normalizeFacets(config.facets as FacetsConfig | undefined)
  checkOverrides(ops, facets, config.name)
  const adapters = collectAdapters(ops, plugins, facets)
  // Gate 1: a declared scope nobody enforces is a silent hole on every facet. Refuse to start.
  const scoped = [...ops.values()].filter((r) => r.op.traits.scope).map((r) => r.id)
  if (scoped.length && !plugins.some((p) => p.hooks?.authorize)) {
    throw new Error(
      `facet: ops declare scopes (${scoped.join(', ')}) but no plugin enforces them. Add scopes() to plugins.`,
    )
  }

  const sinks = new Set<EventSink>()

  const hooksFor = (stage: HookStage) =>
    plugins.flatMap((p) => (p.hooks?.[stage] ? [p.hooks[stage]!] : []))
  const hooks = Object.fromEntries(
    STAGES.filter((s): s is HookStage => s !== 'handle').map((s) => [s, hooksFor(s)]),
  ) as Record<HookStage, ReturnType<typeof hooksFor>>
  const wraps = plugins.filter((p) => p.wrap)

  async function invoke(id: string, rawInput: unknown, init: InvokeInit): Promise<unknown> {
    const registered = ops.get(id)
    if (!registered) throw errors.notFound(`Unknown operation "${id}"`)
    const { op } = registered
    if (op.traits.internal && init.facet !== 'internal') throw errors.notFound(`Unknown operation "${id}"`)

    let responded = false
    // What the handler asked to emit, in order, before it has been validated. An event is checked
    // once the handler has returned rather than at the `emit()` call, so a handler that emits and
    // then throws emits nothing: the work did not happen, and neither did the event.
    const pending: { event: EventDefinition; payload: unknown }[] = []
    const emitted: EmittedEvent[] = []
    const emit: Emit = (event, payload) => {
      if (!op.emits.some((declared) => declared.name === event.name)) {
        throw errors.internal(`Operation "${id}" emitted "${event.name}", which it does not declare`)
      }
      pending.push({ event, payload })
    }

    const inv: Invocation = {
      requestId: init.requestId ?? newRequestId(),
      facet: init.facet,
      op: registered,
      credential: init.credential,
      idempotencyKey: init.idempotencyKey,
      client: init.client,
      headers: init.headers,
      startedAt: Date.now(),
      rawInput,
      input: undefined,
      principal: anonymous,
      ctx: {},
      emitted,
      output: undefined,
      respond(output) {
        responded = true
        inv.output = output
      },
      get responded() {
        return responded
      },
    }

    const runStage = async (stage: HookStage) => {
      for (const hook of hooks[stage]) {
        if (responded) return
        await hook(inv)
      }
    }

    const pipeline = async (): Promise<unknown> => {
      await runStage('authenticate')
      await runStage('resolveTenant')
      await runStage('rateLimit')

      const parsed = await validate(op.input, inv.rawInput ?? undefined)
      if (!parsed.ok) {
        const summary = parsed.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
        throw errors.invalidInput(summary, parsed.issues)
      }
      inv.input = parsed.value
      await runStage('validate')

      // The app's declaration about browser agents, enforced where it cannot be talked around
      // (docs/BACKLOG.md 12.7). `facet` here is a claim the caller made — it can narrow what is
      // allowed and never widen it, which is why this only ever refuses.
      if (inv.facet === 'webmcp' && !agentMayCall(facets['web'], id, registered.op.traits)) {
        throw errors.forbidden(`"${id}" is not offered to browser agents`)
      }
      await runStage('authorize')
      await runStage('idempotency')

      if (!responded) {
        const raw = await op.handler({
          input: inv.input,
          ctx: inv.ctx,
          principal: inv.principal,
          facet: inv.facet,
          requestId: inv.requestId,
          emit,
        })
        const checked = await validate(op.output, raw)
        if (!checked.ok) {
          throw errors.internal(`Operation "${id}" returned output that does not match its schema`, checked.issues)
        }
        inv.output = stripInternal(checked.value, registered.outputSchema)

        // An event is checked against its declared schema for the same reason the output is: the
        // declaration is what every transport advertises, and a payload that does not match it is
        // a promise the app is breaking to a consumer that cannot see the handler.
        for (const { event, payload } of pending) {
          const schema = eventSchema(event)
          const valid = await validate(event.payload, payload)
          if (!valid.ok) {
            throw errors.internal(
              `Operation "${id}" emitted "${event.name}" with a payload that does not match its schema`,
              valid.issues,
            )
          }
          emitted.push({
            event: event.name,
            op: id,
            requestId: inv.requestId,
            at: Date.now(),
            payload: stripInternal(valid.value, schema),
          })
        }
      }
      await runStage('after')
      // Delivered after the hooks, so an event a plugin can see is one that actually happened.
      for (const event of emitted) for (const sink of sinks) await sink(event)
      return inv.output
    }

    const run = wraps.reduceRight<() => Promise<unknown>>(
      (next, plugin) => () => plugin.wrap!(inv, next),
      async () => {
        try {
          return await pipeline()
        } catch (err) {
          throw toFacetError(err)
        }
      },
    )
    try {
      return await run()
    } catch (err) {
      throw toFacetError(err)
    }
  }

  return {
    kind: 'omniface.app',
    name: config.name,
    version: config.version ?? '0.0.0',
    description: config.description,
    ops,
    plugins,
    adapters,
    facets,
    ...(config.oauth ? { oauth: config.oauth } : {}),
    invoke,
    subscribe(sink) {
      sinks.add(sink)
      return () => sinks.delete(sink)
    },
  }
}

export { FacetError }
