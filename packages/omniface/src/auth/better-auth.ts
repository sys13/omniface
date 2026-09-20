import { errors } from '../errors.ts'
import type { Principal } from '../op.ts'
import { defineAuthAdapter, type AuthAdapter, type AuthContext } from './adapter.ts'

/**
 * Better Auth, without depending on Better Auth.
 *
 * Its server instance exposes `auth.api.getSession({ headers })`, so the adapter takes anything
 * with that method — the real instance, typed structurally, with no import and no version pin.
 * When the app and the auth server are separate processes, point `baseUrl` at the Better Auth
 * server instead and the same contract is read over its HTTP API.
 */

export type BetterAuthUser = {
  id: string
  name?: string | null
  email?: string | null
  role?: string | null
  [key: string]: unknown
}

export type BetterAuthSession = {
  id?: string
  token?: string
  userId?: string
  expiresAt?: string | Date | null
  [key: string]: unknown
}

export type BetterAuthResult = { user?: BetterAuthUser | null; session?: BetterAuthSession | null } | null

/** The one method this adapter needs from a Better Auth server instance. */
export type BetterAuthApi = {
  api: { getSession(input: { headers: Headers }): Promise<BetterAuthResult> }
}

export type BetterAuthAdapterOptions = {
  /** A Better Auth server instance (or anything with `api.getSession`). */
  auth?: BetterAuthApi
  /** Or the base URL of a Better Auth server, read over HTTP. One of `auth` / `baseUrl` is required. */
  baseUrl?: string
  /** Better Auth's mount path under `baseUrl`. Default `/api/auth`. */
  basePath?: string
  fetch?: typeof fetch
  /** Adapter name, for `ctx.auth.adapter`. Default `better-auth`. */
  name?: string
  /**
   * Scopes for a session. Better Auth models roles and permissions per app, so facet does not
   * guess: the default reads `user.scopes` / `user.permissions` if the app put them there.
   */
  scopes?: (result: { user: BetterAuthUser; session?: BetterAuthSession }) => string[]
  /** Full control over the principal. Return `null` to decline the session. */
  principal?: (result: { user: BetterAuthUser; session?: BetterAuthSession }) => Principal | null
}

function defaultScopes({ user }: { user: BetterAuthUser }): string[] {
  for (const key of ['scopes', 'permissions'] as const) {
    const value = user[key]
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
    if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  }
  return []
}

function expirySeconds(session: BetterAuthSession | undefined): number | undefined {
  const raw = session?.expiresAt
  if (!raw) return undefined
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw))
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** The headers Better Auth reads: the session cookie, or a bearer token from its bearer plugin. */
function forwardHeaders(ctx: AuthContext): Headers | undefined {
  const out = new Headers()
  const cookie = ctx.headers?.get('cookie')
  if (cookie) out.set('cookie', cookie)
  const auth = ctx.headers?.get('authorization')
  if (auth) out.set('authorization', auth)
  else if (ctx.credential) out.set('authorization', `Bearer ${ctx.credential.token}`)
  return out.has('cookie') || out.has('authorization') ? out : undefined
}

export function betterAuthAdapter(options: BetterAuthAdapterOptions): AuthAdapter {
  if (!options.auth && !options.baseUrl) {
    throw new Error('facet: betterAuthAdapter() needs either `auth` (a Better Auth instance) or `baseUrl`')
  }
  const fetchFn = options.fetch ?? globalThis.fetch
  const basePath = options.basePath ?? '/api/auth'
  const toScopes = options.scopes ?? defaultScopes

  async function getSession(headers: Headers): Promise<BetterAuthResult> {
    if (options.auth) return options.auth.api.getSession({ headers })
    const url = `${options.baseUrl!.replace(/\/$/, '')}${basePath}/get-session`
    const res = await fetchFn(url, { headers })
    // Better Auth answers 401 for "no session", which is a decline, not an outage.
    if (res.status === 401 || res.status === 404) return null
    if (!res.ok) throw errors.internal(`better-auth: get-session failed (${res.status}) at ${url}`)
    const text = await res.text()
    if (!text.trim()) return null
    return JSON.parse(text) as BetterAuthResult
  }

  return defineAuthAdapter({
    name: options.name ?? 'better-auth',
    async authenticate(ctx) {
      const headers = forwardHeaders(ctx)
      if (!headers) return null
      const result = await getSession(headers)
      const user = result?.user
      if (!user || typeof user.id !== 'string') return null
      const session = result?.session ?? undefined
      const principal: Principal | null = options.principal
        ? options.principal({ user, session })
        : {
            id: user.id,
            kind: 'user',
            scopes: toScopes({ user, session }),
            ...(user.name ? { name: user.name } : user.email ? { name: user.email } : {}),
          }
      if (!principal) return null
      return {
        principal,
        session: { provider: 'better-auth', user, ...(session ? { session } : {}) },
        ...(expirySeconds(session) !== undefined ? { expiresAt: expirySeconds(session)! } : {}),
      }
    },
  })
}
