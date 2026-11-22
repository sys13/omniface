---
'omniface': minor
---

Building an app, a manifest or a server no longer re-derives every schema each time. A schema's
JSON Schema is converted once per direction and shared, deep-frozen; `publicSchema` and the
untrusted-output check are memoized on those frozen schemas; `/openapi.json` is built on first
request rather than when the REST app is created. A process that builds many apps — a test suite,
or conformance's fresh app per case — spends a fraction of the time it did (an app of ~75 ops went
from ~40ms to ~10ms to build plus harness).

`toJSONSchema` now returns a frozen object, shared between callers: code that changed its result
in place has to copy it first, or it throws.
