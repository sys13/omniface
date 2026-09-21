import type { RestConfig } from '../app.ts'
import { defineFacet, registerFacet, projectionOf, type FacetChange } from '../facet.ts'
import { objectProperties } from '../jsonschema.ts'
import type { Manifest, ManifestOp } from '../manifest.ts'
import { conventionalRest, pathParamsOf, type HttpMethod } from '../naming.ts'
import { shellQuote } from '../shell.ts'
import { createRestApp } from './rest.ts'

/** What the REST facet does with one op: the route it answers on, and the status it returns. */
export type RestProjection = { method: HttpMethod; path: string; status: number; pathParams: string[] }

export const restOf = (op: ManifestOp): RestProjection | null => projectionOf<RestProjection>(op, 'rest')

function curl(manifest: Manifest, projection: RestProjection, example: Record<string, unknown>): string {
  let path = projection.path
  const rest = { ...example }
  for (const p of projection.pathParams) {
    path = path.replace(`{${p}}`, encodeURIComponent(String(example[p] ?? p)))
    delete rest[p]
  }
  const env = `$${manifest.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  const lines = [`curl -X ${projection.method}`]
  if (projection.method === 'GET' || projection.method === 'DELETE') {
    const qs = new URLSearchParams(
      Object.entries(rest).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]),
    ).toString()
    lines[0] += ` "http://localhost:3000${path}${qs ? `?${qs}` : ''}"`
  } else {
    lines[0] += ` http://localhost:3000${path}`
    lines.push(`-H 'Content-Type: application/json'`)
    if (Object.keys(rest).length) lines.push(`-d ${shellQuote(JSON.stringify(rest))}`)
  }
  lines.splice(1, 0, `-H "Authorization: Bearer ${env}"`)
  return lines.join(' \\\n  ')
}

export const restFacet = defineFacet<RestConfig, RestProjection, Record<string, never>>({
  name: 'rest',
  order: 0,
  defaultOn: true,
  normalize: (value) => (value === undefined || value === false ? null : value === true ? {} : (value as RestConfig)),
  references: (config) => [{ where: 'rest.ops', ids: Object.keys(config.ops ?? {}) }],

  project({ op, input }, config) {
    const override = config.ops?.[op.id]
    if (override === false) return null
    const props = Object.keys(objectProperties(input))
    const conv = conventionalRest(op.path, Boolean(op.op.traits.readonly), props)
    const path = override?.path ?? conv.path
    return {
      method: override?.method ?? conv.method,
      path,
      status: override?.status ?? conv.status,
      pathParams: override?.path ? pathParamsOf(path) : conv.pathParams,
    }
  },

  settings: () => ({}),

  // OpenAPI components are keyed by the published schema name, so a rename is breaking here too.
  observes: { typeNames: true },

  diff(before, after, { op }): FacetChange[] {
    const changes: FacetChange[] = []
    if (before.method !== after.method || before.path !== after.path) {
      changes.push({
        level: 'breaking',
        rule: 'rest-route-changed',
        message: `${op}: ${after.method} ${after.path} — was ${before.method} ${before.path}.`,
        detail: 'The old route 404s. Anything holding a URL — a webhook, a bookmark, a generated SDK — is pointed at nothing.',
      })
    }
    if (before.status !== after.status) {
      changes.push({
        level: 'breaking',
        rule: 'rest-status-changed',
        message: `${op}: success status ${before.status} → ${after.status}.`,
        detail: 'Clients that match on the exact status, rather than the 2xx class, stop matching.',
      })
    }
    return changes
  },

  present({ manifest, example }, projection) {
    return {
      label: 'REST',
      short: `${projection.method} ${projection.path}`,
      snippet: curl(manifest, projection, example),
      line: `- REST: \`${projection.method} ${projection.path}\``,
      detail: { method: projection.method, path: projection.path, status: projection.status },
    }
  },

  summary: () => 'a REST API (OpenAPI at /openapi.json)',

  contract({ app, op, others }, projection) {
    const problems: string[] = []
    const config = app.facets['rest'] as RestConfig | null
    if (!projection) {
      if (config?.ops?.[op.id] !== false) problems.push('no REST binding')
      return problems
    }
    const props = Object.keys(objectProperties(op.input))
    for (const p of projection.pathParams) {
      if (!props.includes(p)) problems.push(`REST path param "${p}" is not an input field`)
    }
    for (const other of others) {
      const theirs = restOf(other)
      if (theirs && theirs.method === projection.method && theirs.path === projection.path) {
        problems.push(`REST ${projection.method} ${projection.path} collides with ${other.id}`)
      }
    }
    return problems
  },

  serve: {
    // After the web facet: a screen route and a REST route can be the same route, and the screen
    // wins.
    order: 2,
    create: (app, manifest, options) => createRestApp(app, manifest, { security: options.security as false }),
  },
})

// Registered here rather than in a list elsewhere: a facet module that is imported is a facet the
// app has. It also keeps the import cycle with this facet's server module harmless.
registerFacet(restFacet)
