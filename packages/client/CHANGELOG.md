# @omniface/client

## 0.1.0

### Minor Changes

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

- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
- Updated dependencies [9ba7005]
  - omniface@0.1.0
