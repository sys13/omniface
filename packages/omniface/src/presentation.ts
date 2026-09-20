import { hasTrait, objectProperties, requiredProperties, typeOf, type JSONSchema } from './jsonschema.ts'
import { kebab } from './naming.ts'

/**
 * What a facet aimed at a *person* does with one field. Backlog 12.3.
 *
 * The CLI's tables and the web facet's screens both have to answer the same questions — is this
 * masked, is it a date, is it deprecated, what do I call it — and the answers come from the same
 * field traits. Two implementations of that is drift inside the project that exists to stop drift,
 * so both read this. Machine-facing facets (REST, MCP, the SDK) are not in scope: they hand over
 * the value, and `internal` is already gone from the schemas the manifest carries.
 */

/** The mask a person sees instead of a `sensitive` value, on any facet. */
export const MASK = '••••'

export type FieldDisplay = 'text' | 'masked' | 'boolean' | 'datetime' | 'number' | 'json'

export type FieldPresentation = {
  name: string
  /** A human label: `ownerEmail` → `Owner email`. Overridable per facet (12.4). */
  label: string
  display: FieldDisplay
  required: boolean
  description?: string
  /** Present when the field is deprecated; the string is the message, when there was one. */
  deprecated?: string
  enum?: string[]
  /** Never shown in the clear. A facet may offer a deliberate reveal; it may not print it. */
  sensitive: boolean
  /** Personal data. Redacted in logs and audit; shown to the person it belongs to. */
  pii: boolean
}

export function humanLabel(name: string): string {
  const words = kebab(name).split('-')
  return words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1) + (words.length > 1 ? ` ${words.slice(1).join(' ')}` : '')
}

function displayOf(schema: JSONSchema | undefined): FieldDisplay {
  if (hasTrait(schema, 'sensitive')) return 'masked'
  const scalar = schema?.['x-omniface-scalar']
  if (scalar === 'datetime' || schema?.format === 'date-time') return 'datetime'
  const type = typeOf(schema)
  if (type === 'boolean') return 'boolean'
  if (type === 'number' || type === 'integer') return 'number'
  if (type === 'object' || type === 'array') return 'json'
  return 'text'
}

/**
 * Every field of an object schema, in schema order, with the presentation rules already applied.
 * `internal` fields are dropped rather than described: the manifest's schemas have none, and a
 * caller passing a raw schema should not be one refactor away from rendering one.
 */
export function presentFields(schema: JSONSchema | undefined, root: JSONSchema = schema ?? {}): FieldPresentation[] {
  const required = new Set(requiredProperties(schema, root))
  const out: FieldPresentation[] = []
  for (const [name, field] of Object.entries(objectProperties(schema, root))) {
    if (hasTrait(field, 'internal')) continue
    const deprecated = field['x-omniface-deprecated'] ?? (field.deprecated ? true : undefined)
    out.push({
      name,
      label: humanLabel(name),
      display: displayOf(field),
      required: required.has(name),
      ...(field.description ? { description: String(field.description) } : {}),
      ...(deprecated !== undefined ? { deprecated: typeof deprecated === 'string' ? deprecated : '' } : {}),
      ...(Array.isArray(field.enum) ? { enum: field.enum.map((v: unknown) => String(v)) } : {}),
      sensitive: hasTrait(field, 'sensitive'),
      pii: hasTrait(field, 'pii'),
    })
  }
  return out
}

/** One value as text, by the field's rules. A `masked` field never returns its value. */
export function presentValue(value: unknown, field?: Pick<FieldPresentation, 'display'>): string {
  if (field?.display === 'masked') return MASK
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Which columns a table shows when the app has not said: the scalar fields, capped, because a
 * table that wraps is a table nobody reads. `override` is the app's column list, used as given.
 */
export function tableColumns(row: JSONSchema | undefined, root: JSONSchema = row ?? {}, override?: string[], limit = 6): string[] {
  if (override) return override
  return presentFields(row, root)
    .filter((f) => f.display !== 'json')
    .map((f) => f.name)
    .slice(0, limit)
}
