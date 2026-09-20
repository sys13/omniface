import type { AnySchema } from './standard.ts'
import { getFieldTraits, getSchemaName, type FieldTraits } from './traits.ts'

export type JSONSchema = Record<string, any>
export type IO = 'input' | 'output'

/**
 * Library-specific conversion lives in adapters (docs/SCHEMA.md). The core only ever sees
 * Standard Schema (validation, types) and JSON Schema (description).
 */
export interface SchemaAdapter {
  vendor: string
  toJSONSchema(schema: AnySchema, io: IO): JSONSchema
}

const adapters = new Map<string, SchemaAdapter>()

export function registerSchemaAdapter(adapter: SchemaAdapter): void {
  adapters.set(adapter.vendor, adapter)
}

export function toJSONSchema(schema: AnySchema, io: IO): JSONSchema {
  const std = schema['~standard'] as AnySchema['~standard'] & {
    jsonSchema?: { input: (o: { target: string }) => JSONSchema; output: (o: { target: string }) => JSONSchema }
  }
  const adapter = adapters.get(std.vendor)
  let json: JSONSchema
  if (adapter) json = adapter.toJSONSchema(schema, io)
  else if (std.jsonSchema) json = std.jsonSchema[io]({ target: 'draft-2020-12' })
  else json = {}
  // Top-level traits and names apply regardless of adapter.
  const traits = getFieldTraits(schema)
  if (traits) applyFieldTraits(json, traits)
  const name = getSchemaName(schema)
  if (name) json['x-omniface-name'] ??= name
  delete json.$schema
  return json
}

/** Copy facet field traits into a JSON Schema node as standard keywords and x-omniface-* extensions. */
export function applyFieldTraits(json: JSONSchema, traits: FieldTraits): void {
  for (const [key, value] of Object.entries(traits)) {
    if (value === undefined) continue
    switch (key) {
      case 'description':
        json.description ??= value
        break
      case 'example':
        json.examples ??= [value]
        break
      case 'readOnly':
      case 'writeOnly':
        json[key] = value
        break
      case 'deprecated':
        json.deprecated = Boolean(value)
        if (typeof value === 'string') json['x-omniface-deprecated'] = value
        break
      default:
        json[`x-omniface-${key}`] = value
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Walking JSON Schema. Used for stripping internal fields, redacting PII, coercing CLI and query
// strings, and generating examples. Library-neutral by construction.

function deref(node: JSONSchema | undefined, root: JSONSchema): JSONSchema | undefined {
  let current = node
  for (let i = 0; current && typeof current.$ref === 'string' && i < 32; i++) {
    const ref: string = current.$ref
    if (!ref.startsWith('#/')) return current
    let target: any = root
    for (const part of ref.slice(2).split('/')) target = target?.[part]
    current = target
  }
  return current
}

/** Property schemas of an object-ish node, merging allOf/anyOf/oneOf branches. */
export function objectProperties(node: JSONSchema | undefined, root: JSONSchema = node ?? {}): Record<string, JSONSchema> {
  const n = deref(node, root)
  if (!n) return {}
  const props: Record<string, JSONSchema> = {}
  for (const branch of [...(n.allOf ?? []), ...(n.anyOf ?? []), ...(n.oneOf ?? [])]) {
    Object.assign(props, objectProperties(branch, root))
  }
  for (const [k, v] of Object.entries(n.properties ?? {})) props[k] = deref(v as JSONSchema, root) ?? {}
  return props
}

export function requiredProperties(node: JSONSchema | undefined, root: JSONSchema = node ?? {}): string[] {
  const n = deref(node, root)
  return Array.isArray(n?.required) ? n.required : []
}

function itemsSchema(node: JSONSchema | undefined, root: JSONSchema): JSONSchema | undefined {
  const n = deref(node, root)
  if (!n) return undefined
  if (n.items && typeof n.items === 'object') return deref(n.items, root)
  for (const branch of [...(n.anyOf ?? []), ...(n.oneOf ?? [])]) {
    const found = itemsSchema(branch, root)
    if (found) return found
  }
  return undefined
}

function transform(
  value: unknown,
  node: JSONSchema | undefined,
  root: JSONSchema,
  onProperty: (key: string, value: unknown, schema: JSONSchema) => { drop?: true; value?: unknown } | undefined,
): unknown {
  if (Array.isArray(value)) {
    const items = itemsSchema(node, root)
    return items ? value.map((v) => transform(v, items, root, onProperty)) : value
  }
  if (value && typeof value === 'object') {
    const props = objectProperties(node, root)
    if (Object.keys(props).length === 0) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const schema = props[k]
      if (!schema) {
        out[k] = v
        continue
      }
      const action = onProperty(k, v, schema)
      if (action?.drop) continue
      out[k] = action && 'value' in action ? action.value : transform(v, schema, root, onProperty)
    }
    return out
  }
  return value
}

/** Whether a node carries an x-omniface-* trait, looking through nullable/union wrappers. */
export function hasTrait(schema: JSONSchema | undefined, trait: string): boolean {
  if (!schema) return false
  if (schema[`x-omniface-${trait}`]) return true
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].some((b: JSONSchema) => hasTrait(b, trait))
}

/** Remove fields marked internal. Applied to every op output before any facet sees it. */
export function stripInternal(value: unknown, schema: JSONSchema): unknown {
  return transform(value, schema, schema, (_k, _v, s) => (hasTrait(s, 'internal') ? { drop: true } : undefined))
}

/** Replace pii / sensitive fields. Used by logging and audit. */
export function redact(value: unknown, schema: JSONSchema, replacement = '[redacted]'): unknown {
  return transform(value, schema, schema, (_k, _v, s) =>
    hasTrait(s, 'pii') || hasTrait(s, 'sensitive') ? { value: replacement } : undefined,
  )
}

/** The schema a facet publishes: internal fields removed everywhere. */
export function publicSchema(schema: JSONSchema): JSONSchema {
  const visit = (node: any): any => {
    if (Array.isArray(node)) return node.map(visit)
    if (!node || typeof node !== 'object') return node
    const out: any = {}
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties' && v && typeof v === 'object') {
        const props: any = {}
        for (const [pk, pv] of Object.entries(v as object)) {
          if (!hasTrait(pv as JSONSchema, 'internal')) props[pk] = visit(pv)
        }
        out.properties = props
      } else out[k] = visit(v)
    }
    if (Array.isArray(out.required) && out.properties) {
      out.required = out.required.filter((r: string) => r in out.properties)
    }
    return out
  }
  return visit(schema)
}

export function typeOf(schema: JSONSchema | undefined): string | undefined {
  if (!schema) return undefined
  if (typeof schema.type === 'string') return schema.type
  if (Array.isArray(schema.type)) return schema.type.find((t: string) => t !== 'null')
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const t = typeOf(branch)
    if (t && t !== 'null') return t
  }
  if (schema.enum) return typeof schema.enum[0]
  if ('const' in schema) return typeof schema.const
  return undefined
}

/** Coerce a string (from a query string or CLI flag) using the property schema. */
export function coerceString(raw: string, schema: JSONSchema | undefined): unknown {
  switch (typeOf(schema)) {
    case 'integer':
    case 'number': {
      const n = Number(raw)
      return raw.trim() === '' || Number.isNaN(n) ? raw : n
    }
    case 'boolean':
      return raw === 'true' || raw === '1' || raw === '' ? true : raw === 'false' || raw === '0' ? false : raw
    case 'object':
    case 'array':
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    default:
      return raw
  }
}

/** A plausible example value, for docs, the inspector, and generated snippets. */
export function exampleValue(schema: JSONSchema | undefined, root: JSONSchema = schema ?? {}, depth = 0): unknown {
  const s = deref(schema, root)
  if (!s || depth > 6) return null
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0]
  if ('default' in s) return s.default
  if ('const' in s) return s.const
  if (Array.isArray(s.enum)) return s.enum[0]
  const branch = [...(s.anyOf ?? []), ...(s.oneOf ?? [])].find((b: JSONSchema) => b.type !== 'null')
  if (branch && !s.type) return exampleValue(branch, root, depth)
  const t = typeOf(s)
  const format = s.format ?? s['x-omniface-scalar']
  switch (t) {
    case 'object': {
      const out: Record<string, unknown> = {}
      const required = new Set(requiredProperties(s, root))
      for (const [k, v] of Object.entries(objectProperties(s, root))) {
        if (required.has(k) || depth === 0) {
          if (v.readOnly) continue
          out[k] = exampleValue(v, root, depth + 1)
        }
      }
      return out
    }
    case 'array':
      return [exampleValue(itemsSchema(s, root), root, depth + 1)]
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 1
    case 'boolean':
      return true
    case 'string':
      if (format === 'date-time' || format === 'datetime') return '2026-01-01T00:00:00Z'
      if (format === 'date') return '2026-01-01'
      if (format === 'email') return 'user@example.com'
      if (format === 'uri' || format === 'url') return 'https://example.com'
      return 'string'
    default:
      return null
  }
}
