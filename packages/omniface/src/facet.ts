import type { App, NormalizedFacets } from './app.ts'
import type { JSONSchema } from './jsonschema.ts'
import type { Manifest, ManifestOp } from './manifest.ts'
import type { RegisteredOp } from './plugin.ts'
import type { OpTraits } from './traits.ts'

/**
 * A facet is a module, not a set of keys.
 *
 * Before this contract existed, adding a facet meant editing six files: a key on `ManifestOp`, a
 * boolean beside it, a branch in the manifest builder, a branch in `inspect`, a block of rules in
 * `diff`, a line in `build`, and a projection check in the conformance suite. None of those edits
 * was hard. That was the problem — they were mechanical, and they were mechanical every time.
 *
 * What a facet declares here is what those six files used to hardcode:
 *
 * - `project` — given an op, what this facet does with it, or `null` if it does not reach the op.
 *   The manifest's per-op record is keyed by facet name and filled from this, so a facet's view of
 *   an op is authored in one place instead of typed into a struct.
 * - `diff` and `diffSettings` — given two projections, what changed and whether it breaks *this*
 *   facet. `omniface diff` keeps answering per facet without a rule per facet in `diff.ts`.
 * - `present` — one line for `llms.txt` and one card in the inspector, so a facet reaches the docs
 *   and the inspector by landing rather than by being taught about.
 * - `contract` — what the generated conformance suite checks about this facet's projection.
 * - `serve` — only for facets that are served. `sdk` and `cli` have none and never will: a facet
 *   projects and presents, and a facet that is not a server is not a second-class facet.
 *
 * What a facet may *not* do is reach the invocation. The `adapters` rule holds unchanged — a facet
 * decides how an op is described and addressed, never whether it runs.
 */

/**
 * - `breaking` — a caller that worked against `before` can stop working.
 * - `additive` — new surface; every existing caller keeps working.
 * - `neutral` — visible in the manifest, but no caller can tell (help text, descriptions, hints).
 */
export type ChangeLevel = 'breaking' | 'additive' | 'neutral'

/** One thing a facet noticed between two versions of itself. `diff.ts` adds the op and facet name. */
export type FacetChange = {
  level: ChangeLevel
  /** Stable rule id, so CI can allow one class of change without allowing all of them. */
  rule: string
  message: string
  /** Why it breaks, or what to do instead. Printed indented under the message. */
  detail?: string
}

/** What `project` is handed: the op, and the public schemas every facet advertises. */
export type ProjectionContext = {
  app: App
  op: RegisteredOp
  /** `publicSchema(op.input)` — internal fields already stripped. */
  input: JSONSchema
  output: JSONSchema
  /** The row schema of a collection output (`{ items: [...] }`), when the op returns one. */
  row?: JSONSchema
}

/** What `present` is handed, once the whole manifest exists. */
export type PresentationContext = {
  manifest: Manifest
  op: ManifestOp
  /** A synthesized example input, for the snippet. */
  example: Record<string, unknown>
}

/**
 * How one facet shows one op. The inspector renders a card from this and `llms.txt` takes the
 * line, so both are generic over the registry: a facet appears in each by returning one of these.
 */
export type FacetPresentation = {
  /** Card heading in the inspector, and the label in `omniface inspect`. */
  label: string
  /** One cell in `omniface inspect`'s table: the shortest thing that identifies the op here. */
  short?: string
  /** What you would run, open or write. Shown as a code block. */
  snippet?: string
  /** What `llms.txt` says about this op on this facet. One line, already formatted. */
  line?: string
  /** Anything else worth exposing as data — the MCP tool, the screen, the URL. */
  detail?: Record<string, unknown>
}

/** What `contract` is handed: everything the check can see without calling anything. */
export type ContractContext = {
  app: App
  manifest: Manifest
  op: ManifestOp
  /** Every other op in the manifest, for collision checks. */
  others: ManifestOp[]
}

export type FacetServer = {
  /**
   * Where this facet mounts in the HTTP server. Lower mounts first, and Hono matches in
   * registration order, so the first mount wins a tie. A screen route and a REST route can be the
   * same route; the screen wins.
   *
   * Not `FacetModule.order`, which is display order and asks a different question.
   */
  mountOrder?: number
  /**
   * `security` has one value on purpose. `createServer` mounts CORS, CSRF and the security
   * headers once at the root, before any facet, and hands every facet `false` to say so. A facet
   * that applies security of its own reads the flag and defers; one that does not can ignore it.
   * There is no value that means "mount it again", because the root mount already covers you.
   */
  create(app: App, manifest: Manifest, options: { security: false }): unknown
}

export type FacetModule<Config = any, Projection = any, Settings = any> = {
  /** The key this facet is known by, in `facets` config, in the manifest and in a diff report. */
  name: string

  /**
   * Where this facet sorts in the manifest, a diff report and the inspector — display order, not
   * mount order, which is `serve.mountOrder`. Lower first; a facet that does not ask sorts after
   * everything that does, in registration order.
   *
   * It exists because registration order is not stable: a facet module is registered whenever it
   * is first imported, and which import wins depends on the entry point. The five omniface ships
   * claim 0–4 so their output reads the same however the program was started.
   */
  order?: number

  /** On when the app says nothing about facets at all. The web facet is not; the four MVP ones are. */
  defaultOn: boolean

  /** What the app wrote under `facets.<name>`, as this facet's config. `null` means off. */
  normalize(value: unknown): Config | null

  /** Op ids this facet's config names, so a typo in an override key is caught at `app()`. */
  references?(config: Config): { where: string; ids: string[] }[]

  /** Anything else the config must satisfy against the app's ops. Throw with a `facet:` message. */
  check?(config: Config, ops: ReadonlyMap<string, RegisteredOp>, app: { name: string }): void

  /** Given an op, what this facet does with it. `null` means the facet does not reach this op. */
  project(ctx: ProjectionContext, config: Config): Projection | null

  /** What the manifest carries app-wide for this facet: a bin name, a mount path, a tool list. */
  settings?(app: App, config: Config, ops: ManifestOp[]): Settings

  /**
   * What an op trait or a schema type name means *here*. `diff.ts` asks this instead of naming
   * facets: the CLI reads `destructive` as "confirm first", so turning it on breaks CLI scripts
   * while REST only gains a hint.
   */
  observes?: {
    /** Traits a caller can observe as behaviour on this facet. */
    traits?: readonly (keyof OpTraits)[]
    /** The facet publishes schema type names under their own name, so a rename is breaking. */
    typeNames?: boolean
  }

  /** What changed between two projections of the same op, and whether it breaks this facet. */
  diff?(before: Projection, after: Projection, ctx: { op: string }): FacetChange[]

  /** What changed app-wide for this facet. Called only when the facet is on in both versions. */
  diffSettings?(before: Settings, after: Settings): FacetChange[]

  /** One card in the inspector and one line in `llms.txt`. */
  present?(ctx: PresentationContext, projection: Projection): FacetPresentation | null

  /** How `llms.txt` introduces the facet when it is on. `a CLI`, `an MCP server (/mcp)`. */
  summary?(settings: Settings): string

  /** What the generated conformance suite checks about this projection, without calling anything. */
  contract?(ctx: ContractContext, projection: Projection | null): string[]

  /** Only facets that are served have one. */
  serve?: FacetServer
}

// ---------------------------------------------------------------------------------------------
// The registry
//
// A facet registers itself when its module is first imported, which is not an order anything
// should depend on — so what a reader sees is `order`, and registration only breaks ties.

const registry = new Map<string, FacetModule>()

/** Keys `ManifestOp` already uses. A facet named one of these would shadow the op's own data. */
const RESERVED = new Set(['id', 'path', 'description', 'traits', 'errors', 'input', 'output', 'source', 'facets'])

/** Typed identity, so a facet module is checked against the contract where it is written. */
export function defineFacet<Config, Projection, Settings = never>(
  module: FacetModule<Config, Projection, Settings>,
): FacetModule<Config, Projection, Settings> {
  return module
}

export function registerFacet(module: FacetModule<any, any, any>): void {
  if (!/^[a-z][a-z0-9-]*$/.test(module.name)) {
    throw new Error(`facet: facet name "${module.name}" must be lowercase kebab-case`)
  }
  if (RESERVED.has(module.name)) throw new Error(`facet: "${module.name}" is a reserved manifest key`)
  const existing = registry.get(module.name)
  if (existing && existing !== module) throw new Error(`facet: facet "${module.name}" is registered twice`)
  registry.set(module.name, module)
}

/** Every registered facet, by `order` and then by registration. */
export function facetModules(): FacetModule[] {
  return [...registry.values()]
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (a.m.order ?? Number.MAX_SAFE_INTEGER) - (b.m.order ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
    .map((x) => x.m)
}

export function facetModule(name: string): FacetModule | undefined {
  return registry.get(name)
}

/** The facet names an app has turned on, in registration order. */
export function enabledFacets(facets: NormalizedFacets): string[] {
  return facetModules()
    .map((m) => m.name)
    .filter((name) => facets[name] != null)
}

// ---------------------------------------------------------------------------------------------
// Reading the open records
//
// The manifest's per-op and app-level facet records are `Record<string, unknown>`, because their
// keys come from the registry rather than from a struct. A facet reads its own slot back with a
// typed accessor it exports itself — `restOf(op)`, `cliSettings(manifest)` — and these two helpers
// are what those accessors are made of.

/** This facet's view of one op, or `null` if it does not reach it. */
export function projectionOf<T>(op: ManifestOp, facet: string): T | null {
  return (op.facets[facet] ?? null) as T | null
}

/** What the manifest carries app-wide for this facet, or `null` when the facet is off. */
export function settingsOf<T>(manifest: Manifest, facet: string): T | null {
  return (manifest.facets[facet] ?? null) as T | null
}
