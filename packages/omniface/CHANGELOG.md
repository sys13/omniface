# omniface

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
- 9ba7005: `omniface diff <before> <after>` — what changed between two versions of an app, and which facets it
  breaks.
  
  One definition projects onto four interfaces, and they disagree about almost every change, so the
  report is per facet rather than a single verdict: a renamed output type breaks a generated SDK and
  an OpenAPI component and is invisible to MCP and the CLI; a newly `destructive` op breaks CLI
  scripts, which now stop at a prompt, and nothing else; widening an output enum breaks callers with
  an exhaustive switch while widening an input enum breaks nobody. Each change carries a level
  (`breaking`, `additive`, `neutral`), the facets it lands on, and a line saying why. The report ends
  in one sentence — "Breaks rest and cli, not mcp and sdk." — and a suggested version bump.
  
  - Either side may be a `manifest.json` written by `omniface build` or an app module, so the normal
    invocation is `omniface diff .omniface/manifest.json src/app.ts`: released against about-to-be-released.
  - `--strict` turns a breaking change into an exit code, `--quiet` hides the neutral changes, and
    `--json` is the same data for a bot. Without `--strict` the command exits 0: breaking on purpose
    is a release decision, and the command's job is only that nobody finds out afterwards.
  - The engine is `diffManifests(before, after)`, with `formatDiff()` and `verdict()` beside it,
    exported from `facet`. It compares manifests rather than definitions, so anything a facet's
    projection starts publishing is diffed the moment it reaches the manifest.
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
- 9ba7005: `omniface lint --fix` inserts the `t.named()` the named-type rules ask for, and the recursive-schema
  rule now fires on the shape a recursive type actually has.
  
  - **The rule was checking for the wrong thing.** It looked for `$defs`, and zod 4 does not emit
    one: a recursive type comes out as a bare `{ "$ref": "#" }` at the recursion point, with no
    `$defs` anywhere — so the `error` never fired for the case it exists for. Any internal `$ref` now
    counts as recursion, which is the property that matters: an anonymous self-referential type gives
    the reference nothing to point at, and every generator downstream has to invent a name or inline
    forever.
  - **`--fix` prefers the name the schema already has.** `const Task = z.object({…})` becomes
    `const Task = t.named('Task', z.object({…}))`, which fixes every op sharing it at once; an
    expression written inline gets the derived name (`TasksCreateOutput`). The `t` import is added if
    the file does not already bind one, and `Task as z.ZodObject<any>` is seen through, since an
    assertion says something about the type rather than about which schema the op was handed.
  - **A wrong edit never survives.** The edits are made by a scanner — facet has no TypeScript parser
    at runtime — so every fix is checked by re-linting in a fresh process, fresh because the
    rewritten files are modules the fixing process already imported. If the app stops loading, or a
    finding the fix claimed to resolve is still there, every file is restored byte for byte. Shapes
    the scanner does not recognise, including a schema imported from another file, are declined with
    the edit to make by hand rather than guessed at.
  - `omniface lint --json` prints the findings as data, each carrying the op it is about and the fix it
    would accept. New exports: `planNamedTypeFixes`, `applyNamedTypeFixes`, `applyFixPlans`,
    `captureDefinitionSites`, `definitionSite`.
  - `captureDefinitionSites()` is off by default. Recording where each op was written costs a stack
    capture per op, which is pure cost to an app that is only going to run; `omniface lint --fix` turns
    it on before importing the entry.
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
- 9ba7005: SDK distribution: a generated SDK package for consumers outside the repo, named types hoisted into
  OpenAPI components, and the `x-omniface-*` extensions an outside generator reads.
  
  - `omniface build` now writes `.omniface/sdk/` beside the CLI package: a publishable package with a
    generated `index.d.ts`, a constructor over `@omniface/client` with the manifest embedded, and a
    README. Its name comes from `facets.sdk.packageName` (default `<app>-sdk`), which the manifest
    now carries. Types are generated; request code never is — the methods are the same proxy over
    the same manifest the inferred client and the CLI engine use, so there is no generated request
    body for a hand edit to drift away from the definition. `t.named('Task', …)` becomes one exported
    `Task`, field and op traits become the JSDoc a consumer reads, and `internal` fields are absent
    because they are stripped before the manifest exists.
  - Named types are hoisted into `components.schemas`. This fixes a broken document as well as
    improving one: zod 4 emits a recursive type as a bare `{ "$ref": "#/$defs/…" }` rooted at the
    *operation's* schema, and inlined into an OpenAPI document — where `#` is the document — that
    reference resolved to nothing. Any app with a recursive named type was emitting OpenAPI no
    generator could read. A name used for two different shapes is reported rather than renamed
    around, because which shape kept the bare name would otherwise depend on declaration order.
  - Every operation in the OpenAPI document carries `x-omniface-op`, `x-omniface-traits`, `x-omniface-errors`,
    `x-omniface-pagination`, and what the op is called on the other three facets (`x-omniface-sdk`,
    `x-omniface-cli`, `x-omniface-mcp`); the document carries `x-facet`. `docs/SDKS.md` is the reference,
    and `examples/tasks/sdks/` has starting configurations for Stainless, Speakeasy, Fern and the
    open-source generators — none of which runs in CI.
  - `omniface diff` reports `sdk-package-renamed` as breaking on the SDK facet. A renamed package
    breaks a consumer's `import`, which no change to any op would have shown — the same reason the
    CLI bin name is already diffed.
  - `@omniface/client`: a paginated method gains `.autoPaginate()` (every page, collected) beside
    `.iterate()`, on the inferred client and the generated package alike; `Caller` gains `collect`.
    Plugin-declared SDK constructor options are now plumbed into the generated package, arriving as
    typed options and sent as the header or credential the plugin declared.

### Patch Changes

- 9ba7005: `omniface build` emitted a generated SDK that did not compile when a named type was a union.
  
  `t.named('PaymentMethod', z.discriminatedUnion(…))` rendered as
  `export interface PaymentMethod { … } | { … }`, which is not parseable TypeScript, so the whole
  generated package failed to typecheck rather than just that type. The declaration emitter chose
  `interface` by asking whether the rendered body started with `{`, which a union of objects also
  does; it now asks the schema for branch keys. A named union is emitted as a `type` alias, and a
  named object is still an `interface`.
  
  `omniface lint --fix` also reported the wrong reason for declining to name a schema that is declared
  inside a function rather than at the top level of a file — the shape an app that generates its ops
  in a loop always has. Declining is still correct; the message now says why and what to do instead.
  
  Both were found by modelling Stripe and Kubernetes in `examples/expressibility`
  ([docs/EXPRESSIBILITY.md](../docs/EXPRESSIBILITY.md)).
