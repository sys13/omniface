import { serve as serveNode } from '@hono/node-server'
import { Hono } from 'hono'
import type { App } from './app.ts'
import { facetModules } from './facet.ts'
import type { RestConfig } from './app.ts'
import { securityMiddleware, type SecurityConfig } from './facets/security.ts'
import { inspectAll } from './inspect.ts'

import './facets/builtin.ts'
import { inspectorHtml } from './inspector-html.ts'
import { buildManifest } from './manifest.ts'

export type ServerOptions = {
  inspector?: boolean
  /** Overrides `facets.rest.security`, for every HTTP facet this server mounts. */
  security?: SecurityConfig | false
}

/** The inspector is a page, not an API: it needs its own styles and script to be allowed to run. */
const INSPECTOR_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"

/**
 * One HTTP server for every facet that is served, plus the inspector at /_omniface. Which facets
 * those are comes from the registry, not from a list here: a facet is served when its module has
 * a `serve` hook, and mounts in the order that hook asks for.
 *
 * That order is not cosmetic. Hono matches in registration order, so the first mount wins a route
 * two facets both claim — which is why `web` (1) mounts before `rest` (2): a screen route and a
 * REST route can be the same route, and the screen is meant to win.
 */
export function createServer(app: App, options: ServerOptions = {}): Hono {
  const manifest = buildManifest(app)
  const hono = new Hono()
  // Mounted once, at the root, so MCP over HTTP and the inspector are covered too — and the REST
  // app is told not to mount it a second time.
  const security = options.security ?? (app.facets['rest'] as RestConfig | null)?.security ?? {}
  hono.use('*', securityMiddleware(security))
  if (options.inspector) {
    hono.get('/_omniface', (c) => {
      c.header('content-security-policy', INSPECTOR_CSP)
      return c.html(inspectorHtml(manifest.name))
    })
    hono.get('/_omniface/inspect.json', (c) => c.json(inspectAll(app, manifest)))
  }
  // Every facet that is on and is served, lowest `mountOrder` first — and first mounted wins a
  // route two of them both claim. A facet that is not a server — `cli`, `sdk` — has no `serve`
  // and is skipped; nothing here knows which is which.
  //
  // A facet that does not set `mountOrder` sorts last, as `facetModules` does with `order`. The
  // alternative was to read unset as 0, which put a facet whose author had not thought about
  // mount order level with `mcp` and let registration order break the tie — and registration
  // order is not stable.
  const served = facetModules()
    .filter((m) => m.serve && app.facets[m.name] != null)
    .sort((a, b) => (a.serve!.mountOrder ?? Number.MAX_SAFE_INTEGER) - (b.serve!.mountOrder ?? Number.MAX_SAFE_INTEGER))
  for (const module of served) {
    hono.route('/', module.serve!.create(app, manifest, { security: false }) as Hono)
  }
  return hono
}

export function serve(app: App, options: ServerOptions & { port?: number } = {}) {
  const hono = createServer(app, options)
  return serveNode({ fetch: hono.fetch, port: options.port ?? 3000 })
}
