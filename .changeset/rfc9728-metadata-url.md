---
'omniface': patch
---

The `WWW-Authenticate` challenge for a resource with a path now points where RFC 9728 §3.1 puts its
metadata: `https://host/.well-known/oauth-protected-resource/mcp` for `https://host/mcp`, not
`https://host/mcp/.well-known/oauth-protected-resource`. `protectedResourceMetadataUrl(resource)` is
exported for serving the document at that path.
