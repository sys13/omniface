import { Hono, type Context } from 'hono'
import { credentialFromAdapters, restNamespace, type PluginAdapters } from '../adapters.ts'
import type { App, RestConfig } from '../app.ts'
import { restOf } from './rest.facet.ts'
import { errors, toFacetError } from '../errors.ts'
import { coerceString, objectProperties, typeOf } from '../jsonschema.ts'
import { buildManifest, type Manifest, type ManifestOp } from '../manifest.ts'
import { buildOpenApi } from './openapi.ts'
import { clientFromHeaders, credentialFromHeaders, facetFromHeaders, newRequestId, problemBody } from './http.ts'
import { challenge, originOf, protectedResourceMetadata, PROTECTED_RESOURCE_PATH } from './oauth.ts'
import { securityMiddleware, type SecurityConfig } from './security.ts'

async function readInput(c: Context, op: ManifestOp): Promise<Record<string, unknown>> {
  const props = objectProperties(op.input)
  const input: Record<string, unknown> = {}
  const method = restOf(op)!.method
  if (method === 'GET' || method === 'DELETE') {
    const queries = c.req.queries()
    for (const [key, values] of Object.entries(queries)) {
      const schema = props[key]
      if (typeOf(schema) === 'array') {
        const items = schema?.items
        input[key] = values.flatMap((v) => (v.startsWith('[') ? (coerceString(v, schema) as unknown[]) : [coerceString(v, items)]))
      } else {
        input[key] = coerceString(values[values.length - 1]!, schema)
      }
    }
  } else {
    const text = await c.req.text()
    if (text.trim()) {
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        throw errors.invalidInput('Request body is not valid JSON')
      }
      if (body && typeof body === 'object' && !Array.isArray(body)) Object.assign(input, body)
    }
  }
  for (const param of restOf(op)!.pathParams) {
    input[param] = coerceString(c.req.param(param) ?? '', props[param])
  }
  return input
}

export type RestAppOptions = {
  /**
   * Overrides `facets.rest.security` from the app definition. Pass `false` when the REST facet is
   * mounted inside a host app that already sets CORS, CSRF and security headers.
   */
  security?: SecurityConfig | false
}

/**
 * Plugin routes, under `/_<plugin>`. They are not ops: nothing here reaches a handler except by
 * calling `app.invoke`, which runs the whole pipeline like any other facet would. The namespace is
 * what keeps a plugin from shadowing an op's route (Gate 1: a plugin may not decide whether an
 * operation runs — including by answering in its place).
 */
function mountPluginRoutes(hono: Hono, adapters: readonly PluginAdapters[]): void {
  for (const adapter of adapters) {
    for (const route of adapter.rest?.routes ?? []) {
      const path = `${restNamespace(adapter.plugin)}${route.path}`
      hono.on(route.method, path, async (c) => {
        const requestId = c.req.header('x-request-id') ?? newRequestId()
        c.header('x-request-id', requestId)
        try {
          return await route.handler({
            request: c.req.raw,
            url: new URL(c.req.url),
            params: c.req.param() as Record<string, string>,
            requestId,
          })
        } catch (raw) {
          const err = toFacetError(raw)
          return c.body(JSON.stringify(problemBody(err, requestId)), err.status as 400, {
            'content-type': 'application/problem+json',
          })
        }
      })
    }
  }
}

/** Mount every REST-bound op, plus /openapi.json and /.well-known/facet.json. */
export function createRestApp(app: App, manifest: Manifest = buildManifest(app), options: RestAppOptions = {}): Hono {
  const hono = new Hono()
  const openapi = buildOpenApi(manifest)
  const adapters = app.adapters ?? []
  hono.use('*', securityMiddleware(options.security ?? (app.facets['rest'] as RestConfig | null)?.security ?? {}))

  hono.get('/openapi.json', (c) => c.json(openapi))
  hono.get('/.well-known/facet.json', (c) => c.json(manifest))
  // Where a caller goes to get a credential (RFC 9728). Served next to the manifest because it is
  // the same kind of thing: something a stranger can read before it has been let in.
  const oauth = app.oauth
  if (oauth) {
    hono.get(PROTECTED_RESOURCE_PATH, (c) => c.json(protectedResourceMetadata(oauth, manifest, originOf(c.req.raw))))
  }
  mountPluginRoutes(hono, adapters)

  for (const op of manifest.ops) {
    const rest = restOf(op)
    if (!rest) continue
    const route = rest.path.replace(/\{([^}]+)\}/g, ':$1')
    hono.on(rest.method, route, async (c) => {
      const requestId = c.req.header('x-request-id') ?? newRequestId()
      c.header('x-request-id', requestId)
      const decorate = (status: number, ok: boolean) => {
        for (const adapter of adapters) {
          const extra = adapter.rest?.headers?.({ request: c.req.raw, op: op.id, requestId, status, ok })
          for (const [name, value] of Object.entries(extra ?? {})) c.header(name, value, { append: true })
        }
      }
      try {
        const input = await readInput(c, op)
        const output = await app.invoke(op.id, input, {
          facet: facetFromHeaders(c.req.raw.headers),
          requestId,
          credential:
            credentialFromHeaders(c.req.raw.headers) ?? credentialFromAdapters(adapters, 'rest', c.req.raw),
          idempotencyKey: c.req.header('idempotency-key'),
          client: clientFromHeaders(c.req.raw.headers),
          headers: c.req.raw.headers,
        })
        decorate(rest.status, true)
        return c.json(output as object, rest.status as 200)
      } catch (raw) {
        const err = toFacetError(raw)
        decorate(err.status, false)
        if (err.retryAfter !== undefined) c.header('retry-after', String(Math.ceil(err.retryAfter)))
        // A refusal that says where to get a credential is the only thing that makes the discovery
        // document findable: the caller learns from being refused, rather than having to know.
        if (oauth && err.status === 401) {
          const presented = credentialFromHeaders(c.req.raw.headers) !== undefined
          c.header('www-authenticate', challenge(oauth, originOf(c.req.raw), presented ? 'invalid_token' : undefined))
        }
        return c.body(JSON.stringify(problemBody(err, requestId)), err.status as 400, {
          'content-type': 'application/problem+json',
        })
      }
    })
  }
  return hono
}
