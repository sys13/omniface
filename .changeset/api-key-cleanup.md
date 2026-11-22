---
'omniface': minor
'@omniface/testing': minor
---

API key cleanup and hygiene:

- `apiKeys({ delete: true })` adds `apiKeys.delete` (destructive, `apiKeys:write`), which removes one
  of the caller's revoked or expired keys for good; an active key is refused with `conflict` and has
  to be revoked first. `ApiKeyStore` gains `delete(id, principalId)`, implemented by the memory, file
  and SQL stores.
- `revokeAll` revokes and counts only live keys (unrevoked and unexpired), so its count is "keys that
  stopped working". Expired keys are no longer stamped revoked.
- `touch(id, at, client, ifOlderThan)`: the adapter passes `now - touchIntervalMs`, and `sqlKeyStore`
  writes with `WHERE last_used_at IS NULL OR last_used_at < ?`, so several processes sharing a table
  write about once per interval between them instead of once each.
- `AuthContext.client` carries what the facet knows about the caller (MCP `initialize` clientInfo,
  remembered across stateless HTTP requests). The key adapter records `client.name` as the last-used
  client, falling back to the User-Agent.
- `neverGrant` now also applies at authentication: a minted key whose stored scopes would satisfy a
  never-granted scope has them dropped from its principal (`*` is dropped whole). Seed keys keep
  their scopes. `apiKeyAdapter` takes `neverGrant` too, and `neverGrantedScopes(scopes, neverGrant)`
  names the offending scopes, for a startup check. `isLiveKey(record)` is exported.
- `@omniface/testing`: `apiKeyStoreCases` covers `delete`, expired keys under `revokeAll` and
  `touch`'s `ifOlderThan`, and now runs against every shipped store (memory, file, SQL on PGlite
  and node:sqlite).
