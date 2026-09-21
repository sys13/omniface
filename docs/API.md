# Public API surface

The rule: **a name re-exported from a package entry point is public. Everything else is internal
and may change in any release.** The entry points are `facet`, `omniface/auth`, `omniface/zod`,
`omniface/plugins`, `omniface/rest`, `omniface/mcp`, `@omniface/client`, `@omniface/cli` and `@omniface/testing` —
deep imports like
`facet/dist/manifest.js` are not, and the `exports` map blocks them.

`test/packaging.test.ts` holds the full list of names, so adding or removing one is a visible diff
on a file whose whole purpose is to be reviewed. [RELEASING.md](RELEASING.md) says what a version
bump promises about it.

## `facet`

**Core — defining and running an app.** The surface an app author touches.

| Name | What |
| --- | --- |
| `facet`, `Facet`, `App`, `AppConfig`, `FacetsConfig`, `OpIds`, `InvokeInit`, `NormalizedFacets` | The app factory and its configuration |
| `RestConfig`, `RestOverride`, `CliConfig`, `CliOverride`, `McpConfig`, `McpOverride`, `McpToolGroup`, `SdkConfig`, `WebConfig`, `WebOverride` | Per-facet configuration and the typed overrides |
| `op`, `OpBuilder`, `OpConfig`, `OpFactory`, `Op`, `OpsTree`, `HandlerArgs`, `FacetName` | Operations: the builder, what a handler receives, where ops live |
| `Principal`, `anonymous` | Who is calling |
| `errors`, `FacetError`, `FacetErrorOptions`, `ERROR_CODES`, `ErrorCode`, `toFacetError` | The one error model every facet renders |
| `paginate` | Cursor pagination for a `paginated` op |
| `serve`, `createServer`, `ServerOptions` | The HTTP server behind REST, MCP and the inspector |
| `renderScreen`, `renderIndex`, `escapeHtml`, `ScreenContext` | The web facet's renderer: one screen of the web projection, as HTML |
| `createWebApp`, `WebAppOptions`, `WEB_CSP` | The web facet mounted: every screen as a route, with its own CSP and a CSRF token on every write |
| `webTools`, `WebTool`, `agentMayCall`, `WebAgentConfig`, `AgentAllow` | What the page offers the browser's agent over WebMCP — one declaration, read by the registration and by the pipeline that refuses the rest |

**Core — the tooling behind the `facet` bin.** Public because CI and editors call it directly.

| Name | What |
| --- | --- |
| `build`, `BuildOptions`, `BuildResult` | Write `.omniface/`: manifest, OpenAPI, `llms.txt`, the generated SDK package, the CLI package |
| `buildManifest`, `Manifest`, `ManifestOp`, `ManifestTool`, `ManifestScreen`, `ManifestAdapters`, `MANIFEST_VERSION`, `isUntrusted` | The manifest every facet and the CLI engine read |
| `inspectAll`, `inspectOp`, `OpInspection` | One op on every facet, as data |
| `lint`, `LintFinding`, `LintOptions`, `MCP_TOOL_BUDGET`, `OVERRIDE_BUDGET` | The definition lints |
| `planNamedTypeFixes`, `applyNamedTypeFixes`, `applyFixPlans`, `FixPlan`, `FixResult`, `FixIO`, `Unfixable`, `FixError` | What `omniface lint --fix` rewrites, and the check around it |
| `captureDefinitionSites`, `definitionSite` | Where each op was written; off unless asked, and only `--fix` asks |
| `diffManifests`, `formatDiff`, `verdict`, `ManifestDiff`, `ManifestChange`, `ChangeLevel`, `FacetKey`, `FormatDiffOptions` | The breaking-change diff, answered once per facet |

**Extension — authoring a facet.** A facet is a module, not a set of keys the core knows. The
authoring guide is [FACETS.md](FACETS.md).

| Name | What |
| --- | --- |
| `defineFacet`, `registerFacet`, `FacetModule` | The contract, and how a facet joins the registry |
| `facetModules`, `facetModule`, `enabledFacets` | The registry: every facet, in the order output uses |
| `projectionOf`, `settingsOf` | Reading a facet's slot out of a manifest keyed by facet name |
| `ProjectionContext`, `PresentationContext`, `ContractContext`, `FacetPresentation`, `FacetChange`, `FacetServer` | What each hook is handed and what it returns |
| `restOf`, `mcpOf`, `mcpSettings`, `mcpTools`, `cliOf`, `cliSettings`, `sdkOf`, `sdkSettings`, `webOf`, `webSettings` | The five shipped facets' own accessors, and their projection and settings types |

**Extension — authenticating a caller.** The contract lives in the core because the pipeline reads
it; the adapters that implement it are `omniface/auth`.

| Name | What |
| --- | --- |
| `AuthAdapter`, `AuthContext`, `AuthSession`, `defineAuthAdapter` | One contract over identity providers |
| `securityMiddleware`, `SecurityConfig`, `CorsConfig`, `CsrfConfig`, `SecurityHeadersConfig`, `OriginMatcher` | CORS, CSRF and security headers, and what `facets.rest.security` accepts |
| `DEFAULT_ALLOW_HEADERS`, `DEFAULT_EXPOSE_HEADERS`, `DEFAULT_METHODS` | The CORS defaults, so an app can extend rather than replace them |

**Extension — writing a plugin.** The authoring guide is [PLUGINS.md](PLUGINS.md).

| Name | What |
| --- | --- |
| `definePlugin`, `Plugin`, `Hook`, `HookStage`, `STAGES`, `Stage` | The plugin shape and the pipeline stages it can fill |
| `Invocation`, `RegisteredOp`, `Credential` | What a hook sees |
| `FacetAdapters`, `PluginAdapters` | The per-facet `adapters` slot: the only place a plugin may touch a facet |
| `RestFacetAdapter`, `RestPluginRoute`, `RestRouteContext`, `RestResultContext`, `SecurityScheme` | What a plugin may add to REST: a credential reader, namespaced routes, response headers, security schemes |
| `McpFacetAdapter`, `McpCallContext` | What a plugin may add to MCP: a credential reader, caller attribution, instructions |
| `CliFacetAdapter`, `CliFlagSpec`, `CliCommandSpec`, `SdkFacetAdapter`, `SdkOptionSpec` | Declarations the manifest carries to the facets that run elsewhere |
| `adapterProblems`, `restNamespace`, `RESERVED_CLI_FLAGS`, `RESERVED_CLI_COMMANDS`, `RESERVED_SDK_OPTIONS` | The validation the app runs at startup, and the names a plugin may not take |

None of those adapter members is handed an `Invocation`: an adapter presents a facet, it never
decides whether an operation runs. That decision stays in the pipeline (Gate 1).

**Extension — schemas and traits.** Mostly for schema adapters (`omniface/zod` is one) and for
facets that have to read what a schema advertises.

| Name | What |
| --- | --- |
| `registerSchemaAdapter`, `SchemaAdapter`, `toJSONSchema`, `JSONSchema`, `IO` | Teaching facet a schema library |
| `validate`, `StandardSchemaV1`, `AnySchema`, `ValidationIssue`, `InferIn`, `InferOut` | Standard Schema, the base of the type layer |
| `getFieldTraits`, `setFieldTraits`, `setSchemaName`, `FieldTraits`, `OpTraits` | Traits on a schema |
| `objectProperties`, `requiredProperties`, `hasTrait`, `exampleValue` | Reading a JSON Schema the way the facets do |
| `presentFields`, `presentValue`, `tableColumns`, `humanLabel`, `MASK`, `FieldPresentation`, `FieldDisplay` | The one table of rules a facet aimed at a person renders fields by — the CLI's tables and the web facet's screens both read it |
| `publicSchema`, `stripInternal`, `redact` | What `internal`, `sensitive` and `pii` mean in practice |

### Other `facet` entry points

- **`omniface/zod`** — `t`: the Zod adapter, the trait helpers (`t.id`, `t.email`, `t.datetime`, …)
  and the pagination shapes (`t.pageInput`, `t.page`).
- **`omniface/auth`** — the adapters behind the contract above, plus the plugin that runs them:
  `auth` (+ `AuthOptions`, `AuthState`), `jwtAdapter` (+ `verifyJwt`, `createJwkSet`,
  `principalFromClaims`, `scopesFromClaims`, `JWT_ALGORITHMS` and the JWT types),
  `betterAuthAdapter` (+ `BetterAuthApi`, the session and user shapes), `clerkAdapter`,
  `workosAdapter` (+ `workOsIssuer`, `workOsJwksUri`), and `apiKeyAdapter` (+ `hashApiKey`).
  The contract types are re-exported here too, so an adapter author needs one import.
- **`omniface/plugins`** — `logging`, `otel` (+ the structural `Otel*` types: tracing and RED metrics
  over the optional `@opentelemetry/api` peer), `apiKeys` (+ `apiKeyAdapter`, `memoryKeyStore`, `fileKeyStore`,
  `sqlKeyStore`, `apiKeyTableSql`, `ApiKeyStore`), `auth`, `scopes` (+ `hasScope`), `rateLimit`
  (+ `parseRate`), `idempotency` (+ `memoryIdempotencyStore`, `IdempotencyStore`), `agentTokens`
  (+ `agentTokenAdapter`, `memoryAgentTokenStore`, `AgentTokenStore`: short-lived, scope-narrowed
  credentials for the agent in a visitor's browser) and `audit`,
  each with its options and record types. The two store interfaces are the extension points; the
  key store now has durable implementations as well as the in-memory one.
- **`omniface/rest`** — `createRestApp` (+ `RestAppOptions`), for mounting the REST facet inside an
  existing Hono app. Pass `security: false` when the host app already sets those headers.
- **`omniface/mcp`** — `createMcpServer`, `createMcpHttpHandler`, `runMcpStdio`, `McpServerOptions`,
  `McpHttpOptions`, and the actor-attribution registry that makes a stateless HTTP audit record
  identical to a stdio one: `memoryClientRegistry`, `McpClientRegistry`, `McpClientInfo`,
  `ClientRegistryOptions`.

## `@omniface/client`

`createClient` (the inferred SDK), `createCaller` (the transport under it), `ClientOptions`,
`Caller`, `Client`, `ClientOf`, `InferClient`, `FacetClientError`, `ClientErrorCode`.

A paginated op's method carries `.iterate()` (an async iterable over every page) and
`.autoPaginate()` (all of them, collected); underneath they are `Caller.iterate` and
`Caller.collect`. The generated SDK package is this same runtime with its types written down
rather than inferred — see [SDKS.md](SDKS.md).

## `@omniface/cli`

`runCli`, `RunCliOptions`, `CliIO`, `EXIT_CODES`. A generated CLI package is `bin.mjs` plus a
manifest; everything it does lives here.

`protectedResourceMetadata`, `PROTECTED_RESOURCE_PATH`, `oauthChallenge`, `declaredScopes`,
`OAuthResourceConfig` — where a caller with no credential goes to get one (RFC 9728). Discovery
only: an app names somebody else's authorization server, and the scopes advertised are the ones its
ops already declare.

## `@omniface/testing`

`createHarness`, `Harness`, `HarnessOptions`, `CallOptions`, `Channel`, `CHANNELS`, `Outcome`,
`outcomesAgree` — drive one op on every facet and compare. `conformanceCases`, `runConformance`,
`ConformanceOptions`, `OpConformanceOptions`, `ConformanceCase`, `CaseResult`, `Check`, `CHECKS` —
the suite generated from the definition. `screenProblems` — what the `presentation` check reads out
of a rendered screen and diffs against the REST payload, exported so a facet of your own can use it. `conformanceCoverage`, `ConformanceCoverage`, `OpCoverage`
— which cases an app gets and which ones a hand-written input would add, since the two inputs the
definition cannot supply are also the only way the suite silently shrinks. `apiKeyStoreCases`, `runApiKeyStoreConformance`,
`ApiKeyStoreCaseOptions`, `StoreCase` — the same idea for an extension point rather than a facet:
the cases every `ApiKeyStore` implementation has to pass. `pluginCases`, `runPluginConformance`,
`PluginConformanceOptions`, `PluginCase` — the cases every plugin has to pass, and `createSampleApp`
(+ `SampleAppOptions`), the four-op app they run against, built with no schema library at all.

## Deliberately internal

Not exported, and free to change:

- `naming.ts` — the convention layer (`tasks.complete` → `POST /tasks/{id}/complete`,
  `tasks_complete`, `tasks complete <id>`). Conventions are a promise about *behaviour*; the
  functions that compute them are not a promise about *names*.
- `facets/http.ts` — the shared HTTP error rendering behind REST and MCP.
- `facets/openapi.ts`, `sdk.ts`, `schemas.ts` — the OpenAPI document, the generated SDK package
  and the named-type table they share. All three are reachable as *data* through `build`, which is
  what the promise is about: `.omniface/openapi.json` and `.omniface/sdk/` are outputs with a documented
  shape ([SDKS.md](SDKS.md)), and the functions that write them are not part of the surface.
- `inspector-html.ts` — the inspector page is a screen, not an API.
- Schema plumbing that has no meaning outside facet: `applyFieldTraits`, `getSchemaName`,
  `hasFieldTraits`, `isSchema`, `typeOf`, `coerceString`, `emptyInput`, `isOp`, `createOpFactory`.

## The one rule this review changed

Nothing was removed, and no runtime function changed. What the review found was the opposite
problem: types that are *reachable* from the public API — `OpBuilder` (what `f.op(...)` returns),
`ServerOptions`, `RestOverride` and the rest of the per-facet config types, `ValidationIssue`,
`Hook` — were not exported, so a consumer could call the API but not name what it returned or
accepted. Those are exported now. A type that appears in a public signature is part of the surface
whether or not anyone exported it; the only choice is whether callers can say its name.
