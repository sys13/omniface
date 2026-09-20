import { objectProperties, requiredProperties, type JSONSchema } from '../jsonschema.ts'
import type { Manifest, ManifestOp } from '../manifest.ts'
import { hoistNamedSchemas, resolveHoisted } from '../schemas.ts'

const problemSchema: JSONSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    code: { type: 'string' },
    requestId: { type: 'string' },
    retryAfter: { type: 'number' },
    issues: { type: 'array', items: { type: 'object', properties: { message: { type: 'string' }, path: { type: 'string' } } } },
  },
  required: ['type', 'title', 'status', 'code'],
}

function without(schema: JSONSchema, keys: string[]): JSONSchema {
  if (!keys.length) return schema
  const properties = { ...(schema.properties ?? {}) }
  for (const k of keys) delete properties[k]
  const required = (schema.required ?? []).filter((r: string) => !keys.includes(r))
  const { required: _drop, ...rest } = schema
  return { ...rest, properties, ...(required.length ? { required } : {}) }
}

/**
 * What an op looks like to a generator that is not facet: the facet it is being read for is REST,
 * but the other three bindings travel too, because they are how a generated SDK can name a method
 * the same thing facet does instead of inventing one from the URL.
 */
function facetExtensions(op: ManifestOp): Record<string, unknown> {
  const out: Record<string, unknown> = { 'x-omniface-op': op.id, 'x-omniface-traits': op.traits }
  if (op.errors.length) out['x-omniface-errors'] = op.errors
  if (op.sdk) out['x-omniface-sdk'] = { method: op.sdk.method }
  if (op.cli) out['x-omniface-cli'] = { command: op.cli.command, args: op.cli.args, ...(op.cli.columns ? { columns: op.cli.columns } : {}) }
  if (op.mcp) out['x-omniface-mcp'] = op.mcp
  // Cursor pagination is a convention the whole app shares, so a generator only needs telling
  // which ops have it — the field names are the same on every one.
  if (op.traits.paginated) {
    out['x-omniface-pagination'] = { style: 'cursor', cursor: 'cursor', limit: 'limit', items: 'items', nextCursor: 'nextCursor' }
  }
  return out
}

/**
 * OpenAPI 3.1 from the manifest.
 *
 * Two things make it more than a transcription of the REST facet. Named types are hoisted into
 * `components.schemas`, so `Task` is one model every method shares and a recursive type has
 * something to point at. And every op carries `x-omniface-*`: its traits, its errors, its pagination,
 * and what it is called on the other three facets — enough for an outside generator to produce an
 * SDK that agrees with facet's own instead of one named after URLs.
 */
export function buildOpenApi(manifest: Manifest): JSONSchema {
  const paths: Record<string, Record<string, unknown>> = {}
  const securitySchemes: Record<string, unknown> = { bearer: { type: 'http', scheme: 'bearer' } }
  const hoisted = hoistNamedSchemas(manifest)
  // Named types resolve through the finished document, so `objectProperties` can look through a
  // root that is itself a reference (`input: TaskId`) to find the path parameters.
  const root: JSONSchema = { components: { schemas: hoisted.schemas } }

  // What plugins add to the REST facet: their own (namespaced) routes, and the security schemes
  // their credential is presented as. Neither is an op, so neither carries traits or a pipeline.
  for (const adapter of manifest.adapters ?? []) {
    for (const [name, scheme] of Object.entries(adapter.rest?.securitySchemes ?? {})) {
      securitySchemes[name] = scheme
    }
    for (const route of adapter.rest?.routes ?? []) {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      paths[path] ??= {}
      paths[path]![route.method.toLowerCase()] = {
        operationId: `${adapter.plugin}${path.replace(/[^A-Za-z0-9]+/g, '_')}`,
        ...(route.summary ? { summary: route.summary } : {}),
        tags: [adapter.plugin],
        responses: {
          default: { description: 'Error', content: { 'application/problem+json': { schema: problemSchema } } },
        },
        'x-omniface-plugin': adapter.plugin,
      }
    }
  }
  for (const op of manifest.ops) {
    if (!op.rest) continue
    const { method, path, status, pathParams } = op.rest
    const io = hoisted.ops[op.id]!
    const inputSchema = resolveHoisted(io.input, hoisted)
    const props = objectProperties(inputSchema, root)
    const required = new Set(requiredProperties(inputSchema, root))
    const parameters: JSONSchema[] = pathParams.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: props[name] ?? { type: 'string' },
    }))
    const inQuery = method === 'GET' || method === 'DELETE'
    if (inQuery) {
      for (const [name, schema] of Object.entries(props)) {
        if (pathParams.includes(name)) continue
        parameters.push({ name, in: 'query', required: required.has(name), schema })
      }
    }
    // With no path parameters the body *is* the named input type, so it stays a reference and a
    // generator gets the model. Removing a path parameter makes it a different type, so that one
    // is materialised.
    const body = pathParams.length ? without(inputSchema, pathParams) : io.input
    const hasBody = !inQuery && Object.keys(objectProperties(body, root)).length > 0
    paths[path] ??= {}
    paths[path]![method.toLowerCase()] = {
      operationId: op.id,
      ...(op.description ? { summary: op.description } : {}),
      tags: [op.path.length > 1 ? op.path[0] : 'default'],
      ...(parameters.length ? { parameters } : {}),
      ...(hasBody
        ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } }
        : {}),
      responses: {
        [String(status)]: { description: 'Success', content: { 'application/json': { schema: io.output } } },
        default: { description: 'Error', content: { 'application/problem+json': { schema: problemSchema } } },
      },
      ...(op.traits.idempotent && !op.traits.readonly
        ? { parameters: [...parameters, { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }] }
        : {}),
      ...(op.traits.public ? { security: [] } : {}),
      ...(op.traits.deprecated ? { deprecated: true } : {}),
      ...facetExtensions(op),
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: manifest.name, version: manifest.version, ...(manifest.description ? { description: manifest.description } : {}) },
    paths,
    components: { schemas: hoisted.schemas, securitySchemes },
    security: [{ bearer: [] }],
    'x-facet': {
      manifest: manifest.facet,
      facets: manifest.facets,
      ...(manifest.cli ? { cli: manifest.cli } : {}),
      ...(manifest.sdk ? { sdk: manifest.sdk } : {}),
    },
  }
}
