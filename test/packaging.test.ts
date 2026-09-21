import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// What every published package promises: a build that consumers can resolve, and a public API
// surface that only changes when someone means it to (docs/API.md).

const ROOT = join(import.meta.dirname, '..')
const PACKAGES = ['omniface', 'client', 'cli', 'testing'] as const

// Every test in this file reads `dist`, which is the only thing in the suite that comes from a
// build rather than from the source tree. `pnpm test` builds first; `pnpm test:only` and a bare
// `vitest run` do not, which is the mode you reach for while iterating. Without the check below
// an unbuilt tree fails with ENOENT and a stale one fails with a diff of exported names — both
// read like an API regression, and neither says the build is what is missing.
const BUILD_HINT = 'Run `pnpm build` and try again.'

beforeAll(() => {
  const unbuilt = PACKAGES.filter((dir) => !existsSync(join(ROOT, 'packages', dir, 'dist')))
  if (unbuilt.length) throw new Error(`Not built: ${unbuilt.map((d) => `packages/${d}/dist`).join(', ')}. ${BUILD_HINT}`)
})

type PackageJson = {
  name: string
  version: string
  main?: string
  types?: string
  bin?: Record<string, string>
  files?: string[]
  license?: string
  repository?: unknown
  exports: Record<string, string>
  publishConfig?: { access?: string; provenance?: boolean }
}

const read = (dir: string): PackageJson => JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')) as PackageJson

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

/** Every name a `.d.ts` exports, whether re-exported or declared in place. */
function declaredExports(dts: string): string[] {
  const names = new Set<string>()
  for (const [, list] of dts.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of (list ?? '').split(',')) {
      const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()
      if (name) names.add(name)
    }
  }
  for (const [, name] of dts.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:type|interface|class|function|const)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(name!)
  }
  return [...names].sort()
}

describe.each(PACKAGES)('packages/%s', (dir) => {
  const pkg = read(dir)
  const base = join(ROOT, 'packages', dir)

  it('ships every entry point its exports map promises', async () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (subpath === './package.json') continue
      expect(statSync(join(base, target)).isFile(), `${pkg.name}${subpath.slice(1)} -> ${target}`).toBe(true)
      expect(statSync(join(base, target.replace(/\.js$/, '.d.ts'))).isFile(), `types for ${target}`).toBe(true)
      await expect(import(join(base, target))).resolves.toBeTruthy()
    }
    expect(statSync(join(base, pkg.main!)).isFile()).toBe(true)
    expect(statSync(join(base, pkg.types!)).isFile()).toBe(true)
  })

  it('emits declarations a consumer can compile against (no .ts specifiers)', () => {
    const offenders = walk(join(base, 'dist'))
      .filter((f) => f.endsWith('.d.ts'))
      .filter((f) => /(?:from|import)\s*\(?\s*['"]\.\.?\/[^'"]+\.ts['"]/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('is publishable: files, license, repository, provenance', () => {
    // `src` ships so the declaration and source maps in `dist` resolve in a consumer's editor.
    // `facet` ships `bin` too: its bin is a committed launcher rather than a build output.
    expect(pkg.files).toEqual(pkg.name === 'omniface' ? ['bin', 'dist', 'src', '!dist/**/*.tsbuildinfo'] : ['dist', 'src', '!dist/**/*.tsbuildinfo'])
    expect(statSync(join(base, 'README.md')).isFile()).toBe(true)
    expect(statSync(join(base, 'LICENSE')).isFile()).toBe(true)
    expect(pkg.license).toBe('MIT')
    expect(pkg.repository).toBeTruthy()
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true })
  })
})

describe('the omniface bin', () => {
  const declared = read('omniface').bin!.omniface!
  const bin = join(ROOT, 'packages/omniface', declared)

  it('is an executable ESM entry with a shebang', () => {
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
    expect(declared).toBe('./bin/omniface.mjs')
  })

  // pnpm creates a bin shim only if the target exists at install time, and never revisits
  // the decision. A bin under dist/ therefore goes missing on every clean checkout — install
  // runs before build — which is where CI drives the example app through the installed bin.
  it('exists before anything is built, and is shipped', () => {
    expect(declared.startsWith('./dist/')).toBe(false)
    expect(existsSync(bin)).toBe(true)
    expect(read('omniface').files).toContain('bin')
  })

  it('reports the package version', () => {
    expect(execFileSync('node', [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(read('omniface').version)
  })
})

describe('public API surface', () => {
  // Adding a name here is a deliberate act: it is what the next version has to keep working.
  const SURFACE: Record<string, string[]> = {
    'packages/omniface/dist/index.d.ts': [
      'AgentAllow', 'AnySchema', 'App', 'AppConfig', 'AuthAdapter', 'AuthContext', 'AuthSession', 'BuildOptions',
      'BuildResult', 'ChangeLevel', 'CliCommandSpec', 'CliConfig', 'CliFacetAdapter', 'CliFlagSpec', 'CliOverride',
      'CliProjection', 'CliSettings', 'ContractContext', 'CorsConfig', 'Credential', 'CsrfConfig', 'DEFAULT_ALLOW_HEADERS',
      'DEFAULT_EXPOSE_HEADERS', 'DEFAULT_METHODS', 'ERROR_CODES', 'ErrorCode', 'Facet', 'FacetAdapters', 'FacetChange',
      'FacetError', 'FacetErrorOptions', 'FacetKey', 'FacetModule', 'FacetName', 'FacetPresentation', 'FacetServer',
      'FacetsConfig', 'FieldDisplay', 'FieldPresentation', 'FieldTraits', 'FixError', 'FixIO', 'FixPlan', 'FixResult',
      'FormatDiffOptions', 'HandlerArgs', 'Hook', 'HookStage', 'IO', 'InferIn', 'InferOut', 'Invocation', 'InvokeInit',
      'JSONSchema', 'LintFinding', 'LintOptions', 'MANIFEST_VERSION', 'MASK', 'MCP_TOOL_BUDGET', 'Manifest',
      'ManifestAdapters', 'ManifestChange', 'ManifestDiff', 'ManifestOp', 'ManifestScreen', 'ManifestTool',
      'McpCallContext', 'McpConfig', 'McpFacetAdapter', 'McpOverride', 'McpProjection', 'McpSettings', 'McpToolGroup',
      'NormalizedFacets', 'OAuthResourceConfig', 'OVERRIDE_BUDGET', 'Op', 'OpBuilder', 'OpConfig', 'OpFactory', 'OpIds',
      'OpInspection', 'OpTraits', 'OpsTree', 'OriginMatcher', 'PROTECTED_RESOURCE_PATH', 'Plugin', 'PluginAdapters',
      'PresentationContext', 'Principal', 'ProjectionContext', 'RESERVED_CLI_COMMANDS', 'RESERVED_CLI_FLAGS',
      'RESERVED_SDK_OPTIONS', 'RegisteredOp', 'RestConfig', 'RestFacetAdapter', 'RestOverride', 'RestPluginRoute',
      'RestProjection', 'RestResultContext', 'RestRouteContext', 'STAGES', 'SchemaAdapter', 'ScreenContext', 'SdkConfig',
      'SdkFacetAdapter', 'SdkOptionSpec', 'SdkProjection', 'SdkSettings', 'SecurityConfig', 'SecurityHeadersConfig',
      'SecurityScheme', 'ServerOptions', 'Stage', 'StandardSchemaV1', 'Unfixable', 'ValidationIssue', 'WEB_CSP',
      'WebAgentConfig', 'WebAppOptions', 'WebConfig', 'WebOverride', 'WebSettings', 'WebTool', 'adapterProblems',
      'agentMayCall', 'anonymous', 'applyFixPlans', 'applyNamedTypeFixes', 'build', 'buildManifest',
      'captureDefinitionSites', 'cliOf', 'cliSettings', 'createServer', 'createWebApp', 'declaredScopes',
      'defineAuthAdapter', 'defineFacet', 'definePlugin', 'definitionSite', 'diffManifests', 'enabledFacets', 'errors',
      'escapeHtml', 'exampleValue', 'facet', 'facetModule', 'facetModules', 'formatDiff', 'getFieldTraits', 'hasTrait',
      'humanLabel', 'inspectAll', 'inspectOp', 'isUntrusted', 'lint', 'mcpOf', 'mcpSettings', 'mcpTools', 'oauthChallenge',
      'objectProperties', 'op', 'paginate', 'planNamedTypeFixes', 'presentFields', 'presentValue', 'projectionOf',
      'protectedResourceMetadata', 'publicSchema', 'redact', 'registerFacet', 'registerSchemaAdapter', 'renderIndex',
      'renderScreen', 'requiredProperties', 'restNamespace', 'restOf', 'sdkOf', 'sdkSettings', 'securityMiddleware',
      'serve', 'setFieldTraits', 'setSchemaName', 'settingsOf', 'stripInternal', 'tableColumns', 'toFacetError',
      'toJSONSchema', 'validate', 'verdict', 'webOf', 'webSettings', 'webTools',
    ],
    'packages/omniface/dist/zod/index.d.ts': ['t'],
    'packages/omniface/dist/plugins/index.d.ts': [
      'AgentTokenAdapterOptions', 'AgentTokenRecord', 'AgentTokenStore', 'AgentTokensOptions',
      'ApiKeyAdapterOptions', 'ApiKeyRecord', 'ApiKeyStore', 'ApiKeysOptions', 'AuditEntry', 'AuditOptions',
      'AuthOptions', 'AuthState', 'DEFAULT_API_KEY_TABLE', 'FileKeyStoreOptions', 'IdempotencyOptions',
      'IdempotencyRecord', 'IdempotencyStore', 'LogLine', 'LoggingOptions', 'MemoryIdempotencyStoreOptions', 'OtelApi',
      'OtelAttributes', 'OtelCounter', 'OtelHistogram', 'OtelMeter', 'OtelOptions', 'OtelSpan', 'OtelTracer',
      'RateLimitOptions', 'RateSpec', 'ScopesOptions', 'SeedKey', 'SqlKeyStoreOptions', 'SqlQuery', 'apiKeyAdapter',
      'apiKeyTableSql', 'apiKeys', 'audit', 'auth', 'fileKeyStore', 'hasScope', 'hashApiKey', 'idempotency', 'logging',
      'agentTokenAdapter', 'agentTokens', 'memoryAgentTokenStore',
      'memoryIdempotencyStore', 'memoryKeyStore', 'otel', 'parseRate', 'rateLimit', 'scopes', 'sqlKeyStore',
    ],
    'packages/omniface/dist/auth/index.d.ts': [
      'ApiKeyAdapterOptions', 'AuthAdapter', 'AuthContext', 'AuthOptions', 'AuthSession', 'AuthState',
      'BetterAuthAdapterOptions', 'BetterAuthApi', 'BetterAuthResult', 'BetterAuthSession', 'BetterAuthUser',
      'ClerkAdapterOptions', 'ClerkClaims', 'JWT_ALGORITHMS', 'Jwk', 'JwkSet', 'JwtAdapterOptions', 'JwtAlgorithm',
      'JwtClaims', 'JwtVerifyOptions', 'WorkOsAdapterOptions', 'WorkOsClaims', 'apiKeyAdapter', 'auth',
      'betterAuthAdapter', 'clerkAdapter', 'createJwkSet', 'defineAuthAdapter', 'hashApiKey', 'jwtAdapter',
      'principalFromClaims', 'scopesFromClaims', 'verifyJwt', 'workOsIssuer', 'workOsJwksUri', 'workosAdapter',
    ],
    'packages/omniface/dist/facets/rest.d.ts': ['RestAppOptions', 'createRestApp'],
    'packages/omniface/dist/facets/mcp.d.ts': [
      'ClientRegistryOptions', 'McpClientInfo', 'McpClientRegistry', 'McpHttpOptions', 'McpServerOptions',
      'createMcpHttpHandler', 'createMcpServer', 'memoryClientRegistry', 'runMcpStdio',
    ],
    'packages/client/dist/index.d.ts': [
      'Caller', 'Client', 'ClientErrorCode', 'ClientOf', 'ClientOptions', 'FacetClientError', 'InferClient',
      'createCaller', 'createClient',
    ],
    'packages/cli/dist/index.d.ts': ['CliIO', 'EXIT_CODES', 'RunCliOptions', 'runCli'],
    'packages/testing/dist/index.d.ts': [
      'ApiKeyStoreCaseOptions', 'BASE_URL', 'CHANNELS', 'CHECKS', 'CallOptions', 'CaseResult', 'Channel', 'Check',
      'ConformanceCase', 'ConformanceCoverage', 'ConformanceOptions', 'Harness', 'HarnessOptions', 'OpConformanceOptions',
      'OpCoverage', 'Outcome', 'PluginCase', 'PluginConformanceOptions', 'SampleAppOptions', 'StoreCase',
      'apiKeyStoreCases', 'conformanceCases', 'conformanceCoverage', 'createHarness', 'createSampleApp',
      'outcomesAgree', 'pluginCases', 'runApiKeyStoreConformance', 'runConformance', 'runPluginConformance',
      'screenProblems',
    ],
  }

  it.each(Object.keys(SURFACE))('%s exports exactly the documented names', (file) => {
    const dts = join(ROOT, file)
    if (!existsSync(dts)) throw new Error(`${file} does not exist. ${BUILD_HINT}`)
    // A stale `dist` produces the same diff as a real regression, so the message says so: the
    // names below are the source tree's, the names on disk are whatever was last built.
    expect(declaredExports(readFileSync(dts, 'utf8')), `if this reads like an API regression, it may be a stale build. ${BUILD_HINT}`).toEqual(
      [...SURFACE[file]!].sort(),
    )
  })
})
