import type { AnySchema } from './standard.ts'

/** Intent declared on an operation. Facets interpret it; plugins may add their own keys. */
export type OpTraits = {
  /** No side effects. REST GET, MCP readOnlyHint, SDK/CLI safe to retry. */
  readonly?: boolean
  /** Irreversible. CLI confirmation, MCP destructiveHint. */
  destructive?: boolean
  /** Safe to retry with the same input. Idempotency-Key, MCP idempotentHint. */
  idempotent?: boolean
  /** Input takes cursor/limit; output is { items, nextCursor }. */
  paginated?: boolean
  /** Scope a principal must hold. */
  scope?: string
  /** Allowed without authentication. */
  public?: boolean
  /** Rate-limit cost (default 1). */
  cost?: number
  /** Never exposed on any facet. */
  internal?: boolean
  /**
   * The output carries content someone else wrote. An agent must not read it as instructions:
   * WebMCP says so with `untrustedContentHint`, and MCP, which has no such annotation, says it in
   * the tool description (docs/BACKLOG.md 12.9).
   */
  untrusted?: boolean
  [key: string]: unknown
}

export type FieldTraits = {
  /** Personal data: redacted in logs, traces and audit. */
  pii?: boolean
  /** Like pii, and masked in CLI tables. */
  sensitive?: boolean
  /** Removed from every facet's output. */
  internal?: boolean
  /** Content someone else wrote. Makes the whole output untrusted for an agent. See OpTraits. */
  untrusted?: boolean
  /** Deprecated, with a message. */
  deprecated?: string | boolean
  readOnly?: boolean
  writeOnly?: boolean
  example?: unknown
  description?: string
  /** A facet scalar kind (id, datetime, money, …). */
  scalar?: string
  [key: string]: unknown
}

// The source of truth for traits (docs/SCHEMA.md, Decisions). Keyed by schema instance so it works
// with any Standard Schema library; adapters copy traits outward into JSON Schema and native metadata.
const fieldTraits = new WeakMap<object, FieldTraits>()
const names = new WeakMap<object, string>()

// Traits are keyed by schema instance, so a schema method that returns a *new* instance silently
// drops them: `t(z.string(), { pii: true }).min(1)` registers traits on a schema the definition
// then throws away. Nothing downstream can tell that apart from a field that never had traits, so
// the registrations are tracked here and `lint` reports the ones no op ever reached.
//
// WeakRef, not a plain Set, so tracking a schema never keeps it alive; `reached` is a WeakSet for
// the same reason. A schema reached by any app stays marked, which is what keeps the rule quiet
// when several apps are built in one process (a test suite, or conformance's fresh app per case).
const registered: WeakRef<object>[] = []
const reached = new WeakSet<object>()

export function setFieldTraits<S extends object>(schema: S, traits: FieldTraits): S {
  if (!fieldTraits.has(schema)) registered.push(new WeakRef(schema))
  fieldTraits.set(schema, { ...fieldTraits.get(schema), ...traits })
  return schema
}

/** Record that an op's definition actually reaches this schema. Called when an op is registered. */
export function markReached(schema: object): void {
  reached.add(schema)
}

/**
 * Every trait-carrying schema no op has ever reached, with the traits that were set on it.
 *
 * Takes them: each orphan is returned once per process. The registry has to be process-wide —
 * an orphan is by definition attached to no app, so there is nothing to scope it to — and
 * reporting one repeatedly would mean every app linted after the first inherited it.
 */
export function takeUnreachedTraitSchemas(): FieldTraits[] {
  const out: FieldTraits[] = []
  let live = 0
  for (const ref of registered) {
    const schema = ref.deref()
    if (!schema) continue
    if (reached.has(schema)) {
      registered[live++] = ref
      continue
    }
    const traits = fieldTraits.get(schema)
    if (traits) out.push(traits)
  }
  registered.length = live
  return out
}

export function getFieldTraits(schema: object): FieldTraits | undefined {
  return fieldTraits.get(schema)
}

export function hasFieldTraits(schema: object): boolean {
  return fieldTraits.has(schema)
}

export function setSchemaName<S extends object>(schema: S, name: string): S {
  names.set(schema, name)
  return schema
}

export function getSchemaName(schema: object): string | undefined {
  return names.get(schema)
}

export function isSchema(value: unknown): value is AnySchema {
  return typeof value === 'object' && value !== null && '~standard' in value
}
