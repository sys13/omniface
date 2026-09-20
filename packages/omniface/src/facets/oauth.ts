import type { Manifest } from '../manifest.ts'

/**
 * Where a caller goes to get a credential — OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * This is discovery, not authentication. omniface does not issue tokens and does not become an
 * authorization server: Gate 4 says identity is somebody else's job, and nothing here changes what
 * a token *means* — that is still the `authenticate` stage's business, unchanged. What was missing
 * is the other half of the handshake. An agent that reaches an MCP server it has no credential for
 * has no way to find out where to get one, so a token has to be handed to it out of band; the
 * whole point of a standard discovery document is that it does not.
 *
 * The scopes are the ones the ops already declare. An app that lists its scopes here by hand would
 * be describing its own authorization a second time, and the second description is the one that
 * goes stale.
 */

/** RFC 9728 §2, the subset an app declares. */
export type OAuthResourceConfig = {
  /**
   * The authorization servers that issue tokens for this resource. At least one, and every one of
   * them is somebody else's — an app names its identity provider here, it does not become one.
   */
  authorizationServers: readonly string[]
  /**
   * The resource identifier tokens are audienced to. Defaults to the origin the request arrived
   * on, which is right in development and wrong behind a proxy, so name it in production.
   */
  resource?: string
  /** Overrides the scopes derived from the ops' `scope` traits. Prefer letting them derive. */
  scopes?: readonly string[]
  /** A page a human can read about getting access. */
  documentation?: string
  /** How a token may be presented. Default `header` — and it is the only one facet reads. */
  bearerMethods?: readonly ('header' | 'body' | 'query')[]
}

/** The well-known path RFC 9728 puts the document at, relative to the resource's origin. */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'

/** Every scope the app's ops declare, sorted. The authorization it already has, said outward. */
export function declaredScopes(manifest: Manifest): string[] {
  const scopes = new Set<string>()
  for (const op of manifest.ops) {
    const scope = op.traits.scope
    if (typeof scope === 'string' && scope) scopes.add(scope)
  }
  return [...scopes].sort()
}

/**
 * The document itself. `origin` is where the request arrived, used only when the app did not name
 * a resource — a proxy makes that guess wrong, which is why naming one is the documented advice.
 */
export function protectedResourceMetadata(
  config: OAuthResourceConfig,
  manifest: Manifest,
  origin: string,
): Record<string, unknown> {
  return {
    resource: config.resource ?? origin,
    authorization_servers: [...config.authorizationServers],
    scopes_supported: [...(config.scopes ?? declaredScopes(manifest))],
    bearer_methods_supported: [...(config.bearerMethods ?? ['header'])],
    ...(config.documentation ? { resource_documentation: config.documentation } : {}),
    resource_name: manifest.name,
  }
}

/**
 * The `WWW-Authenticate` value that points a caller at the document (RFC 9728 §5.1). This is the
 * only thing that makes the document findable: a caller that has been refused learns from the
 * refusal itself where to go, rather than having to know in advance.
 */
export function challenge(config: OAuthResourceConfig, origin: string, error?: 'invalid_token'): string {
  const url = `${config.resource ?? origin}${PROTECTED_RESOURCE_PATH}`
  const params = [`resource_metadata="${url}"`, ...(error ? [`error="${error}"`] : [])]
  return `Bearer ${params.join(', ')}`
}

/** The origin a request arrived on, for the `resource` default. */
export function originOf(request: Request): string {
  const url = new URL(request.url)
  return `${url.protocol}//${url.host}`
}
