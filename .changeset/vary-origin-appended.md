---
'omniface': patch
---

The security middleware adds `Origin` to a `Vary` header set upstream instead of replacing it, so
a plugin's or a route's own `Vary` survives.
