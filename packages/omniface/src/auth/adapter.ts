import type { FacetName, Principal } from '../op.ts'
import type { Credential } from '../plugin.ts'

/**
 * One contract over identity providers.
 *
 * An adapter is handed what the facet knows about the caller and answers with a principal or
 * `null`. `null` means "not mine" — the next adapter gets a turn — and is how several providers
 * (an API key, a Better Auth cookie, a machine JWT) coexist on one app. A credential that *is*
 * this adapter's shape but does not verify is a `FacetError`, not a `null`: a forged token must
 * not fall through to the next adapter and end up anonymous.
 */
export interface AuthAdapter {
  /** Shows up in `ctx.auth.adapter`, in logs and in error messages. */
  readonly name: string
  authenticate(ctx: AuthContext): Promise<AuthSession | null> | AuthSession | null
}

/** What every facet can say about a caller. `headers` is present only on HTTP-borne facets. */
export type AuthContext = {
  readonly credential?: Credential
  /** The raw request headers, for cookie-session providers. Absent on stdio MCP and in-process calls. */
  readonly headers?: Headers
  readonly facet: FacetName
  readonly requestId: string
}

export type AuthSession = {
  principal: Principal
  /** Whatever the provider knows that an app might want: session id, org, tenant, raw claims. */
  session?: Record<string, unknown>
  /** Seconds since the epoch. The pipeline refuses a session that has already expired. */
  expiresAt?: number
}

/** Identity function, for the types. */
export function defineAuthAdapter(adapter: AuthAdapter): AuthAdapter {
  return adapter
}
