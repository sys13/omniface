import type { FacetAdapters } from './adapters.ts'
import type { FacetName, Op, OpsTree, Principal } from './op.ts'
import type { JSONSchema } from './jsonschema.ts'

/** Named pipeline stages, in order. Facets decode before and encode after; they never skip a stage. */
export const STAGES = [
  'authenticate',
  'resolveTenant',
  'rateLimit',
  'validate',
  'authorize',
  'idempotency',
  'handle',
  'after',
] as const

export type Stage = (typeof STAGES)[number]
export type HookStage = Exclude<Stage, 'handle'>

export type Credential = { type: 'bearer'; token: string }

export type RegisteredOp = {
  /** Dotted id: `tasks.create`. */
  id: string
  path: string[]
  op: Op
  inputSchema: JSONSchema
  outputSchema: JSONSchema
  /** Where the op came from: 'app' or a plugin name. */
  source: string
}

export interface Invocation {
  readonly requestId: string
  readonly facet: FacetName
  readonly op: RegisteredOp
  readonly credential?: Credential
  readonly idempotencyKey?: string
  /** Who is calling, as the facet knows it (MCP clientInfo, CLI version, SDK user agent). */
  readonly client?: { name?: string; version?: string }
  /**
   * The raw request headers, on facets that have them (REST, MCP over HTTP). Absent on stdio MCP
   * and in-process calls, so anything that reads them must also work without them.
   */
  readonly headers?: Headers
  readonly startedAt: number
  rawInput: unknown
  input: unknown
  principal: Principal
  /** Plugin-contributed context, visible to handlers as `ctx`. */
  ctx: Record<string, unknown>
  /** Set by a hook to answer without running the handler (e.g. an idempotency replay). */
  respond(output: unknown): void
  readonly responded: boolean
  output: unknown
}

export type Hook = (inv: Invocation) => void | Promise<void>

export interface Plugin<Ctx extends object = {}, Ops extends OpsTree = {}> {
  name: string
  /** Plugin names that must also be installed, earlier in the list. */
  requires?: string[]
  hooks?: Partial<Record<HookStage, Hook>>
  /** Runs around the whole pipeline (logging, tracing, audit). Earlier plugins wrap later ones. */
  wrap?: (inv: Invocation, next: () => Promise<unknown>) => Promise<unknown>
  /** Operations this plugin contributes; projected onto every facet like any other op. */
  ops?: Ops
  /**
   * Per-facet presentation: the only place a plugin may touch a facet, and still barred from
   * deciding whether an operation runs. See {@link FacetAdapters}.
   */
  adapters?: FacetAdapters
  /** Op trait keys this plugin reads, for docs and the inspector. */
  traits?: string[]
  /** Type-only: the context this plugin adds to handlers. */
  readonly '~ctx'?: Ctx
}

export function definePlugin<Ctx extends object = {}, Ops extends OpsTree = {}>(plugin: Plugin<Ctx, Ops>): Plugin<Ctx, Ops> {
  return plugin
}
