import { ERROR_CODES, type FacetError } from '../errors.ts'
import type { Credential } from '../plugin.ts'

export function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** `Authorization: Bearer <token>` or `X-API-Key: <token>`. */
export function credentialFromHeaders(headers: Headers): Credential | undefined {
  const auth = headers.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return { type: 'bearer', token: auth.slice(7).trim() }
  const key = headers.get('x-api-key')
  return key ? { type: 'bearer', token: key.trim() } : undefined
}

/** `X-Facet-Client: acme-cli/1.2.0`, set by facet's own clients so logs and audit know the caller. */
export function clientFromHeaders(headers: Headers): { name?: string; version?: string } | undefined {
  const raw = headers.get('x-omniface-client') ?? undefined
  if (!raw) return undefined
  const [name, version] = raw.split('/')
  return { name, version }
}

/** RFC 9457 Problem Details. */
export function problemBody(err: FacetError, requestId: string) {
  return {
    type: `https://facet.dev/errors/${err.code}`,
    title: ERROR_CODES[err.code].title,
    status: err.status,
    detail: err.message,
    code: err.code,
    requestId,
    ...(err.issues ? { issues: err.issues } : {}),
    ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
  }
}

/**
 * The SDK, the CLI and a browser agent all reach the server over HTTP, but they are not REST.
 * They say so with `X-Facet-Via`, so logs, audit and per-facet metrics attribute the call
 * correctly. This is attribution only: every facet runs the same pipeline, so claiming one grants
 * nothing. `webmcp` is the one claim that *costs* the caller something — the app's agent
 * declaration is enforced against it (docs/BACKLOG.md 12.7) — which is the right direction for a
 * claim to travel.
 */
export function facetFromHeaders(headers: Headers): 'rest' | 'sdk' | 'cli' | 'webmcp' {
  const via = headers.get('x-omniface-via')
  return via === 'sdk' || via === 'cli' || via === 'webmcp' ? via : 'rest'
}
