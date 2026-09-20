import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { credentialFromAdapters, type McpCallContext } from '../adapters.ts'
import type { App } from '../app.ts'
import { errors, toFacetError, type FacetError } from '../errors.ts'
import { objectProperties } from '../jsonschema.ts'
import { buildManifest, type Manifest } from '../manifest.ts'
import type { Credential } from '../plugin.ts'
import { clientFromHeaders, credentialFromHeaders } from './http.ts'

export type McpServerOptions = {
  /** The credential every call runs as (stdio), or a function for per-connection credentials. */
  credential?: Credential | (() => Credential | undefined)
  /** The raw request headers, on the HTTP transport. Auth adapters read cookie sessions from them. */
  headers?: Headers
  manifest?: Manifest
  /** Which transport this server is answering on. Used for attribution, never for authority. */
  transport?: 'stdio' | 'http'
  /**
   * Who is calling, when the transport cannot say. Streamable HTTP is stateless: `initialize` and
   * `tools/call` are separate requests, so the server handling the call never saw the client's
   * name. Supplying it here is what makes an HTTP audit record identical to a stdio one.
   */
  client?: { name?: string; version?: string }
}

/** Error text written for a model to act on. */
function errorResult(err: FacetError, toolName: string): CallToolResult {
  const lines = [`Error (${err.code}): ${err.message}`]
  for (const issue of err.issues ?? []) lines.push(`- ${issue.path || '(input)'}: ${issue.message}`)
  if (err.code === 'rate_limited' && err.retryAfter !== undefined) {
    lines.push(`Rate limited. Wait ${Math.ceil(err.retryAfter)}s before calling ${toolName} again.`)
  }
  if (err.code === 'unauthenticated') lines.push('The MCP server is not configured with a valid API key.')
  if (err.code === 'forbidden') lines.push('The configured API key lacks the scope this tool needs; do not retry.')
  return {
    isError: true,
    content: [{ type: 'text', text: lines.join('\n') }],
    _meta: { 'omniface/error': err.toJSON() },
  }
}

export function createMcpServer(app: App, options: McpServerOptions = {}): Server {
  const manifest = options.manifest ?? buildManifest(app)
  const adapters = app.adapters ?? []
  const transport = options.transport ?? 'stdio'
  const extra = adapters.flatMap((a) => (a.mcp?.instructions ? [a.mcp.instructions] : []))
  const instructions = [manifest.description, ...extra].filter(Boolean).join('\n\n') || undefined
  const server = new Server(
    { name: manifest.name, version: manifest.version },
    { capabilities: { tools: {} }, instructions },
  )
  const opsById = new Map(manifest.ops.map((o) => [o.id, o]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: manifest.mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as { type: 'object' } } : {}),
      annotations: tool.annotations,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = manifest.mcpTools.find((t) => t.name === request.params.name)
    if (!tool) return errorResult(errors.notFound(`Unknown tool "${request.params.name}"`), request.params.name)
    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    let opId: string
    let input: Record<string, unknown>
    if (tool.ops.length === 1) {
      opId = tool.ops[0]!
      input = { ...args }
    } else {
      const action = args.action
      const match = tool.ops.find((id) => id.split('.').pop() === action)
      if (!match) {
        return errorResult(
          errors.invalidInput(`Unknown action "${String(action)}". Use one of: ${tool.ops.map((id) => id.split('.').pop()).join(', ')}`),
          tool.name,
        )
      }
      opId = match
      input = { ...((args.input as Record<string, unknown>) ?? {}) }
    }

    const op = opsById.get(opId)!
    const binding = op.mcp && 'tool' in op.mcp ? op.mcp : undefined
    if (op.traits.paginated && binding?.maxItems && input.limit === undefined && 'limit' in objectProperties(op.input)) {
      input.limit = binding.maxItems
    }

    const callCtx: McpCallContext = {
      ...(options.headers ? { headers: options.headers } : {}),
      ...(server.getClientVersion() ? { clientInfo: server.getClientVersion() } : {}),
      transport,
    }
    const credential =
      (typeof options.credential === 'function' ? options.credential() : options.credential) ??
      credentialFromAdapters(adapters, 'mcp', callCtx)
    try {
      // What the transport knows, then what the caller was remembered as, then whatever a plugin
      // can work out. Attribution only: naming yourself grants nothing.
      const clientInfo =
        server.getClientVersion() ??
        options.client ??
        adapters.reduce<{ name?: string; version?: string } | undefined>(
          (found, a) => found ?? a.mcp?.client?.(callCtx),
          undefined,
        )
      // How MCP expresses the `idempotent` trait: REST has a header, a tool call has _meta.
      const meta = request.params._meta as Record<string, unknown> | undefined
      const idempotencyKey = meta?.['omniface/idempotency-key']
      const output = await app.invoke(opId, input, {
        facet: 'mcp',
        credential,
        ...(options.headers ? { headers: options.headers } : {}),
        ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
        client: clientInfo ? { name: clientInfo.name, version: clientInfo.version } : undefined,
      })
      let text = JSON.stringify(output, null, 2)
      const next = (output as { nextCursor?: string | null } | null)?.nextCursor
      if (op.traits.paginated && next) {
        text += `\n\nMore results available: call ${tool.name} again with cursor="${next}".`
      }
      const structured = tool.outputSchema && output && typeof output === 'object' && !Array.isArray(output)
      return {
        content: [{ type: 'text', text }],
        ...(structured ? { structuredContent: output as Record<string, unknown> } : {}),
      }
    } catch (raw) {
      return errorResult(toFacetError(raw), tool.name)
    }
  })

  return server
}

/** Run the MCP facet over stdio. Credential from `<APP>_API_KEY` or `FACET_API_KEY`. */
export async function runMcpStdio(app: App, env: Record<string, string | undefined> = process.env): Promise<void> {
  const envName = `${app.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  const token = env[envName] ?? env.FACET_API_KEY
  const server = createMcpServer(app, {
    credential: token ? { type: 'bearer', token } : undefined,
    transport: 'stdio',
  })
  await server.connect(new StdioServerTransport())
}

// ---------------------------------------------------------------------------------------------
// Actor attribution over Streamable HTTP
//
// On stdio the MCP client announces itself once and the connection remembers it, so every log line
// and audit record names the agent. Streamable HTTP in stateless mode has no connection to
// remember it with: `initialize` and `tools/call` are separate requests, each handled by a fresh
// server, so the same client shows up as `mcp:unknown-client`. Same principal, same tool, two
// different audit trails depending on transport — the drift this project exists to stop.
//
// The fix is to remember the announcement ourselves, keyed by what the two requests have in
// common: the credential they present and the HTTP client they present it with. This is
// attribution metadata and nothing else — an entry can only ever *name* a caller, never widen what
// that caller may do, so a forged key buys an attacker a misleading log line and no access at all.

export type McpClientInfo = { name?: string; version?: string }

export type ClientRegistryOptions = {
  /** How long an announcement stays usable. Default 1 hour. */
  ttlMs?: number
  /** Most entries kept; the oldest go first. Default 1000. */
  max?: number
}

export type McpClientRegistry = {
  remember(key: string, client: McpClientInfo): void
  lookup(key: string): McpClientInfo | undefined
}

/** The default registry: in memory, bounded, per process. */
export function memoryClientRegistry(options: ClientRegistryOptions = {}): McpClientRegistry {
  const ttl = options.ttlMs ?? 60 * 60 * 1000
  const max = options.max ?? 1000
  const entries = new Map<string, { client: McpClientInfo; at: number }>()
  return {
    remember(key, client) {
      entries.delete(key)
      entries.set(key, { client, at: Date.now() })
      for (const [oldest] of entries) {
        if (entries.size <= max) break
        entries.delete(oldest)
      }
    },
    lookup(key) {
      const found = entries.get(key)
      if (!found) return undefined
      if (Date.now() - found.at > ttl) {
        entries.delete(key)
        return undefined
      }
      // Refresh: a long-lived agent session should not lose its name mid-conversation.
      found.at = Date.now()
      return found.client
    },
  }
}

/**
 * What ties one stateless request to the next: the credential (so two callers never share an
 * entry), the session id if the deployment issues one, and the HTTP client's own user agent.
 */
function attributionKey(headers: Headers, credential: Credential | undefined): string {
  return [
    credential?.token ?? 'anonymous',
    headers.get('mcp-session-id') ?? '',
    headers.get('user-agent') ?? '',
  ].join('\u0000')
}

/** The `clientInfo` an `initialize` request announces, if this body is one. */
function announcedClient(body: unknown): McpClientInfo | undefined {
  const messages = Array.isArray(body) ? body : [body]
  for (const message of messages) {
    const m = message as { method?: string; params?: { clientInfo?: McpClientInfo } } | null
    if (m?.method === 'initialize' && m.params?.clientInfo?.name) return m.params.clientInfo
  }
  return undefined
}

export type McpHttpOptions = {
  manifest?: Manifest
  /** Where announcements are remembered. Swap it for a shared store behind several instances. */
  registry?: McpClientRegistry
}

/** A fetch-style handler for MCP over Streamable HTTP (stateless). Credential from request headers. */
export function createMcpHttpHandler(app: App, manifest: Manifest = buildManifest(app), options: McpHttpOptions = {}) {
  const registry = options.registry ?? memoryClientRegistry()
  return async (request: Request): Promise<Response> => {
    const credential = credentialFromHeaders(request.headers)
    const key = attributionKey(request.headers, credential)
    if (request.method === 'POST') {
      // The transport consumes the body, so the peek happens on a clone.
      let body: unknown
      try {
        body = await request.clone().json()
      } catch {
        body = undefined
      }
      const announced = announcedClient(body)
      if (announced) registry.remember(key, announced)
    }
    const server = createMcpServer(app, {
      credential,
      headers: request.headers,
      manifest: options.manifest ?? manifest,
      transport: 'http',
      // Identical to what stdio would record, for a client that introduced itself.
      client: registry.lookup(key) ?? clientFromHeaders(request.headers),
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(request)
  }
}
