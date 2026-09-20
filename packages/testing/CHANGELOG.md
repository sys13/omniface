# @omniface/testing

## 0.1.0

### Minor Changes

- 9ba7005: Auth adapters and safe HTTP defaults.
  
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
- 9ba7005: Contract safety: the drift proof as a command, a coverage report for the two inputs it cannot
  generate, and two lints that keep traits and overrides honest.
  
  - `omniface conformance <entry>` runs the generated suite from a terminal or CI. The checks divide by
    what they need, so the command has a zero-setup mode: the contract checks read the manifest and
    call nothing, and run against any app with no credential and no fixtures. The rest wait for a
    `conformance.fixtures.ts` beside the entry, which is the same object the vitest suite passes — so
    the command and the suite run the same cases rather than two drifting copies. `@omniface/testing` is
    an optional peer, resolved from the app's own `node_modules`.
  - `conformanceCoverage()` in `@omniface/testing` reports which cases an app gets and which ones a
    hand-written `ops[id].input` would add. It is a diff, not a restatement of the rules: cases are
    generated twice, once as the app stands and once with a placeholder input for every op, so
    whatever `conformanceCases` decides an input unlocks is what gets reported. `--strict` turns a
    gap into an exit code.
  - `override-budget` lint: warns when more than a third of a facet's ops carry a per-op override,
    which is the ladder's step 3 having stopped being an exception. Turning a projection off is step
    2 and is not counted.
  - `unused-trait` lint: traits set on a schema no op reaches, so a `pii` that redacts nothing or an
    `internal` that strips nothing is visible rather than silent. Opt-in via `lint(app, manifest,
    { unusedTraits: true })`, because the trait registry is process-wide and an orphan belongs to no
    app; `omniface lint` turns it on. Note that schema methods do *not* strand traits — zod's clones stay
    visible to the adapter's conversion callback, and that behaviour is now pinned by tests.
  - Generated conformance gives a destructive, non-idempotent op a fresh app per facet. Driving four
    facets at one app meant the first delete consumed the row and the other three answered
    `not_found`, so the case could never pass; now `tasks.delete` is proven to agree across facets.
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
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
  - omniface@0.1.0
  - @omniface/cli@0.1.0
  - @omniface/client@0.1.0
