import type { MiddlewareHandler } from 'hono'
import { FacetError } from '../errors.ts'
import { newRequestId, problemBody } from './http.ts'

/**
 * CORS, CSRF and security headers for the HTTP facets — on by default.
 *
 * The defaults are the ones an app can be pointed at the internet with: no cross-origin access
 * until an origin is named, no state-changing request from an origin that was not named, and the
 * response headers a browser needs to not make things worse. `facets: { rest: { security: false } }`
 * turns the whole thing off, one sub-section at a time if that is what is wanted.
 */

export type OriginMatcher = string | readonly string[] | ((origin: string) => boolean)

export type CorsConfig = {
  /**
   * Which origins may read responses. Default: none — same-origin only. `'*'` allows any origin,
   * and is refused together with `credentials: true`, which is what the fetch spec does anyway.
   */
  origin?: OriginMatcher
  /** Default: every method the app's REST routes use, plus OPTIONS. */
  methods?: readonly string[]
  /** Default: the headers facet's own clients send. */
  allowHeaders?: readonly string[]
  /** Default: the response headers facet sets that a browser cannot otherwise read. */
  exposeHeaders?: readonly string[]
  /** Send `Access-Control-Allow-Credentials`. Default false. */
  credentials?: boolean
  /** Preflight cache, in seconds. Default 600. */
  maxAge?: number
}

export type CsrfConfig = {
  /**
   * Origins allowed to make state-changing requests, on top of same-origin. Defaults to the CORS
   * origins, because an origin trusted to read a response is trusted to cause one.
   */
  origin?: OriginMatcher
}

export type SecurityHeadersConfig = {
  /** `Strict-Transport-Security`, sent on HTTPS requests only. Default: one year, subdomains included. */
  hsts?: false | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean }
  /** Default `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. */
  contentSecurityPolicy?: string | false
  /** Default `no-referrer`. */
  referrerPolicy?: string | false
  /** Default `DENY`. */
  frameOptions?: string | false
  /** Extra headers, or an override for any of the above. */
  extra?: Record<string, string>
}

export type SecurityConfig = {
  cors?: CorsConfig | false
  csrf?: CsrfConfig | false
  headers?: SecurityHeadersConfig | false
}

export const DEFAULT_ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'idempotency-key',
  'x-api-key',
  'x-request-id',
  'x-omniface-client',
  'x-omniface-via',
] as const

export const DEFAULT_EXPOSE_HEADERS = ['x-request-id', 'retry-after'] as const

export const DEFAULT_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] as const

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function matches(matcher: OriginMatcher | undefined, origin: string): boolean {
  if (matcher === undefined) return false
  if (typeof matcher === 'function') return matcher(origin)
  if (typeof matcher === 'string') return matcher === '*' || matcher === origin
  return matcher.includes('*') || matcher.includes(origin)
}

/** `*` is a valid CORS answer but never a valid "this origin may change state" answer. */
function matchesForCsrf(matcher: OriginMatcher | undefined, origin: string): boolean {
  if (matcher === '*' || (Array.isArray(matcher) && matcher.includes('*'))) return false
  return matches(matcher, origin)
}

function sameOrigin(origin: string, url: URL, forwarded: { host?: string | null; proto?: string | null }): boolean {
  try {
    const parsed = new URL(origin)
    const host = forwarded.host ?? url.host
    const proto = (forwarded.proto ?? url.protocol.replace(':', '')).split(',')[0]!.trim()
    return parsed.host === host && parsed.protocol.replace(':', '') === proto
  } catch {
    return false
  }
}

function forbidden(message: string): Response {
  const err = new FacetError('forbidden', message)
  return new Response(JSON.stringify(problemBody(err, newRequestId())), {
    status: 403,
    headers: { 'content-type': 'application/problem+json' },
  })
}

/**
 * One middleware for all three concerns, in the order a browser applies them: answer the
 * preflight, refuse a cross-origin write, then set the headers on whatever is returned.
 */
export function securityMiddleware(config: SecurityConfig | false | undefined = {}): MiddlewareHandler {
  if (config === false) return async (_c, next) => next()
  const cors = config.cors === false ? undefined : (config.cors ?? {})
  const csrfOff = config.csrf === false
  const csrfOrigin = (config.csrf === false ? undefined : config.csrf?.origin) ?? cors?.origin
  const headers = config.headers === false ? undefined : (config.headers ?? {})

  if (cors?.credentials && matches(cors.origin, '*') && typeof cors.origin !== 'function') {
    throw new Error("facet: cors.origin '*' cannot be combined with credentials: true")
  }

  const allowMethods = (cors?.methods ?? DEFAULT_METHODS).join(', ')
  const allowHeaders = (cors?.allowHeaders ?? DEFAULT_ALLOW_HEADERS).join(', ')
  const exposeHeaders = (cors?.exposeHeaders ?? DEFAULT_EXPOSE_HEADERS).join(', ')
  const maxAge = String(cors?.maxAge ?? 600)
  /** A configured cross-origin API is one browsers may embed; a closed one is not. */
  const corsOpen = cors?.origin !== undefined

  const corsHeaders = (origin: string): Record<string, string> => ({
    'access-control-allow-origin': typeof cors?.origin === 'string' && cors.origin === '*' && !cors.credentials ? '*' : origin,
    ...(cors?.credentials ? { 'access-control-allow-credentials': 'true' } : {}),
    'access-control-expose-headers': exposeHeaders,
    vary: 'Origin',
  })

  return async (c, next) => {
    const origin = c.req.header('origin')
    const url = new URL(c.req.url)
    const forwarded = { host: c.req.header('x-forwarded-host'), proto: c.req.header('x-forwarded-proto') }
    const allowed = origin !== undefined && (sameOrigin(origin, url, forwarded) || (cors ? matches(cors.origin, origin) : false))

    // Preflight is answered here: the route it asks about must not run.
    if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-method')) {
      const res = new Response(null, { status: 204 })
      if (cors && allowed && origin) {
        for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v)
        res.headers.set('access-control-allow-methods', allowMethods)
        res.headers.set('access-control-allow-headers', c.req.header('access-control-request-headers') ?? allowHeaders)
        res.headers.set('access-control-max-age', maxAge)
      } else {
        res.headers.set('vary', 'Origin')
      }
      return res
    }

    // CSRF: a browser always sends Origin on a state-changing request, so an Origin we do not
    // trust is a cross-site write. A request with no Origin is a non-browser client (curl, the
    // SDK, the CLI, a server) and carries no ambient cookie authority.
    if (!csrfOff && origin !== undefined && !SAFE_METHODS.has(c.req.method)) {
      if (!sameOrigin(origin, url, forwarded) && !matchesForCsrf(csrfOrigin, origin)) {
        return forbidden(`Cross-origin request from "${origin}" is not allowed`)
      }
    }

    await next()

    // The response exists by now, so write onto it directly: `c.header()` is for the route.
    const set = (name: string, value: string) => c.res.headers.set(name, value)

    if (cors && allowed && origin) {
      for (const [k, v] of Object.entries(corsHeaders(origin))) set(k, v)
    } else if (cors) {
      set('vary', 'Origin')
    }

    if (headers) {
      const setOr = (name: string, value: string | false | undefined, fallback: string) => {
        if (value === false) return
        set(name, value ?? fallback)
      }
      set('x-content-type-options', 'nosniff')
      set('x-permitted-cross-domain-policies', 'none')
      set('cross-origin-opener-policy', 'same-origin')
      set('cross-origin-resource-policy', corsOpen ? 'cross-origin' : 'same-origin')
      setOr('referrer-policy', headers.referrerPolicy, 'no-referrer')
      setOr('x-frame-options', headers.frameOptions, 'DENY')
      // A route that set its own policy (the inspector is a page, not JSON) keeps it.
      if (!c.res.headers.has('content-security-policy')) {
        setOr(
          'content-security-policy',
          headers.contentSecurityPolicy,
          "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        )
      }
      const proto = (forwarded.proto ?? url.protocol.replace(':', '')).split(',')[0]!.trim()
      if (headers.hsts !== false && proto === 'https') {
        const hsts = headers.hsts ?? {}
        set(
          'strict-transport-security',
          [
            `max-age=${hsts.maxAge ?? 31536000}`,
            (hsts.includeSubDomains ?? true) ? 'includeSubDomains' : '',
            hsts.preload ? 'preload' : '',
          ]
            .filter(Boolean)
            .join('; '),
        )
      }
      for (const [k, v] of Object.entries(headers.extra ?? {})) set(k, v)
    }
  }
}
