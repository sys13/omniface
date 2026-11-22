---
'omniface': minor
---

MCP over HTTP can require a token the way the MCP authorization spec expects. `McpHttpOptions` gains
`oauth` (a protected-resource description for this endpoint, defaulting to `app.oauth`),
`unauthenticated: 'refuse'` (a credential-less request is answered `401` with the `WWW-Authenticate`
challenge instead of being served) and `verifyCredential` (a transport-level recognition check; a
credential it rejects is answered `401` with `error="invalid_token"`, so an OAuth client refreshes).
The pipeline still authenticates and authorizes every call.
