import { errors, facet, paginate, type App, type JSONSchema, type Plugin, type StandardSchemaV1 } from 'omniface'

/**
 * The app a plugin is tried against: small, boring, and projected to all four facets, so a plugin
 * author needs no app of their own to run the conformance kit.
 *
 * Its schemas are hand-written Standard Schemas rather than Zod ones, for two reasons: the kit
 * should not drag a schema library into a plugin author's dependency tree, and an app built with
 * no schema adapter at all is worth exercising on every release.
 */

type Schema<T> = StandardSchemaV1<T, T> & {
  json: JSONSchema
  check(value: unknown, path: (string | number)[]): Checked<T>
}

type Issue = { message: string; path?: (string | number)[] }

/** A checked value or the reasons it was refused. Never a bare array: an array is a valid value. */
type Checked<T> = { ok: true; value: T } | { ok: false; issues: Issue[] }

const ok = <T>(value: T): Checked<T> => ({ ok: true, value })
const bad = <T>(...issues: Issue[]): Checked<T> => ({ ok: false, issues })

function define<T>(json: JSONSchema, check: (value: unknown, path: (string | number)[]) => Checked<T>): Schema<T> {
  const schema = {
    json,
    check,
    '~standard': {
      version: 1 as const,
      vendor: 'facet-testing',
      validate: (value: unknown) => {
        const result = check(value, [])
        return result.ok ? { value: result.value } : { issues: result.issues }
      },
      jsonSchema: { input: () => json, output: () => json },
    },
  }
  return schema as unknown as Schema<T>
}

const str = (extra: JSONSchema = {}) =>
  define<string>({ type: 'string', ...extra }, (value, path) =>
    typeof value === 'string' ? ok(value) : bad<string>({ message: 'Expected a string', path }),
  )

const int = (extra: JSONSchema = {}) =>
  define<number>({ type: 'integer', ...extra }, (value, path) =>
    typeof value === 'number' && Number.isInteger(value) ? ok(value) : bad<number>({ message: 'Expected an integer', path }),
  )

const bool = () =>
  define<boolean>({ type: 'boolean' }, (value, path) =>
    typeof value === 'boolean' ? ok(value) : bad<boolean>({ message: 'Expected a boolean', path }),
  )

const nullable = <T>(inner: Schema<T>) =>
  define<T | null>({ ...inner.json, type: [inner.json.type, 'null'] }, (value, path) =>
    value === null ? ok(null) : inner.check(value, path),
  )

const array = <T>(inner: Schema<T>) =>
  define<T[]>({ type: 'array', items: inner.json }, (value, path) => {
    if (!Array.isArray(value)) return bad<T[]>({ message: 'Expected an array', path })
    const issues: Issue[] = []
    const out: T[] = []
    value.forEach((item, i) => {
      const result = inner.check(item, [...path, i])
      if (result.ok) out.push(result.value)
      else issues.push(...result.issues)
    })
    return issues.length ? bad<T[]>(...issues) : ok(out)
  })

/** An object schema: unknown keys are dropped, missing required keys are issues. */
function object<T extends Record<string, unknown>>(
  fields: { [K in keyof T]: Schema<T[K]> },
  required: (keyof T & string)[],
): Schema<T> {
  const json: JSONSchema = {
    type: 'object',
    properties: Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, (schema as Schema<unknown>).json])),
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
  return define<T>(json, (value, path) => {
    if (value === undefined || value === null) value = {}
    if (typeof value !== 'object' || Array.isArray(value)) return bad<T>({ message: 'Expected an object', path })
    const input = value as Record<string, unknown>
    const issues: Issue[] = []
    const out: Record<string, unknown> = {}
    for (const key of required) {
      if (input[key] === undefined) issues.push({ message: `Missing required field "${key}"`, path: [...path, key] })
    }
    for (const [key, schema] of Object.entries(fields)) {
      if (input[key] === undefined) continue
      const result = (schema as Schema<unknown>).check(input[key], [...path, key])
      if (result.ok) out[key] = result.value
      else issues.push(...result.issues)
    }
    return issues.length ? bad<T>(...issues) : ok(out as T)
  })
}

const Item = object<{ id: string; title: string; done: boolean }>(
  { id: str({ 'x-omniface-scalar': 'id', examples: ['item_1'] }), title: str({ examples: ['A title'] }), done: bool() },
  ['id', 'title', 'done'],
)

const ItemId = object<{ id: string }>({ id: str({ 'x-omniface-scalar': 'id', examples: ['item_1'] }) }, ['id'])

const PageInput = object<{ cursor?: string; limit?: number }>({ cursor: str(), limit: int() }, [])
const ItemPage = object<{ items: { id: string; title: string; done: boolean }[]; nextCursor: string | null }>(
  { items: array(Item), nextCursor: nullable(str()) },
  ['items', 'nextCursor'],
)

export type SampleAppOptions = {
  /** Every sample op declares this scope, so a plugin that authorizes has something to enforce. */
  scope?: string
}

/**
 * A four-op app: a paginated read, a read by id, an idempotent write and a destructive delete.
 * Fresh state per call, so one case's writes never reach another's.
 */
export function createSampleApp(plugins: readonly Plugin<any, any>[] = [], options: SampleAppOptions = {}): App {
  const f = facet({ plugins })
  const items = new Map<string, { id: string; title: string; done: boolean }>([
    ['item_1', { id: 'item_1', title: 'Seeded', done: false }],
  ])
  let counter = 1
  const scoped = options.scope ? { scope: options.scope } : { public: true }

  return f.app({
    name: 'sample',
    version: '0.0.0',
    description: 'The sample app the facet plugin conformance kit runs against',
    ops: {
      items: {
        list: f
          .op({ input: PageInput, output: ItemPage, description: 'List items' })
          .traits({ readonly: true, paginated: true, ...scoped })
          .handle(({ input }) => paginate([...items.values()], input)),
        get: f
          .op({ input: ItemId, output: Item, description: 'Get one item', errors: ['not_found'] })
          .traits({ readonly: true, ...scoped })
          .handle(({ input }) => {
            const found = items.get(input.id)
            if (!found) throw errors.notFound(`No item "${input.id}"`)
            return found
          }),
        create: f
          .op({
            input: object<{ title: string }>({ title: str({ examples: ['A title'] }) }, ['title']),
            output: Item,
            description: 'Create an item',
          })
          .traits({ idempotent: true, ...scoped })
          .handle(({ input }) => {
            const item = { id: `item_${++counter}`, title: input.title, done: false }
            items.set(item.id, item)
            return item
          }),
        remove: f
          .op({ input: ItemId, output: object<{ id: string }>({ id: str() }, ['id']), description: 'Delete an item', errors: ['not_found'] })
          .traits({ destructive: true, ...scoped })
          .handle(({ input }) => {
            if (!items.delete(input.id)) throw errors.notFound(`No item "${input.id}"`)
            return { id: input.id }
          }),
      },
    },
  }) as App
}
