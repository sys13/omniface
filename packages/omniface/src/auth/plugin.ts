import { FacetError, errors } from '../errors.ts'
import { definePlugin } from '../plugin.ts'
import type { AuthAdapter, AuthContext } from './adapter.ts'

/** What `auth()` puts on `ctx.auth`. `null` means nobody authenticated this call. */
export type AuthState = {
  /** The adapter that answered. */
  adapter: string
  session?: Record<string, unknown>
  expiresAt?: number
} | null

export type AuthOptions = {
  /** Tried in order; the first one that does not return `null` wins. */
  adapters: readonly AuthAdapter[]
  /**
   * What to do with a credential no adapter recognises. `reject` (the default) answers
   * `unauthenticated`, so a stale or mistyped token fails loudly instead of silently
   * downgrading the caller to anonymous.
   */
  onUnknownCredential?: 'reject' | 'anonymous'
}

/**
 * Fills the pipeline's `authenticate` stage from a list of {@link AuthAdapter}s, so every facet
 * resolves `ctx.user`-style identity the same way. Authorization stays where it was: `scopes()`
 * reads the principal this produces.
 *
 * Install it *before* any other plugin that authenticates. `apiKeys()` authenticates by default;
 * to run API keys alongside another provider, pass its adapter here and turn its own hook off:
 *
 * ```ts
 * const keys = apiKeys({ prefix: 'acme_', authenticate: false })
 * facet({ plugins: [auth({ adapters: [keys.adapter, jwtAdapter({ issuer })] }), keys, scopes()] })
 * ```
 */
export function auth(options: AuthOptions) {
  const adapters = [...options.adapters]
  if (adapters.length === 0) throw new Error('facet: auth() needs at least one adapter')
  const seen = new Set<string>()
  for (const a of adapters) {
    if (seen.has(a.name)) throw new Error(`facet: auth() has two adapters named "${a.name}"`)
    seen.add(a.name)
  }
  const onUnknown = options.onUnknownCredential ?? 'reject'

  return definePlugin<{ auth: AuthState }>({
    name: 'auth',
    hooks: {
      async authenticate(inv) {
        // Another plugin already said who this is; adapters do not get to overwrite it.
        if (inv.principal.kind !== 'anonymous') return
        const ctx: AuthContext = {
          credential: inv.credential,
          headers: inv.headers,
          facet: inv.facet,
          requestId: inv.requestId,
        }
        for (const adapter of adapters) {
          let result
          try {
            result = await adapter.authenticate(ctx)
          } catch (err) {
            // A bad token is the adapter's own verdict and is rendered as it threw it. Anything
            // else (a JWKS fetch that failed, a provider that is down) is our fault, not the
            // caller's, and must not read as "your credential is invalid".
            if (err instanceof FacetError) throw err
            throw errors.internal(`Auth adapter "${adapter.name}" failed`, err)
          }
          if (!result) continue
          if (result.expiresAt !== undefined && result.expiresAt * 1000 <= Date.now()) {
            throw errors.unauthenticated('Session has expired')
          }
          inv.principal = result.principal
          inv.ctx.auth = {
            adapter: adapter.name,
            ...(result.session ? { session: result.session } : {}),
            ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
          } satisfies AuthState
          return
        }
        inv.ctx.auth = null
        if (inv.credential && onUnknown === 'reject') {
          throw errors.unauthenticated('Credential was not recognised by any auth adapter')
        }
      },
    },
  })
}
