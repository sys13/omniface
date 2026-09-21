// The public surface of `facet`. Anything not re-exported from this file (or from `facet/zod`,
// `facet/plugins`, `facet/rest`, `facet/mcp`) is internal and may change in any release.
// The tiers below, and what each promises, are documented in docs/API.md.

// --- Core: defining and running an app -------------------------------------------------------
export {
  facet,
  type App,
  type AppConfig,
  type CliConfig,
  type CliOverride,
  type Facet,
  type FacetsConfig,
  type InvokeInit,
  type McpConfig,
  type McpOverride,
  type McpToolGroup,
  type NormalizedFacets,
  type OpIds,
  type RestConfig,
  type RestOverride,
  type SdkConfig,
  type WebConfig,
  type WebOverride,
} from './app.ts'
export {
  anonymous,
  captureDefinitionSites,
  definitionSite,
  op,
  type FacetName,
  type HandlerArgs,
  type Op,
  type OpBuilder,
  type OpConfig,
  type OpFactory,
  type OpsTree,
  type Principal,
} from './op.ts'
export { ERROR_CODES, FacetError, errors, toFacetError, type ErrorCode, type FacetErrorOptions } from './errors.ts'
export { paginate } from './pagination.ts'
export { createServer, serve, type ServerOptions } from './server.ts'

// --- Core: tooling behind the `facet` CLI ----------------------------------------------------
export { build, type BuildOptions, type BuildResult } from './build.ts'
export {
  diffManifests,
  formatDiff,
  verdict,
  type ChangeLevel,
  type FacetKey,
  type FormatDiffOptions,
  type ManifestChange,
  type ManifestDiff,
} from './diff.ts'
export { inspectAll, inspectOp, type OpInspection } from './inspect.ts'
export { renderIndex, renderScreen, escapeHtml, webTools, type ScreenContext, type WebTool } from './facets/web.ts'
export { agentMayCall, type AgentAllow, type WebAgentConfig } from './agent.ts'
export { createWebApp, WEB_CSP, type WebAppOptions } from './facets/web-server.ts'
export {
  challenge as oauthChallenge,
  declaredScopes,
  protectedResourceMetadata,
  PROTECTED_RESOURCE_PATH,
  type OAuthResourceConfig,
} from './facets/oauth.ts'
export {
  MASK,
  humanLabel,
  presentFields,
  presentValue,
  tableColumns,
  type FieldDisplay,
  type FieldPresentation,
} from './presentation.ts'
export { lint, MCP_TOOL_BUDGET, OVERRIDE_BUDGET, type LintFinding, type LintOptions } from './lint.ts'
export {
  FixError,
  applyFixPlans,
  applyNamedTypeFixes,
  planNamedTypeFixes,
  type FixIO,
  type FixPlan,
  type FixResult,
  type Unfixable,
} from './fix.ts'
export {
  MANIFEST_VERSION,
  buildManifest,
  isUntrusted,
  type Manifest,
  type ManifestAdapters,
  type ManifestOp,
  type ManifestTool,
} from './manifest.ts'

// --- Extension: authoring a facet -------------------------------------------------------------
// A facet is a module: a projection, a diff contract, a presentation, and a serve hook only if it
// is served. See docs/FACETS.md. The five omniface ships are written against exactly this.
export {
  defineFacet,
  enabledFacets,
  facetModule,
  facetModules,
  projectionOf,
  registerFacet,
  settingsOf,
  type ContractContext,
  type FacetChange,
  type FacetModule,
  type FacetPresentation,
  type FacetServer,
  type PresentationContext,
  type ProjectionContext,
} from './facet.ts'
import './facets/builtin.ts'
export { cliOf, cliSettings, type CliProjection, type CliSettings } from './facets/cli.facet.ts'
export { mcpOf, mcpSettings, mcpTools, type McpProjection, type McpSettings } from './facets/mcp.facet.ts'
export { restOf, type RestProjection } from './facets/rest.facet.ts'
export { sdkOf, sdkSettings, type SdkProjection, type SdkSettings } from './facets/sdk.facet.ts'
export { webOf, webSettings, type ManifestScreen, type WebSettings } from './facets/web.facet.ts'

// --- Extension: authenticating a caller -------------------------------------------------------
// The contract lives here; the adapters that implement it are `facet/auth`.
export { defineAuthAdapter, type AuthAdapter, type AuthContext, type AuthSession } from './auth/adapter.ts'
export {
  securityMiddleware,
  DEFAULT_ALLOW_HEADERS,
  DEFAULT_EXPOSE_HEADERS,
  DEFAULT_METHODS,
  type CorsConfig,
  type CsrfConfig,
  type OriginMatcher,
  type SecurityConfig,
  type SecurityHeadersConfig,
} from './facets/security.ts'

// --- Extension: writing a plugin -------------------------------------------------------------
// The per-facet `adapters` slot: what a plugin may add to REST, MCP, the CLI and the SDK, and
// (in its doc comment) what it may not. See docs/PLUGINS.md.
export {
  RESERVED_CLI_COMMANDS,
  RESERVED_CLI_FLAGS,
  RESERVED_SDK_OPTIONS,
  adapterProblems,
  restNamespace,
  type CliCommandSpec,
  type CliFacetAdapter,
  type CliFlagSpec,
  type FacetAdapters,
  type McpCallContext,
  type McpFacetAdapter,
  type PluginAdapters,
  type RestFacetAdapter,
  type RestPluginRoute,
  type RestResultContext,
  type RestRouteContext,
  type SdkFacetAdapter,
  type SdkOptionSpec,
  type SecurityScheme,
} from './adapters.ts'
export {
  STAGES,
  definePlugin,
  type Credential,
  type Hook,
  type HookStage,
  type Invocation,
  type Plugin,
  type RegisteredOp,
  type Stage,
} from './plugin.ts'

// --- Extension: schemas, traits and the adapters that read them ------------------------------
export {
  exampleValue,
  hasTrait,
  objectProperties,
  publicSchema,
  redact,
  registerSchemaAdapter,
  requiredProperties,
  stripInternal,
  toJSONSchema,
  type IO,
  type JSONSchema,
  type SchemaAdapter,
} from './jsonschema.ts'
export { getFieldTraits, setFieldTraits, setSchemaName, type FieldTraits, type OpTraits } from './traits.ts'
export { validate, type AnySchema, type InferIn, type InferOut, type StandardSchemaV1, type ValidationIssue } from './standard.ts'
