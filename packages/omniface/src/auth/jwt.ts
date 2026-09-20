import { errors } from '../errors.ts'
import type { Principal } from '../op.ts'
import { defineAuthAdapter, type AuthAdapter, type AuthContext } from './adapter.ts'

/**
 * JWT verification against an issuer's JWKS, with no runtime dependency: WebCrypto verifies the
 * signature and the JWKS is fetched over HTTP and cached. Clerk and WorkOS are this file with
 * their claim shapes filled in.
 */

export type JwtClaims = Record<string, unknown> & {
  sub?: string
  iss?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  iat?: number
}

export type JwtAlgorithm =
  | 'RS256' | 'RS384' | 'RS512'
  | 'PS256' | 'PS384' | 'PS512'
  | 'ES256' | 'ES384' | 'ES512'
  | 'EdDSA'

export const JWT_ALGORITHMS: readonly JwtAlgorithm[] = [
  'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA',
]

export type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string }

export type JwtVerifyOptions = {
  /** Accepted `iss` values. Required: an unpinned issuer is not verification. */
  issuer: string | readonly string[]
  /** Accepted `aud` values. When set, a token with no matching `aud` is rejected. */
  audience?: string | readonly string[]
  /** Defaults to OIDC discovery on the first issuer: `<issuer>/.well-known/openid-configuration`. */
  jwksUri?: string
  /** Allowed `alg` header values. Defaults to every asymmetric algorithm facet can verify. */
  algorithms?: readonly JwtAlgorithm[]
  /** Seconds of slack on `exp` / `nbf` / `iat`. Default 60. */
  clockToleranceSec?: number
  /** How long a fetched JWKS is reused. Default 5 minutes. */
  cacheTtlMs?: number
  /** Require an `exp` claim. Default true: a token that never expires is a password. */
  requireExpiry?: boolean
  fetch?: typeof fetch
}

// ---------------------------------------------------------------------------------------------
// base64url

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function decodeJson(segment: string, what: string): Record<string, unknown> {
  try {
    const text = new TextDecoder().decode(base64UrlToBytes(segment))
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw errors.unauthenticated(`Token ${what} is not valid JSON`)
  }
}

// ---------------------------------------------------------------------------------------------
// Algorithms

type AlgSpec = { importParams: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams; verifyParams: AlgorithmIdentifier | RsaPssParams | EcdsaParams }

const ALGS: Record<JwtAlgorithm, AlgSpec> = {
  RS256: { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } },
  RS384: { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } },
  RS512: { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { importParams: { name: 'RSA-PSS', hash: 'SHA-256' }, verifyParams: { name: 'RSA-PSS', saltLength: 32 } },
  PS384: { importParams: { name: 'RSA-PSS', hash: 'SHA-384' }, verifyParams: { name: 'RSA-PSS', saltLength: 48 } },
  PS512: { importParams: { name: 'RSA-PSS', hash: 'SHA-512' }, verifyParams: { name: 'RSA-PSS', saltLength: 64 } },
  ES256: { importParams: { name: 'ECDSA', namedCurve: 'P-256' }, verifyParams: { name: 'ECDSA', hash: 'SHA-256' } },
  ES384: { importParams: { name: 'ECDSA', namedCurve: 'P-384' }, verifyParams: { name: 'ECDSA', hash: 'SHA-384' } },
  ES512: { importParams: { name: 'ECDSA', namedCurve: 'P-521' }, verifyParams: { name: 'ECDSA', hash: 'SHA-512' } },
  EdDSA: { importParams: { name: 'Ed25519' }, verifyParams: { name: 'Ed25519' } },
}

// ---------------------------------------------------------------------------------------------
// JWKS

export type JwkSet = {
  /** The signing key for one JWT header, refetching once if the `kid` is unknown (key rotation). */
  key(header: { kid?: string; alg: JwtAlgorithm }): Promise<CryptoKey>
}

const JWKS_REFETCH_COOLDOWN_MS = 30_000

/** A cached JWKS endpoint. One per issuer; shared by every adapter that points at it. */
export function createJwkSet(options: {
  jwksUri?: string
  issuer?: string
  cacheTtlMs?: number
  fetch?: typeof fetch
}): JwkSet {
  const ttl = options.cacheTtlMs ?? 5 * 60_000
  const fetchFn = options.fetch ?? globalThis.fetch
  let uri = options.jwksUri
  let keys: Jwk[] = []
  let fetchedAt = 0
  let inFlight: Promise<Jwk[]> | undefined
  const imported = new Map<string, CryptoKey>()

  async function discover(): Promise<string> {
    if (uri) return uri
    if (!options.issuer) throw errors.internal('jwt: neither jwksUri nor issuer was given')
    const url = `${options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
    const res = await fetchFn(url)
    if (!res.ok) throw errors.internal(`jwt: OIDC discovery failed (${res.status}) at ${url}`)
    const doc = (await res.json()) as { jwks_uri?: string }
    if (!doc.jwks_uri) throw errors.internal(`jwt: no jwks_uri in the discovery document at ${url}`)
    uri = doc.jwks_uri
    return uri
  }

  async function load(): Promise<Jwk[]> {
    const target = await discover()
    const res = await fetchFn(target)
    if (!res.ok) throw errors.internal(`jwt: JWKS fetch failed (${res.status}) at ${target}`)
    const doc = (await res.json()) as { keys?: Jwk[] }
    if (!Array.isArray(doc.keys)) throw errors.internal(`jwt: no keys in the JWKS at ${target}`)
    keys = doc.keys
    fetchedAt = Date.now()
    imported.clear()
    return keys
  }

  const refresh = () => (inFlight ??= load().finally(() => void (inFlight = undefined)))

  function select(list: Jwk[], header: { kid?: string; alg: JwtAlgorithm }): Jwk | undefined {
    const usable = list.filter((k) => (k.use ?? 'sig') === 'sig' && (!k.alg || k.alg === header.alg))
    if (header.kid) return usable.find((k) => k.kid === header.kid)
    return usable.length === 1 ? usable[0] : undefined
  }

  return {
    async key(header) {
      const cacheKey = `${header.kid ?? ''}:${header.alg}`
      const cached = imported.get(cacheKey)
      if (cached && Date.now() - fetchedAt < ttl) return cached
      if (!keys.length || Date.now() - fetchedAt >= ttl) await refresh()
      let jwk = select(keys, header)
      // An unknown kid is the ordinary shape of key rotation, so look again — but not on every
      // forged token: a cooldown keeps a junk `kid` from turning into a JWKS flood.
      if (!jwk && Date.now() - fetchedAt > JWKS_REFETCH_COOLDOWN_MS) {
        await refresh()
        jwk = select(keys, header)
      }
      if (!jwk) throw errors.unauthenticated(`Token was signed with an unknown key${header.kid ? ` "${header.kid}"` : ''}`)
      const spec = ALGS[header.alg]
      let key: CryptoKey
      try {
        key = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, spec.importParams, false, ['verify'])
      } catch (err) {
        throw errors.internal(`jwt: the JWKS key for "${header.kid ?? header.alg}" could not be imported`, err)
      }
      imported.set(cacheKey, key)
      return key
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Verification

const asList = (v: string | readonly string[] | undefined): string[] => (v === undefined ? [] : typeof v === 'string' ? [v] : [...v])

/**
 * Verify a JWT and return its claims. Throws `unauthenticated` for anything the caller controls
 * (shape, signature, issuer, audience, expiry) and `internal` for anything we control (a JWKS
 * that cannot be fetched).
 */
export async function verifyJwt(token: string, options: JwtVerifyOptions, jwks?: JwkSet): Promise<JwtClaims> {
  const issuers = asList(options.issuer)
  if (!issuers.length) throw errors.internal('jwt: at least one issuer is required')
  const allowed = options.algorithms ?? JWT_ALGORITHMS
  const tolerance = options.clockToleranceSec ?? 60

  const parts = token.split('.')
  if (parts.length !== 3) throw errors.unauthenticated('Token is not a JWT')
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]

  const header = decodeJson(rawHeader, 'header')
  const alg = header.alg
  if (typeof alg !== 'string' || !(JWT_ALGORITHMS as readonly string[]).includes(alg)) {
    throw errors.unauthenticated(`Token algorithm "${String(alg)}" is not supported`)
  }
  if (!(allowed as readonly string[]).includes(alg)) {
    throw errors.unauthenticated(`Token algorithm "${alg}" is not accepted by this app`)
  }
  const typ = header.typ
  if (typeof typ === 'string' && !/^(JWT|at\+jwt|application\/at\+jwt)$/i.test(typ)) {
    throw errors.unauthenticated(`Token type "${typ}" is not a JWT`)
  }

  const set = jwks ?? createJwkSet({ jwksUri: options.jwksUri, issuer: issuers[0], cacheTtlMs: options.cacheTtlMs, fetch: options.fetch })
  const key = await set.key({ kid: typeof header.kid === 'string' ? header.kid : undefined, alg: alg as JwtAlgorithm })

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  const signature = base64UrlToBytes(rawSignature)
  const ok = await crypto.subtle.verify(ALGS[alg as JwtAlgorithm].verifyParams, key, signature, signed)
  if (!ok) throw errors.unauthenticated('Token signature is invalid')

  const claims = decodeJson(rawPayload, 'payload') as JwtClaims
  const now = Math.floor(Date.now() / 1000)

  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) {
    throw errors.unauthenticated(`Token issuer "${String(claims.iss)}" is not accepted`)
  }
  const audiences = asList(options.audience)
  if (audiences.length) {
    const claimed = Array.isArray(claims.aud) ? claims.aud : claims.aud === undefined ? [] : [claims.aud]
    if (!claimed.some((a) => audiences.includes(a))) throw errors.unauthenticated('Token audience is not accepted')
  }
  if (options.requireExpiry !== false && typeof claims.exp !== 'number') {
    throw errors.unauthenticated('Token has no expiry')
  }
  if (typeof claims.exp === 'number' && claims.exp + tolerance <= now) throw errors.unauthenticated('Token has expired')
  if (typeof claims.nbf === 'number' && claims.nbf - tolerance > now) throw errors.unauthenticated('Token is not valid yet')
  if (typeof claims.iat === 'number' && claims.iat - tolerance > now) throw errors.unauthenticated('Token was issued in the future')
  return claims
}

// ---------------------------------------------------------------------------------------------
// Claims → principal

/** Scopes as the common claims spell them: OAuth `scope`, `scp`, or a permissions array. */
export function scopesFromClaims(claims: JwtClaims): string[] {
  const out: string[] = []
  const push = (value: unknown) => {
    if (typeof value === 'string') out.push(...value.split(/\s+/).filter(Boolean))
    else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') out.push(v)
  }
  push(claims.scope)
  push(claims.scp)
  push(claims.permissions)
  return [...new Set(out)]
}

/** `sub` as the id, OAuth scopes, and a service principal for a client-credentials token. */
export function principalFromClaims(claims: JwtClaims): Principal | null {
  if (typeof claims.sub !== 'string' || !claims.sub) return null
  const clientId = typeof claims.client_id === 'string' ? claims.client_id : undefined
  const machine = claims.gty === 'client-credentials' || (clientId !== undefined && clientId === claims.sub)
  const name = [claims.name, claims.email, claims.preferred_username].find((v) => typeof v === 'string') as string | undefined
  return {
    id: claims.sub,
    kind: machine ? 'service' : 'user',
    scopes: scopesFromClaims(claims),
    ...(name ? { name } : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// The adapter

export type JwtAdapterOptions = JwtVerifyOptions & {
  /** Adapter name, for `ctx.auth.adapter`. Default `jwt`. */
  name?: string
  /** Turn verified claims into a principal. Return `null` to decline the token. */
  principal?: (claims: JwtClaims) => Principal | null
  /** Extra checks once the signature and the registered claims are verified. */
  verifyClaims?: (claims: JwtClaims) => void | Promise<void>
}

/** True for anything shaped like a JWS compact serialization. Keeps non-JWT bearers for other adapters. */
function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token)
}

/**
 * Bearer JWTs verified against an issuer's JWKS.
 *
 * A bearer that is not JWT-shaped is declined with `null`, so API keys and opaque tokens fall
 * through to the next adapter. A bearer that *is* a JWT and fails verification is rejected.
 */
export function jwtAdapter(options: JwtAdapterOptions): AuthAdapter {
  const jwks = createJwkSet({
    jwksUri: options.jwksUri,
    issuer: asList(options.issuer)[0],
    cacheTtlMs: options.cacheTtlMs,
    fetch: options.fetch,
  })
  const toPrincipal = options.principal ?? principalFromClaims
  return defineAuthAdapter({
    name: options.name ?? 'jwt',
    async authenticate(ctx: AuthContext) {
      const token = ctx.credential?.token
      if (!token || !looksLikeJwt(token)) return null
      const claims = await verifyJwt(token, options, jwks)
      await options.verifyClaims?.(claims)
      const principal = toPrincipal(claims)
      if (!principal) return null
      return {
        principal,
        session: { claims },
        ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}),
      }
    },
  })
}
