import type { App } from './app.ts'
import { exampleValue, type JSONSchema } from './jsonschema.ts'
import { buildManifest, type Manifest, type ManifestOp, type ManifestScreen, type ManifestTool } from './manifest.ts'
import { kebab } from './naming.ts'
import { STAGES } from './plugin.ts'
import type { OpTraits } from './traits.ts'

export type OpInspection = {
  id: string
  description?: string
  source: string
  traits: OpTraits
  errors: string[]
  input: JSONSchema
  output: JSONSchema
  exampleInput: Record<string, unknown>
  rest: { method: string; path: string; status: number; curl: string } | null
  sdk: { snippet: string } | null
  cli: { command: string; snippet: string } | null
  mcp: { tool: ManifestTool; group?: string } | null
  web: { screen: ManifestScreen; url: string } | null
  pipeline: { wraps: string[]; stages: { stage: string; plugins: string[] }[] }
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

function cliSnippet(bin: string, op: ManifestOp, example: Record<string, unknown>): string {
  const cli = op.cli!
  const parts = [bin, ...cli.command]
  for (const arg of cli.args) if (arg in example) parts.push(shellQuote(String(example[arg])))
  for (const [key, value] of Object.entries(example)) {
    if (cli.args.includes(key) || value === null || value === undefined) continue
    if (value === true) parts.push(`--${kebab(key)}`)
    else if (typeof value === 'object') parts.push(`--${kebab(key)}`, shellQuote(JSON.stringify(value)))
    else parts.push(`--${kebab(key)}`, shellQuote(String(value)))
  }
  if (op.traits.destructive) parts.push('--yes')
  return parts.join(' ')
}

function curlSnippet(manifest: Manifest, op: ManifestOp, example: Record<string, unknown>): string {
  const rest = op.rest!
  let path = rest.path
  const rest_ = { ...example }
  for (const p of rest.pathParams) {
    path = path.replace(`{${p}}`, encodeURIComponent(String(example[p] ?? p)))
    delete rest_[p]
  }
  const env = `$${manifest.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  const lines = [`curl -X ${rest.method}`]
  if (rest.method === 'GET' || rest.method === 'DELETE') {
    const qs = new URLSearchParams(
      Object.entries(rest_).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]),
    ).toString()
    lines[0] += ` "http://localhost:3000${path}${qs ? `?${qs}` : ''}"`
  } else {
    lines[0] += ` http://localhost:3000${path}`
    lines.push(`-H 'Content-Type: application/json'`)
    if (Object.keys(rest_).length) lines.push(`-d ${shellQuote(JSON.stringify(rest_))}`)
  }
  lines.splice(1, 0, `-H "Authorization: Bearer ${env}"`)
  return lines.join(' \\\n  ')
}

/** The screen's URL with its route params filled in, so it is something you can actually open. */
function screenUrl(manifest: Manifest, screen: ManifestScreen, example: Record<string, unknown>): string {
  let path = screen.path
  for (const p of screen.pathParams) path = path.replace(`{${p}}`, encodeURIComponent(String(example[p] ?? p)))
  const mount = manifest.web?.path ?? ''
  return `http://localhost:3000${`${mount}${path === '/' ? '' : path}` || '/'}`
}

export function inspectOp(app: App, id: string, manifest: Manifest = buildManifest(app)): OpInspection {
  const op = manifest.ops.find((o) => o.id === id)
  if (!op) throw new Error(`omniface inspect: unknown op "${id}". Known: ${manifest.ops.map((o) => o.id).join(', ')}`)
  const example = (exampleValue(op.input) ?? {}) as Record<string, unknown>
  const bin = manifest.cli?.binName ?? manifest.name
  let mcp: OpInspection['mcp'] = null
  if (op.mcp) {
    const group = 'group' in op.mcp ? op.mcp.group : undefined
    const tool = manifest.mcpTools.find((t) => (group ? t.name === group : t.ops.length === 1 && t.ops[0] === id))
    if (tool) mcp = { tool, ...(group ? { group } : {}) }
  }
  const hasInput = Object.keys(example).length > 0
  return {
    id,
    ...(op.description ? { description: op.description } : {}),
    source: op.source,
    traits: op.traits,
    errors: op.errors,
    input: op.input,
    output: op.output,
    exampleInput: example,
    rest: op.rest ? { ...op.rest, curl: curlSnippet(manifest, op, example) } : null,
    sdk: op.sdk
      ? {
          snippet: op.traits.paginated
            ? `for await (const item of client.${op.sdk.method.join('.')}.iterate(${hasInput ? JSON.stringify(example) : ''})) {\n  console.log(item)\n}`
            : `const result = await client.${op.sdk.method.join('.')}(${hasInput ? JSON.stringify(example, null, 2) : ''})`,
        }
      : null,
    cli: op.cli ? { command: [bin, ...op.cli.command].join(' '), snippet: cliSnippet(bin, op, example) } : null,
    mcp,
    web: op.web ? { screen: op.web, url: screenUrl(manifest, op.web, example) } : null,
    pipeline: {
      wraps: app.plugins.filter((p) => p.wrap).map((p) => p.name),
      stages: STAGES.map((stage) => ({
        stage,
        plugins:
          stage === 'handle'
            ? [op.source === 'app' ? 'handler' : `handler (${op.source})`]
            : stage === 'validate'
              ? ['schema', ...app.plugins.filter((p) => p.hooks?.validate).map((p) => p.name)]
              : app.plugins.filter((p) => p.hooks?.[stage]).map((p) => p.name),
      })),
    },
  }
}

export function inspectAll(app: App, manifest: Manifest = buildManifest(app)) {
  return {
    name: manifest.name,
    version: manifest.version,
    facets: manifest.facets,
    plugins: app.plugins.map((p) => p.name),
    mcpToolCount: manifest.mcpTools.length,
    ops: manifest.ops.map((o) => inspectOp(app, o.id, manifest)),
  }
}
