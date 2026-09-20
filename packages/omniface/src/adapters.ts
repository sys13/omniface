import type { HttpMethod } from './naming.ts'
import type { Credential } from './plugin.ts'

/**
 * The per-facet `adapters` slot: the only place a plugin may touch a facet.
 *
 * A plugin's hooks run in the pipeline, which is facet-agnostic by construction — that is the
 * whole point of the pipeline. But some plugin concerns are irreducibly per-facet: a credential
 * arrives as a header on REST, as an env var on the CLI, as a constructor option in the SDK and
 * as transport metadata on MCP. Before this slot existed, the only way to express that was to
 * fork the facet, which is exactly the drift facet exists to prevent.
 *
 * **Gate 1 still holds: an adapter may not decide whether an operation runs.** Nothing here
 * receives an {@link Invocation}, and nothing here can abort, skip, replace or re-order one.
 * A facet adapter may only:
 *
 * - *find* a credential the facet's default reader misses (what it means is still the
 *   `authenticate` stage's business — an adapter that returns a token grants nothing);
 * - *attribute* a caller, for logs and audit (metadata, never authority);
 * - *add* routes, commands, flags or options of its own, next to the ops — never in front of one;
 * - *decorate* what a facet has already decided: response headers, OpenAPI security schemes,
 *   MCP instructions.
 *
 * Anything that decides *whether* an op runs belongs in a `hooks.authorize` (or `rateLimit`, or
 * `idempotency`) hook, where it applies to every facet at once and the conformance suite can see
 * it. If a facet adapter would be a convenient place for it, that is the signal it is drift.
 */
export type FacetAdapters = {
  rest?: RestFacetAdapter
  mcp?: McpFacetAdapter
  cli?: CliFacetAdapter
  sdk?: SdkFacetAdapter
}

/** A plugin's adapters, with the plugin's name attached. `App.adapters` is a list of these. */
export type PluginAdapters = { plugin: string } & FacetAdapters

// ---------------------------------------------------------------------------------------------
// REST

export type RestRouteContext = {
  readonly request: Request
  readonly url: URL
  /** Path params of this route's own pattern (`/sessions/:id`). */
  readonly params: Record<string, string>
  readonly requestId: string
}

/**
 * An HTTP route that is not an op. It is mounted under the plugin's namespace — a route declared
 * as `/login` by a plugin named `auth` is served at `/_auth/login` — so a plugin can never shadow,
 * intercept or pre-empt an op's route. Ops are reached through the pipeline or not at all.
 */
export type RestPluginRoute = {
  method: HttpMethod | 'OPTIONS' | 'HEAD'
  /** Relative to the plugin's namespace, leading slash required. Hono patterns (`/:id`) work. */
  path: string
  summary?: string
  handler: (ctx: RestRouteContext) => Response | Promise<Response>
}

/** What the facet has already decided about one op call, for a plugin that wants to decorate it. */
export type RestResultContext = {
  readonly request: Request
  readonly op: string
  readonly requestId: string
  readonly status: number
  readonly ok: boolean
}

/** An OpenAPI 3.1 security scheme object, advertised in `components.securitySchemes`. */
export type SecurityScheme = {
  type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect' | 'mutualTLS'
  description?: string
  [key: string]: unknown
}

export type RestFacetAdapter = {
  /**
   * A credential the default reader (`Authorization: Bearer`, `X-API-Key`) does not find — a
   * session cookie, a signed query parameter. Only consulted when the default reader found none,
   * and what the credential *means* is still decided by the `authenticate` stage.
   */
  credential?: (request: Request) => Credential | undefined
  /** Extra HTTP endpoints, namespaced under `/_<plugin>`. Never ops, never in front of one. */
  routes?: readonly RestPluginRoute[]
  /** Response headers to add once an op has answered (`Set-Cookie`, `Deprecation`, …). */
  headers?: (ctx: RestResultContext) => Record<string, string> | undefined | void
  /** Advertised in the generated OpenAPI document. */
  securitySchemes?: Record<string, SecurityScheme>
}

// ---------------------------------------------------------------------------------------------
// MCP

export type McpCallContext = {
  /** Present on Streamable HTTP, absent on stdio. */
  readonly headers?: Headers
  /** What the transport knows, if anything. Stateless HTTP usually knows nothing. */
  readonly clientInfo?: { name?: string; version?: string }
  readonly transport: 'stdio' | 'http'
}

export type McpFacetAdapter = {
  /** A credential the default header reader misses. Same rule as REST: finding is not granting. */
  credential?: (ctx: McpCallContext) => Credential | undefined
  /** Who is calling, when the transport cannot say. Attribution only — it grants nothing. */
  client?: (ctx: McpCallContext) => { name?: string; version?: string } | undefined
  /** Appended to the MCP server's instructions, so a model learns what this plugin expects. */
  instructions?: string
}

// ---------------------------------------------------------------------------------------------
// CLI and SDK
//
// These two facets do not run in this process: the CLI is the shared engine plus a manifest, and
// the SDK is a client package. A plugin therefore *declares* what it adds to them and the manifest
// carries the declaration to wherever the facet runs. Everything here is JSON.

export type CliFlagSpec = {
  /** Kebab-case, without the leading dashes. May not shadow a built-in global flag. */
  name: string
  summary: string
  type?: 'string' | 'boolean'
  /** An environment variable the flag also reads. */
  env?: string
  /** A value for this flag is the caller's credential, carried as a bearer token. */
  credential?: boolean
}

/**
 * A command a plugin adds to the CLI. It names an op: a plugin's command is an alias for something
 * that goes through the pipeline, never a side door around it.
 */
export type CliCommandSpec = {
  /** Space-separated words: `whoami`, or `keys list`. */
  command: string
  summary: string
  /** The op id this command runs. Must exist in the app. */
  op: string
}

export type CliFacetAdapter = {
  flags?: readonly CliFlagSpec[]
  commands?: readonly CliCommandSpec[]
}

export type SdkOptionSpec = {
  /** camelCase constructor option. */
  name: string
  summary: string
  type?: 'string' | 'boolean' | 'number'
  /** The header the option is sent as, when it is sent as one. */
  header?: string
  /** The option carries the caller's credential. */
  credential?: boolean
}

export type SdkFacetAdapter = {
  options?: readonly SdkOptionSpec[]
}

// ---------------------------------------------------------------------------------------------
// Validation

/** Global flags the CLI engine owns. A plugin that redefines one would change existing commands. */
export const RESERVED_CLI_FLAGS = [
  'all',
  'api-key',
  'base-url',
  'help',
  'idempotency-key',
  'json',
  'output',
  'version',
  'yes',
] as const

/** Commands the CLI engine owns. */
export const RESERVED_CLI_COMMANDS = ['help', 'login', 'logout'] as const

/** SDK constructor options the client owns. */
export const RESERVED_SDK_OPTIONS = [
  'apiKey',
  'baseUrl',
  'clientName',
  'fetch',
  'headers',
  'manifest',
  'maxRetryWaitMs',
  'retries',
  'via',
] as const

/**
 * Everything checkable about an adapter before a single request arrives. Called for each plugin at
 * app creation: a plugin that would shadow a built-in flag, a reserved command or an op's route is
 * a startup error, not a surprise in production.
 */
export function adapterProblems(adapters: PluginAdapters): string[] {
  const problems: string[] = []
  const where = `plugin "${adapters.plugin}"`

  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(adapters.plugin)) {
    problems.push(`${where}: a plugin with facet adapters needs a name usable as a URL segment (its REST namespace)`)
  }

  const seenRoutes = new Set<string>()
  for (const route of adapters.rest?.routes ?? []) {
    if (!route.path.startsWith('/')) problems.push(`${where}: REST route "${route.path}" must start with "/"`)
    if (route.path.includes('..')) problems.push(`${where}: REST route "${route.path}" may not contain ".."`)
    const key = `${route.method} ${route.path}`
    if (seenRoutes.has(key)) problems.push(`${where}: REST route "${key}" is declared twice`)
    seenRoutes.add(key)
  }

  const seenFlags = new Set<string>()
  for (const flag of adapters.cli?.flags ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(flag.name)) problems.push(`${where}: CLI flag "${flag.name}" must be kebab-case, without dashes`)
    if ((RESERVED_CLI_FLAGS as readonly string[]).includes(flag.name)) {
      problems.push(`${where}: CLI flag "--${flag.name}" is a built-in global flag`)
    }
    if (seenFlags.has(flag.name)) problems.push(`${where}: CLI flag "--${flag.name}" is declared twice`)
    seenFlags.add(flag.name)
  }

  for (const command of adapters.cli?.commands ?? []) {
    const first = command.command.split(/\s+/)[0]
    if (first && (RESERVED_CLI_COMMANDS as readonly string[]).includes(first)) {
      problems.push(`${where}: CLI command "${command.command}" starts with the built-in "${first}"`)
    }
  }

  for (const option of adapters.sdk?.options ?? []) {
    if ((RESERVED_SDK_OPTIONS as readonly string[]).includes(option.name)) {
      problems.push(`${where}: SDK option "${option.name}" is a built-in client option`)
    }
  }

  return problems
}

/** The namespace a plugin's REST routes are mounted under. */
export function restNamespace(plugin: string): string {
  return `/_${plugin}`
}

/** Ask each adapter in turn for a credential. The first answer wins; none is fine. */
export function credentialFromAdapters<C>(
  adapters: readonly PluginAdapters[],
  facet: 'rest' | 'mcp',
  ctx: C,
): Credential | undefined {
  for (const a of adapters) {
    const read = facet === 'rest' ? a.rest?.credential : a.mcp?.credential
    const found = (read as ((ctx: C) => Credential | undefined) | undefined)?.(ctx)
    if (found) return found
  }
  return undefined
}
