# @omniface/cli

## 0.1.0

### Minor Changes

- 9ba7005: The plugin platform: a per-facet `adapters` slot, an authoring kit, a conformance kit, OpenTelemetry,
  and identical MCP audit records on both transports.
  
  - `definePlugin({ adapters })` — the only place a plugin may touch a facet, and still barred from
    deciding whether an operation runs. A REST adapter may read a credential the default reader
    misses, mount routes under `/_<plugin>`, add response headers and advertise OpenAPI security
    schemes; an MCP adapter may read a credential, attribute a caller and add instructions; CLI and
    SDK adapters *declare* flags, command aliases and constructor options, which travel to those
    out-of-process facets in the manifest as `manifest.adapters`. Nothing in the slot receives an
    `Invocation`. Everything checkable — a flag that shadows a built-in, a command naming an unknown
    op, a route outside its namespace — is checked when the app is created.
  - `apiKeys()` uses the slot: an `apiKey` security scheme in OpenAPI, and a `whoami` CLI command.
  - `otel()` in `omniface/plugins`: one span per invocation plus RED metrics (`omniface.op.calls`,
    `omniface.op.errors`, `omniface.op.duration`) tagged by facet, op and outcome. `@opentelemetry/api` is
    an optional peer dependency — absent, the plugin does nothing; passed as `otel({ api })`, nothing
    is imported dynamically.
  - `pluginCases()` and `runPluginConformance()` in `@omniface/testing`, with `createSampleApp()`: run a
    plugin against a sample app on every facet and check it installs, projects, agrees across facets,
    leaves an app that does not use it unchanged, and stays inside the adapters slot.
  - MCP over Streamable HTTP now records the calling agent's name, so logs and audit records are
    identical to stdio's. The stateless transport handles `initialize` and `tools/call` as separate
    requests, so the handler remembers what an `initialize` announced, keyed by the credential and the
    HTTP client presenting it. Attribution only: it grants nothing.
  - The CLI engine renders plugin-contributed global flags (with their env vars) and command aliases,
    in help and in parsing.
- 9ba7005: Ship the packages as real npm packages: ESM plus type declarations built with `tsc`, subpath
  exports (`omniface/zod`, `omniface/plugins`, `omniface/rest`, `omniface/mcp`) preserved, sources and maps
  included, and `facet` installed as a bin with `--version`. Adds a changesets release pipeline that
  publishes with npm provenance, a supported-runtime matrix (Node 20.11+, 22, 24, Bun) exercised in
  CI by a fresh-install smoke run, and a documented public API surface — including the types that
  were reachable from public signatures but never exported (`OpBuilder`, `ServerOptions`, the
  per-facet override types, `ValidationIssue`, `Hook` and friends).

### Patch Changes

- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
  - @omniface/client@0.1.0
