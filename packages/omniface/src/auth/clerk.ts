import { errors } from '../errors.ts'
import type { Principal } from '../op.ts'
import type { AuthAdapter } from './adapter.ts'
import { jwtAdapter, scopesFromClaims, type JwtClaims } from './jwt.ts'

/**
 * Clerk session tokens are ordinary RS256 JWTs signed by the instance's JWKS, so this is the JWT
 * adapter with Clerk's claim names filled in. No `@clerk/backend` dependency, and no network call
 * per request: only the JWKS is fetched, and it is cached.
 */

export type ClerkAdapterOptions = {
  /**
   * The instance issuer, e.g. `https://clerk.acme.com` or `https://witty-cat-42.clerk.accounts.dev`.
   * JWKS is found by OIDC discovery unless `jwksUri` is given.
   */
  issuer: string
  jwksUri?: string
  /** Accepted `azp` values — the front ends allowed to use these tokens. Clerk's own CSRF advice. */
  authorizedParties?: readonly string[]
  /** Accepted `aud`, if the instance is configured to set one. */
  audience?: string | readonly string[]
  clockToleranceSec?: number
  cacheTtlMs?: number
  fetch?: typeof fetch
  /** Adapter name, for `ctx.auth.adapter`. Default `clerk`. */
  name?: string
  /** Scopes for a session. Default: Clerk org permissions (`o.per` / `org_permissions`) plus OAuth scopes. */
  scopes?: (claims: ClerkClaims) => string[]
  principal?: (claims: ClerkClaims) => Principal | null
}

/** The claims a Clerk session token carries (v1 flat claims and v2 `o` / `act` objects). */
export type ClerkClaims = JwtClaims & {
  /** Session id. */
  sid?: string
  azp?: string
  org_id?: string
  org_role?: string
  org_permissions?: string[]
  /** v2 organization claim: `{ id, rol, per, slg }`. */
  o?: { id?: string; rol?: string; per?: string; slg?: string }
}

function csv(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : []
}

function clerkScopes(claims: ClerkClaims): string[] {
  const out = new Set(scopesFromClaims(claims))
  for (const p of claims.org_permissions ?? []) if (typeof p === 'string') out.add(p)
  for (const p of csv(claims.o?.per)) out.add(p)
  return [...out]
}

export function clerkAdapter(options: ClerkAdapterOptions): AuthAdapter {
  if (!options.issuer) throw new Error('facet: clerkAdapter() needs the instance `issuer`')
  const toScopes = options.scopes ?? clerkScopes
  const parties = options.authorizedParties

  return jwtAdapter({
    name: options.name ?? 'clerk',
    issuer: options.issuer,
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.jwksUri !== undefined ? { jwksUri: options.jwksUri } : {}),
    ...(options.clockToleranceSec !== undefined ? { clockToleranceSec: options.clockToleranceSec } : {}),
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    algorithms: ['RS256'],
    verifyClaims(claims) {
      const azp = (claims as ClerkClaims).azp
      // Clerk's own guidance: a session token minted for another front end must not be accepted.
      if (parties?.length && (typeof azp !== 'string' || !parties.includes(azp))) {
        throw errors.unauthenticated('Token was issued for an authorized party this app does not accept')
      }
    },
    principal(raw) {
      const claims = raw as ClerkClaims
      if (options.principal) return options.principal(claims)
      if (typeof claims.sub !== 'string' || !claims.sub) return null
      const name = [claims.name, claims.email, claims.preferred_username].find((v) => typeof v === 'string') as string | undefined
      return {
        id: claims.sub,
        kind: 'user',
        scopes: toScopes(claims),
        ...(name ? { name } : {}),
      }
    },
  })
}
