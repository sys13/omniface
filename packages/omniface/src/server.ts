import { serve as serveNode } from '@hono/node-server'
import { Hono } from 'hono'
import type { App } from './app.ts'
import { createMcpHttpHandler } from './facets/mcp.ts'
import { createRestApp } from './facets/rest.ts'
import { securityMiddleware, type SecurityConfig } from './facets/security.ts'
import { createWebApp } from './facets/web-server.ts'
import { inspectAll } from './inspect.ts'
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
 * One HTTP server for every HTTP-reachable facet: REST, MCP at /mcp, the web console at its mount
 * path when the app turned that facet on, and the inspector at /_omniface.
 */
export function createServer(app: App, options: ServerOptions = {}): Hono {
  const manifest = buildManifest(app)
  const hono = new Hono()
  // Mounted once, at the root, so MCP over HTTP and the inspector are covered too — and the REST
  // app is told not to mount it a second time.
  const security = options.security ?? app.facets.rest?.security ?? {}
  hono.use('*', securityMiddleware(security))
  if (options.inspector) {
    hono.get('/_omniface', (c) => {
      c.header('content-security-policy', INSPECTOR_CSP)
      return c.html(inspectorHtml(manifest.name))
    })
    hono.get('/_omniface/inspect.json', (c) => c.json(inspectAll(app, manifest)))
  }
  if (app.facets.mcp) {
    const mcp = createMcpHttpHandler(app, manifest)
    hono.all('/mcp', (c) => mcp(c.req.raw))
  }
  // Before REST, because a screen route and a REST route can share a prefix and the screen is the
  // more specific of the two. Its own CSP is set per response, inside the web app.
  if (app.facets.web) hono.route('/', createWebApp(app, manifest))
  if (app.facets.rest) hono.route('/', createRestApp(app, manifest, { security: false }))
  return hono
}

export function serve(app: App, options: ServerOptions & { port?: number } = {}) {
  const hono = createServer(app, options)
  return serveNode({ fetch: hono.fetch, port: options.port ?? 3000 })
}
