import type { Principal } from '../op.ts'
import type { AuthAdapter } from './adapter.ts'
import { jwtAdapter, scopesFromClaims, type JwtClaims } from './jwt.ts'

/**
 * WorkOS AuthKit access tokens. Like Clerk, they are JWTs signed by a per-client JWKS, so the
 * adapter is the JWT one with WorkOS's claim names and its published JWKS URL — no `@workos-inc/node`
 * dependency and no token-introspection round trip.
 */

export type WorkOsAdapterOptions = {
  /** The WorkOS client id (`client_...`). Derives both the JWKS URL and the default issuer. */
  clientId: string
  /** Override the issuer if the instance uses a custom auth domain. */
  issuer?: string | readonly string[]
  jwksUri?: string
  audience?: string | readonly string[]
  clockToleranceSec?: number
  cacheTtlMs?: number
  fetch?: typeof fetch
  /** Adapter name, for `ctx.auth.adapter`. Default `workos`. */
  name?: string
  /** Scopes for a session. Default: AuthKit `permissions`, then `entitlements`, then OAuth scopes. */
  scopes?: (claims: WorkOsClaims) => string[]
  principal?: (claims: WorkOsClaims) => Principal | null
}

/** The claims an AuthKit access token carries. */
export type WorkOsClaims = JwtClaims & {
  /** Session id. */
  sid?: string
  org_id?: string
  role?: string
  permissions?: string[]
  entitlements?: string[]
}

export const workOsJwksUri = (clientId: string) => `https://api.workos.com/sso/jwks/${clientId}`
export const workOsIssuer = (clientId: string) => `https://api.workos.com/user_management/${clientId}`

function workOsScopes(claims: WorkOsClaims): string[] {
  const out = new Set<string>()
  for (const list of [claims.permissions, claims.entitlements]) {
    for (const p of list ?? []) if (typeof p === 'string') out.add(p)
  }
  for (const s of scopesFromClaims(claims)) out.add(s)
  return [...out]
}

export function workosAdapter(options: WorkOsAdapterOptions): AuthAdapter {
  if (!options.clientId) throw new Error('facet: workosAdapter() needs the WorkOS `clientId`')
  const toScopes = options.scopes ?? workOsScopes

  return jwtAdapter({
    name: options.name ?? 'workos',
    issuer: options.issuer ?? workOsIssuer(options.clientId),
    jwksUri: options.jwksUri ?? workOsJwksUri(options.clientId),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.clockToleranceSec !== undefined ? { clockToleranceSec: options.clockToleranceSec } : {}),
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    algorithms: ['RS256'],
    principal(raw) {
      const claims = raw as WorkOsClaims
      if (options.principal) return options.principal(claims)
      if (typeof claims.sub !== 'string' || !claims.sub) return null
      const name = [claims.name, claims.email].find((v) => typeof v === 'string') as string | undefined
      return {
        id: claims.sub,
        kind: 'user',
        scopes: toScopes(claims),
        ...(name ? { name } : {}),
      }
    },
  })
}
