import type { JSONSchema } from './jsonschema.ts'
import type { Manifest } from './manifest.ts'

/**
 * Named types, lifted out of the ops that use them.
 *
 * `t.named('Task', …)` marks a schema as a *type* rather than an anonymous shape, and every op
 * that mentions it means the same type. Inside a single op's schema that is invisible: the shape
 * is inlined at each use, and a recursive one comes out as `{ "$ref": "#/$defs/__schema0" }` with
 * the `$defs` nested in the op's schema. Inlined into a document with a different root — an
 * OpenAPI document, where `#` is the document — that reference points at nothing.
 *
 * So the names are hoisted into one table and every use becomes a reference to it. That fixes the
 * dangling reference, and it is also what makes an outside generator emit a `Task` model shared by
 * every method instead of an anonymous `TasksCreateResponse` per operation.
 */
export type HoistedSchemas = {
  /** Every named type, under the name a generator should give it. */
  schemas: Record<string, JSONSchema>
  /** Each op's input and output, with every named type replaced by a reference. */
  ops: Record<string, { input: JSONSchema; output: JSONSchema }>
  /**
   * Names used for two different shapes. A name is a promise that the type is the same
   * everywhere, so this is an authoring mistake rather than something to rename around: the
   * first shape keeps the name and the conflict is reported.
   */
  conflicts: { name: string; ops: string[] }[]
}

const NAME = 'x-omniface-name'

/** Keys whose value is a map of schemas, not a schema. Their entries are visited, they are not. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])

function pascal(text: string): string {
  return text.replace(/(?:^|[^A-Za-z0-9])([A-Za-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '')
}

/** Key order is not meaningful in JSON Schema, so compare shapes with it normalised away. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as object)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * @param prefix What a reference to a hoisted type looks like. `#/components/schemas/` for
 *   OpenAPI; the SDK's type generator passes `#/` and reads the name back off the end.
 */
export function hoistNamedSchemas(manifest: Manifest, prefix = '#/components/schemas/'): HoistedSchemas {
  const schemas: Record<string, JSONSchema> = {}
  const owners: Record<string, string[]> = {}
  const conflicts: HoistedSchemas['conflicts'] = []
  const ops: HoistedSchemas['ops'] = {}

  for (const op of manifest.ops) {
    ops[op.id] = {
      input: hoistDocument(op.input, op.id, 'input'),
      output: hoistDocument(op.output, op.id, 'output'),
    }
  }
  return { schemas, ops, conflicts }

  function hoistDocument(doc: JSONSchema, opId: string, io: 'input' | 'output'): JSONSchema {
    const defs = (doc.$defs ?? {}) as Record<string, JSONSchema>
    // A name is being computed while its own body is still being walked: that is exactly the
    // recursive case, and returning the name is what the recursion point refers to.
    const reserving = new Set<string>()

    const fallback = (hint: string) => pascal(`${opId} ${io} ${hint}`)

    const local = (ref: string): JSONSchema | undefined => {
      if (ref === '#') return doc
      const key = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined
      return key ? defs[key] : undefined
    }

    const hoist = (node: JSONSchema, hint: string): string => {
      const name: string = typeof node[NAME] === 'string' ? node[NAME] : fallback(hint)
      if (reserving.has(name)) return name
      reserving.add(name)
      const body = children(node)
      reserving.delete(name)
      const existing = schemas[name]
      if (!existing) {
        schemas[name] = body
        owners[name] = [opId]
      } else {
        ;(owners[name] ??= []).push(opId)
        if (stable(existing) !== stable(body) && !conflicts.some((c) => c.name === name)) {
          conflicts.push({ name, ops: [...new Set(owners[name]!)] })
        }
      }
      return name
    }

    /** A node's own entries, rewritten. `$defs` is dropped: everything in it is hoisted instead. */
    const children = (node: JSONSchema): JSONSchema => {
      const out: JSONSchema = {}
      for (const [key, value] of Object.entries(node)) {
        if (key === '$defs' || key === 'definitions') continue
        out[key] = SCHEMA_MAPS.has(key) && value && typeof value === 'object' && !Array.isArray(value) ? map(value as JSONSchema, key) : visit(value, key)
      }
      return out
    }

    const map = (container: JSONSchema, hint: string): JSONSchema => {
      const out: JSONSchema = {}
      for (const [key, value] of Object.entries(container)) out[key] = visit(value, `${hint === 'properties' ? '' : hint} ${key}`)
      return out
    }

    const visit = (node: unknown, hint: string): unknown => {
      if (Array.isArray(node)) return node.map((n) => visit(n, hint))
      if (!node || typeof node !== 'object') return node
      const schema = node as JSONSchema
      if (typeof schema.$ref === 'string') {
        const target = local(schema.$ref)
        // An external reference is not ours to resolve; leave it exactly as it was.
        if (!target) return schema
        const key = schema.$ref.startsWith('#/$defs/') ? schema.$ref.slice('#/$defs/'.length) : 'self'
        return { $ref: prefix + hoist(target, key.startsWith('__') ? hint : key) }
      }
      if (typeof schema[NAME] === 'string') return { $ref: prefix + hoist(schema, schema[NAME]) }
      return children(schema)
    }

    if (typeof doc[NAME] === 'string') return { $ref: prefix + hoist(doc, doc[NAME]) }
    // A root that is only recursive — `{ "$ref": "#" }` at the top — has nothing to point at
    // once it is hoisted, which is the case `omniface lint` asks authors to name.
    return children(doc)
  }
}

/** The named type a reference points at, or the schema itself when it is not one. */
export function resolveHoisted(schema: JSONSchema, hoisted: HoistedSchemas, prefix = '#/components/schemas/'): JSONSchema {
  const ref = schema.$ref
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) return schema
  return hoisted.schemas[ref.slice(prefix.length)] ?? schema
}
