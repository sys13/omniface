---
'omniface': minor
'@omniface/client': minor
'@omniface/cli': minor
'@omniface/testing': minor
---

Ship the packages as real npm packages: ESM plus type declarations built with `tsc`, subpath
exports (`omniface/zod`, `omniface/plugins`, `omniface/rest`, `omniface/mcp`) preserved, sources and maps
included, and `facet` installed as a bin with `--version`. Adds a changesets release pipeline that
publishes with npm provenance, a supported-runtime matrix (Node 20.11+, 22, 24, Bun) exercised in
CI by a fresh-install smoke run, and a documented public API surface — including the types that
were reachable from public signatures but never exported (`OpBuilder`, `ServerOptions`, the
per-facet override types, `ValidationIssue`, `Hook` and friends).
