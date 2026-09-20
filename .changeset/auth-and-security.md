---
'omniface': minor
'@omniface/testing': minor
---

Auth adapters and safe HTTP defaults.

- `AuthAdapter`, a single contract over identity providers, and the `auth()` plugin that runs a
  list of them in the pipeline's `authenticate` stage — so every facet resolves identity the same
  way. An adapter declines with `null` (letting the next one try) and rejects what is its own
  shape but does not verify.
- Adapters in the new `omniface/auth` entry point: `jwtAdapter` (issuer + JWKS, verified with
  WebCrypto), `betterAuthAdapter` (a Better Auth instance or its HTTP API), `clerkAdapter`,
  `workosAdapter` and `apiKeyAdapter`. None adds a runtime dependency.
- CORS, CSRF and security headers are on by default for every HTTP facet, closed to cross-origin
  traffic until an origin is named. Configure or disable with `facets: { rest: { security } }`.
- Durable API-key stores: `fileKeyStore` and `sqlKeyStore` (+ `apiKeyTableSql`) alongside the
  in-memory one, and `apiKeyStoreCases()` in `@omniface/testing` — the conformance suite every
  `ApiKeyStore` implementation has to pass.
- `Invocation` and `InvokeInit` now carry the request `headers` on facets that have them, so
  cookie-session providers work over REST and MCP-over-HTTP.
- `apiKeys()` gains `authenticate: false` and exposes `.adapter`, to run as one provider among
  several.
