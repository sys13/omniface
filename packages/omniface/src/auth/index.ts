// `facet/auth` — one contract over identity providers, and the adapters that implement it.

export {
  defineAuthAdapter,
  type AuthAdapter,
  type AuthContext,
  type AuthSession,
} from './adapter.ts'
export { auth, type AuthOptions, type AuthState } from './plugin.ts'
export {
  createJwkSet,
  jwtAdapter,
  principalFromClaims,
  scopesFromClaims,
  verifyJwt,
  JWT_ALGORITHMS,
  type Jwk,
  type JwkSet,
  type JwtAdapterOptions,
  type JwtAlgorithm,
  type JwtClaims,
  type JwtVerifyOptions,
} from './jwt.ts'
export {
  betterAuthAdapter,
  type BetterAuthAdapterOptions,
  type BetterAuthApi,
  type BetterAuthResult,
  type BetterAuthSession,
  type BetterAuthUser,
} from './better-auth.ts'
export { clerkAdapter, type ClerkAdapterOptions, type ClerkClaims } from './clerk.ts'
export { workosAdapter, workOsIssuer, workOsJwksUri, type WorkOsAdapterOptions, type WorkOsClaims } from './workos.ts'
/** API keys as an adapter, so they can be one provider among several. */
export { apiKeyAdapter, hashApiKey, type ApiKeyAdapterOptions } from '../plugins/api-keys.ts'
