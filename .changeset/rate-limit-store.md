---
'omniface': minor
---

`rateLimit()` takes a `store`, so token buckets can live in a database or Redis and limits hold
across instances. A store implements `take({ key, requests, windowSeconds, cost, now })` and returns
`{ ok: true }` or `{ ok: false, retryAfter }`; it must be atomic per key. The default,
`memoryRateLimitStore()`, keeps the old per-process behaviour but is now bounded (`maxKeys`,
default 10 000): refilled buckets are dropped when full, and a new key is refused while every
bucket is still live. `retryAfterSeconds` is exported for stores that want the same hint.
