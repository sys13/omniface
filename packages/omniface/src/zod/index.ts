import { z } from 'zod'
import { applyFieldTraits, registerSchemaAdapter, type JSONSchema } from '../jsonschema.ts'
import { getFieldTraits, getSchemaName, markReached, setFieldTraits, setSchemaName, type FieldTraits } from '../traits.ts'

// The zod adapter: JSON Schema conversion, trait lookup through wrappers, and copying traits into
// zod's own metadata registry (docs/SCHEMA.md, Decisions).

registerSchemaAdapter({
  vendor: 'zod',
  toJSONSchema(schema, io) {
    return z.toJSONSchema(schema as unknown as z.ZodType, {
      io,
      unrepresentable: 'any',
      override: (ctx) => {
        // Conversion visits exactly the subschemas the definition reaches, so it is also the
        // honest answer to "was this schema ever used?" — which is what the unused-trait lint
        // asks. Walking the object graph instead would mean reading zod's lazy `shape` getter.
        markReached(ctx.zodSchema)
        const traits = getFieldTraits(ctx.zodSchema)
        if (traits) applyFieldTraits(ctx.jsonSchema as JSONSchema, traits)
        const name = getSchemaName(ctx.zodSchema)
        if (name) (ctx.jsonSchema as JSONSchema)['x-omniface-name'] ??= name
      },
    }) as JSONSchema
  },
})

function mirrorToRegistry(schema: z.ZodType, traits: FieldTraits): void {
  const meta: Record<string, unknown> = { ...(z.globalRegistry.get(schema) ?? {}) }
  applyFieldTraits(meta, traits)
  z.globalRegistry.add(schema, meta as any)
}

/** Attach facet field traits to a zod schema. Returns the same instance. */
function traits<S extends z.ZodType>(schema: S, fieldTraits: FieldTraits): S {
  setFieldTraits(schema, fieldTraits)
  mirrorToRegistry(schema, fieldTraits)
  return schema
}

const pageInputShape = {
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}

export const t = Object.assign(traits, {
  /** Name a shared type: OpenAPI component, SDK type, docs anchor. */
  named<S extends z.ZodType>(name: string, schema: S): S {
    setSchemaName(schema, name)
    return schema
  },
  id: (fieldTraits: FieldTraits = {}) => traits(z.string().min(1), { scalar: 'id', ...fieldTraits }),
  datetime: (fieldTraits: FieldTraits = {}) => traits(z.iso.datetime(), { scalar: 'datetime', ...fieldTraits }),
  date: (fieldTraits: FieldTraits = {}) => traits(z.iso.date(), { scalar: 'date', ...fieldTraits }),
  email: (fieldTraits: FieldTraits = {}) => traits(z.email(), { scalar: 'email', ...fieldTraits }),
  url: (fieldTraits: FieldTraits = {}) => traits(z.url(), { scalar: 'url', ...fieldTraits }),
  money: (fieldTraits: FieldTraits = {}) =>
    traits(z.object({ amount: z.number().int(), currency: z.string().length(3) }), { scalar: 'money', ...fieldTraits }),
  cursor: () => traits(z.string(), { scalar: 'cursor' }),
  /** Input for a paginated op: `{ cursor?, limit?, ...extra }`. */
  pageInput<Shape extends z.ZodRawShape = {}>(extra?: Shape) {
    return z.object({ ...pageInputShape, ...(extra ?? ({} as Shape)) })
  },
  /** Output for a paginated op: `{ items, nextCursor }`. */
  page<Item extends z.ZodType>(item: Item) {
    return z.object({ items: z.array(item), nextCursor: z.string().nullable() })
  },
})
