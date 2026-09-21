import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createCaller, FacetClientError, type ClientErrorCode } from '@omniface/client'
import { cliOf, cliSettings, restOf, presentFields, presentValue, tableColumns, type FieldPresentation } from 'omniface'
import type { CliCommandSpec, CliFlagSpec, JSONSchema, Manifest, ManifestOp } from 'omniface'

// ---------------------------------------------------------------------------------------------
// Options and IO

export type CliIO = {
  stdout: { write(s: string): void; isTTY?: boolean }
  stderr: { write(s: string): void }
  stdinIsTTY: boolean
  prompt?: (question: string) => Promise<string>
}

export type RunCliOptions = {
  manifest: Manifest
  argv: string[]
  binName?: string
  env?: Record<string, string | undefined>
  io?: Partial<CliIO>
  fetch?: typeof fetch
  /** Where `login` stores credentials. Default ~/.config/<bin>. */
  configDir?: string
  defaultBaseUrl?: string
  retries?: number
}

export const EXIT_CODES: Record<ClientErrorCode | 'usage', number> = {
  internal: 1,
  invalid_input: 2,
  usage: 2,
  unauthenticated: 3,
  forbidden: 4,
  not_found: 5,
  conflict: 6,
  rate_limited: 7,
  network: 8,
}

class UsageError extends Error {}

const GLOBAL_BOOLEANS = new Set(['help', 'yes', 'all', 'version'])
const GLOBAL_VALUES = new Set(['base-url', 'api-key', 'output', 'json', 'idempotency-key'])
const SHORT: Record<string, string> = { h: 'help', y: 'yes', o: 'output' }

// ---------------------------------------------------------------------------------------------
// Small helpers (kept local: the engine must not depend on the server package at runtime)

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase()
const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const envPrefix = (bin: string) => bin.toUpperCase().replace(/[^A-Z0-9]+/g, '_')

function typeOf(schema: JSONSchema | undefined): string | undefined {
  if (!schema) return undefined
  if (typeof schema.type === 'string') return schema.type
  if (Array.isArray(schema.type)) return schema.type.find((t: string) => t !== 'null')
  for (const b of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const t = typeOf(b)
    if (t && t !== 'null') return t
  }
  if (schema.enum) return typeof schema.enum[0]
  return undefined
}

function hasTrait(schema: JSONSchema | undefined, trait: string): boolean {
  if (!schema) return false
  if (schema[`x-omniface-${trait}`]) return true
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some((b: JSONSchema) => hasTrait(b, trait))
}

function props(schema: JSONSchema): Record<string, JSONSchema> {
  return (schema.properties ?? {}) as Record<string, JSONSchema>
}

function coerce(raw: string, schema: JSONSchema | undefined, flag: string): unknown {
  switch (typeOf(schema)) {
    case 'integer':
    case 'number': {
      const n = Number(raw)
      if (raw.trim() === '' || Number.isNaN(n)) throw new UsageError(`--${flag} expects a number, got "${raw}"`)
      return n
    }
    case 'boolean':
      if (['true', '1', 'yes'].includes(raw)) return true
      if (['false', '0', 'no'].includes(raw)) return false
      throw new UsageError(`--${flag} expects true or false, got "${raw}"`)
    case 'object':
    case 'array':
      try {
        return JSON.parse(raw)
      } catch {
        if (typeOf(schema) === 'array') return raw.split(',').map((s) => s.trim())
        throw new UsageError(`--${flag} expects JSON, got "${raw}"`)
      }
    default:
      return raw
  }
}

type Parsed = { positionals: string[]; flags: Map<string, string[]>; negated: Set<string> }

function parseArgv(argv: string[], isBoolean: (flag: string) => boolean): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  const negated = new Set<string>()
  const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value])
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
      if (eq !== -1) add(name, token.slice(eq + 1))
      else if (name.startsWith('no-') && isBoolean(name.slice(3))) negated.add(name.slice(3))
      else if (isBoolean(name)) add(name, 'true')
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) add(name, argv[++i]!)
      else throw new UsageError(`--${name} needs a value`)
    } else if (/^-[a-zA-Z]$/.test(token) && SHORT[token[1]!]) {
      const name = SHORT[token[1]!]!
      if (isBoolean(name)) add(name, 'true')
      else if (i + 1 < argv.length) add(name, argv[++i]!)
      else throw new UsageError(`${token} needs a value`)
    } else {
      positionals.push(token)
    }
  }
  return { positionals, flags, negated }
}

// ---------------------------------------------------------------------------------------------
// What plugins add to this facet (the `adapters` slot, carried in the manifest)

type PluginCli = { flags: CliFlagSpec[]; commands: (CliCommandSpec & { words: string[] })[] }

function pluginCli(manifest: Manifest): PluginCli {
  const flags: CliFlagSpec[] = []
  const commands: (CliCommandSpec & { words: string[] })[] = []
  for (const adapter of manifest.adapters ?? []) {
    for (const flag of adapter.cli?.flags ?? []) flags.push(flag)
    for (const command of adapter.cli?.commands ?? []) commands.push({ ...command, words: command.command.split(/\s+/) })
  }
  return { flags, commands }
}

function resolveOp(manifest: Manifest, positionals: string[], plugin: PluginCli): { op?: ManifestOp; consumed: number } {
  let best: { op?: ManifestOp; consumed: number } = { consumed: 0 }
  // A plugin command is an alias for an op: it runs the same pipeline, through the same binding.
  for (const command of plugin.commands) {
    const words = command.words
    if (words.length <= positionals.length && words.every((w, i) => w === positionals[i]) && words.length > best.consumed) {
      const op = manifest.ops.find((o) => o.id === command.op && cliOf(o))
      if (op) best = { op, consumed: words.length }
    }
  }
  for (const op of manifest.ops) {
    const projection = cliOf(op)
    if (!projection) continue
    const cmd = projection.command
    if (cmd.length <= positionals.length && cmd.every((part, i) => part === positionals[i]) && cmd.length > best.consumed) {
      best = { op, consumed: cmd.length }
    }
  }
  return best
}

function pad(s: string, n: number) {
  return s + ' '.repeat(Math.max(0, n - s.length))
}

// ---------------------------------------------------------------------------------------------
// Help

function rootHelp(manifest: Manifest, bin: string, prefix: string[] = [], plugin: PluginCli = { flags: [], commands: [] }): string {
  const ops = manifest.ops.filter((o) => cliOf(o) && prefix.every((p, i) => cliOf(o)!.command[i] === p))
  const rows = ops.map((o) => [
    cliOf(o)!.command.join(' ') + cliOf(o)!.args.map((a: string) => ` <${kebab(a)}>`).join(''),
    o.description ?? '',
  ])
  if (!prefix.length) {
    for (const command of plugin.commands) rows.push([command.command, command.summary])
    rows.push(['login', 'Save an API key for this CLI'], ['logout', 'Remove saved credentials'])
  }
  const width = Math.max(...rows.map((r) => r[0]!.length), 10) + 2
  const lines = [
    prefix.length ? `${bin} ${prefix.join(' ')}` : `${bin}${manifest.description ? ` — ${manifest.description}` : ''}`,
    '',
    `Usage: ${bin} ${prefix.length ? prefix.join(' ') + ' ' : ''}<command> [flags]`,
    '',
    'Commands:',
    ...rows.map(([c, d]) => `  ${pad(c!, width)}${d}`),
    '',
    'Global flags:',
    '  --output, -o <table|json>  Output format (default: table in a terminal, json when piped)',
    '  --json <input>             Full input as JSON',
    '  --api-key <key>            API key (or ' + envPrefix(bin) + '_API_KEY, or `' + bin + ' login`)',
    '  --base-url <url>           Server URL (or ' + envPrefix(bin) + '_BASE_URL)',
    '  --yes, -y                  Skip confirmation for destructive commands',
    '  --idempotency-key <key>    Reuse a key to retry a write without repeating it',
    '  --help, -h                 Show help',
    ...plugin.flags.map((f) => {
      const usage = `  --${f.name}${f.type === 'boolean' ? '' : ' <value>'}`
      return `${pad(usage, 29)}${f.summary}${f.env ? ` (or ${f.env})` : ''}`
    }),
  ]
  return lines.join('\n') + '\n'
}

function opHelp(op: ManifestOp, bin: string): string {
  const cli = cliOf(op)!
  const required = new Set<string>(op.input.required ?? [])
  const rows: [string, string][] = []
  for (const [name, schema] of Object.entries(props(op.input))) {
    if (cli.args.includes(name)) continue
    const type = typeOf(schema) ?? 'value'
    const flag = type === 'boolean' ? `--${kebab(name)}` : `--${kebab(name)} <${schema.enum ? schema.enum.join('|') : type}>`
    const notes = [schema.description, required.has(name) ? '(required)' : '', schema.deprecated ? '(deprecated)' : '']
    rows.push([flag, notes.filter(Boolean).join(' ')])
  }
  if (op.traits.paginated) rows.push(['--all', 'Fetch every page'])
  if (op.traits.destructive) rows.push(['--yes, -y', 'Confirm without prompting'])
  const width = Math.max(...rows.map((r) => r[0].length), 10) + 2
  const usage = [bin, ...cli.command, ...cli.args.map((a) => `<${kebab(a)}>`), rows.length ? '[flags]' : ''].filter(Boolean).join(' ')
  return (
    [
      op.description ?? op.id,
      '',
      `Usage: ${usage}`,
      ...(rows.length ? ['', 'Flags:', ...rows.map(([f, d]) => `  ${pad(f, width)}${d}`)] : []),
      ...(op.traits.destructive ? ['', 'This command is destructive.'] : []),
    ].join('\n') + '\n'
  )
}

// ---------------------------------------------------------------------------------------------
// Output

// Masking, dates and which columns a table shows are `presentFields`/`tableColumns` from the core
// (docs/BACKLOG.md 12.3): the same rules the web facet's screens read, so the two cannot drift.

function renderTable(rows: Record<string, unknown>[], columns: string[], fields: Map<string, FieldPresentation>): string {
  if (!rows.length) return '(no results)\n'
  const cells = rows.map((row) => columns.map((c) => presentValue(row[c], fields.get(c))))
  const widths = columns.map((c, i) => Math.min(48, Math.max(c.length, ...cells.map((r) => r[i]!.length))))
  const fit = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : pad(s, w))
  const header = columns.map((c, i) => fit(c.toUpperCase(), widths[i]!)).join('  ')
  return [header, ...cells.map((r) => r.map((s, i) => fit(s, widths[i]!)).join('  '))].join('\n') + '\n'
}

function byName(fields: FieldPresentation[]): Map<string, FieldPresentation> {
  return new Map(fields.map((f) => [f.name, f]))
}

function renderHuman(op: ManifestOp, output: unknown, bin: string, allPages: boolean): string {
  if (output && typeof output === 'object' && Array.isArray((output as { items?: unknown }).items)) {
    const row = (props(op.output).items?.items ?? {}) as JSONSchema
    const fields = byName(presentFields(row, op.output))
    const columns = tableColumns(row, op.output, cliOf(op)?.columns)
    const page = output as { items: Record<string, unknown>[]; nextCursor?: string | null }
    let text = renderTable(page.items, columns.length ? columns : Object.keys(page.items[0] ?? {}), fields)
    if (page.nextCursor && !allPages) text += `\nMore results: ${bin} ${cliOf(op)!.command.join(' ')} --cursor ${page.nextCursor}  (or --all)\n`
    return text
  }
  if (output && typeof output === 'object') {
    const entries = Object.entries(output as Record<string, unknown>)
    const fields = byName(presentFields(op.output))
    const width = Math.max(...entries.map(([k]) => k.length), 4) + 2
    return entries.map(([k, v]) => `${pad(k, width)}${presentValue(v, fields.get(k))}`).join('\n') + '\n'
  }
  return presentValue(output) + '\n'
}

// ---------------------------------------------------------------------------------------------
// Credentials

type StoredCredentials = { baseUrl?: string; apiKey?: string }

async function readCredentials(dir: string): Promise<StoredCredentials> {
  try {
    return JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8')) as StoredCredentials
  } catch {
    return {}
  }
}

async function writeCredentials(dir: string, creds: StoredCredentials): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'credentials.json'), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
}

// ---------------------------------------------------------------------------------------------
// runCli

export async function runCli(options: RunCliOptions): Promise<number> {
  const { manifest } = options
  const bin = options.binName ?? cliSettings(manifest)?.binName ?? manifest.name
  const env = options.env ?? process.env
  const io: CliIO = {
    stdout: options.io?.stdout ?? process.stdout,
    stderr: options.io?.stderr ?? process.stderr,
    stdinIsTTY: options.io?.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    prompt: options.io?.prompt,
  }
  const configDir = options.configDir ?? join(homedir(), '.config', bin)
  const prefix = envPrefix(bin)

  try {
    // Commands come first (`tasks list --done`), so resolve the op from the leading words, then parse
    // flags once with its schema so boolean flags never swallow the next token.
    const firstFlag = options.argv.findIndex((a) => a.startsWith('-'))
    const leading = firstFlag === -1 ? options.argv : options.argv.slice(0, firstFlag)
    const plugin = pluginCli(manifest)
    const pluginFlags = new Map(plugin.flags.map((f) => [f.name, f]))
    const { op, consumed } = resolveOp(manifest, leading, plugin)
    const opProps = op ? props(op.input) : {}
    const isBoolean = (flag: string) =>
      GLOBAL_BOOLEANS.has(flag) || pluginFlags.get(flag)?.type === 'boolean' || typeOf(opProps[camel(flag)]) === 'boolean'
    const { positionals, flags, negated } = parseArgv(options.argv, isBoolean)
    const flag = (name: string) => flags.get(name)?.at(-1)
    const want = (name: string) => flag(name) === 'true'

    if (want('version') && !op) {
      io.stdout.write(`${bin} ${manifest.version}\n`)
      return 0
    }

    const stored = await readCredentials(configDir)
    // Empty env vars count as unset.
    const baseUrl = flag('base-url') || env[`${prefix}_BASE_URL`] || stored.baseUrl || options.defaultBaseUrl || 'http://localhost:3000'
    // A plugin may contribute another way to present the same credential (`adapters.cli`). The
    // built-in flag still wins, and what the credential *means* is the server's business.
    const pluginKey = plugin.flags
      .filter((f) => f.credential)
      .map((f) => flag(f.name) || (f.env ? env[f.env] : undefined))
      .find(Boolean)
    const apiKey = flag('api-key') || env[`${prefix}_API_KEY`] || stored.apiKey || pluginKey
    const caller = createCaller({
      baseUrl,
      apiKey,
      manifest,
      fetch: options.fetch,
      retries: options.retries,
      clientName: `${bin}-cli/${manifest.version}`,
      via: 'cli',
      // Given explicitly, it survives across separate CLI runs; otherwise the client mints one per call.
      ...(flag('idempotency-key') ? { headers: { 'idempotency-key': flag('idempotency-key')! } } : {}),
    })

    if (!op) {
      const [command] = positionals
      if (command === 'login') {
        let key = flag('api-key')
        if (!key && io.stdinIsTTY && io.prompt) key = (await io.prompt('API key: ')).trim()
        if (!key) throw new UsageError(`Usage: ${bin} login --api-key <key>`)
        const probe = createCaller({ baseUrl, apiKey: key, manifest, fetch: options.fetch, retries: 0, clientName: `${bin}-cli/${manifest.version}`, via: 'cli' })
        let who = ''
        if (manifest.ops.some((o) => o.id === 'auth.whoami' && restOf(o))) {
          const me = (await probe.call('auth.whoami')) as { id: string; kind: string }
          if (me.kind === 'anonymous') throw new FacetClientError('unauthenticated', 'That API key was not accepted')
          who = ` as ${me.id}`
        }
        await writeCredentials(configDir, { baseUrl, apiKey: key })
        io.stdout.write(`Logged in${who}. Credentials saved to ${join(configDir, 'credentials.json')}\n`)
        return 0
      }
      if (command === 'logout') {
        await writeCredentials(configDir, {})
        io.stdout.write('Logged out.\n')
        return 0
      }
      const known = positionals.filter((p) => p !== 'help')
      const isGroup = known.length > 0 && manifest.ops.some((o) => cliOf(o) && known.every((p, i) => cliOf(o)!.command[i] === p))
      if (command === undefined || command === 'help' || want('help') || isGroup) {
        io.stdout.write(rootHelp(manifest, bin, isGroup ? known : [], plugin))
        return command === undefined || command === 'help' || want('help') || isGroup ? 0 : 2
      }
      throw new UsageError(`Unknown command "${positionals.join(' ')}". Run \`${bin} --help\`.`)
    }

    if (want('help')) {
      io.stdout.write(opHelp(op, bin))
      return 0
    }

    // Build input: --json, then positionals, then flags.
    const cli = cliOf(op)!
    const input: Record<string, unknown> = {}
    const json = flag('json')
    if (json !== undefined) {
      try {
        Object.assign(input, JSON.parse(json))
      } catch {
        throw new UsageError('--json expects a JSON object')
      }
    }
    const extra = positionals.slice(consumed)
    if (extra.length > cli.args.length) throw new UsageError(`Unexpected argument "${extra[cli.args.length]}". Run \`${bin} ${cli.command.join(' ')} --help\`.`)
    extra.forEach((value, i) => {
      const name = cli.args[i]!
      input[name] = coerce(value, opProps[name], kebab(name))
    })
    for (const [name, values] of flags) {
      if (GLOBAL_BOOLEANS.has(name) || GLOBAL_VALUES.has(name) || pluginFlags.has(name)) continue
      const key = camel(name)
      const schema = opProps[key]
      if (!schema) throw new UsageError(`Unknown flag --${name}. Run \`${bin} ${cli.command.join(' ')} --help\`.`)
      input[key] =
        typeOf(schema) === 'array' && values.length > 1
          ? values.map((v) => coerce(v, schema.items, name))
          : coerce(values.at(-1)!, schema, name)
    }
    for (const name of negated) {
      const key = camel(name)
      if (!opProps[key]) throw new UsageError(`Unknown flag --no-${name}`)
      input[key] = false
    }
    const missing = (op.input.required ?? []).filter((r: string) => input[r] === undefined)
    if (missing.length) {
      const how = missing.map((m: string) => (cli.args.includes(m) ? `<${kebab(m)}>` : `--${kebab(m)}`)).join(', ')
      throw new UsageError(`Missing required ${how}. Run \`${bin} ${cli.command.join(' ')} --help\`.`)
    }

    if (op.traits.destructive && !want('yes')) {
      if (!io.stdinIsTTY || !io.prompt) {
        throw new UsageError(`\`${bin} ${cli.command.join(' ')}\` is destructive. Re-run with --yes to confirm.`)
      }
      const answer = (await io.prompt(`${op.description ?? op.id}. Continue? [y/N] `)).trim().toLowerCase()
      if (answer !== 'y' && answer !== 'yes') {
        io.stderr.write('Aborted.\n')
        return 1
      }
    }

    const all = want('all') && Boolean(op.traits.paginated)
    let output: unknown
    if (all) {
      const items: unknown[] = []
      for await (const item of caller.iterate(op.id, input)) items.push(item)
      output = { items, nextCursor: null }
    } else {
      output = await caller.call(op.id, input)
    }

    const format = flag('output') ?? (io.stdout.isTTY ? 'table' : 'json')
    if (format !== 'json' && format !== 'table') throw new UsageError('--output must be table or json')
    io.stdout.write(format === 'json' ? JSON.stringify(output, null, 2) + '\n' : renderHuman(op, output, bin, all))
    return 0
  } catch (raw) {
    if (raw instanceof UsageError) {
      io.stderr.write(`Error: ${raw.message}\n`)
      return EXIT_CODES.usage
    }
    if (raw instanceof FacetClientError) {
      const lines = [`Error (${raw.code}): ${raw.message}`]
      for (const issue of raw.issues ?? []) lines.push(`  ${issue.path ? `--${kebab(issue.path.split('.')[0]!)}` : 'input'}: ${issue.message}`)
      if (raw.code === 'unauthenticated') lines.push(`Run \`${bin} login\` or set ${prefix}_API_KEY.`)
      if (raw.code === 'rate_limited' && raw.retryAfter) lines.push(`Try again in ${raw.retryAfter}s.`)
      if (raw.code === 'network') lines.push(`Is the server running? Set --base-url or ${prefix}_BASE_URL.`)
      if (raw.requestId) lines.push(`Request id: ${raw.requestId}`)
      io.stderr.write(lines.join('\n') + '\n')
      return EXIT_CODES[raw.code] ?? 1
    }
    io.stderr.write(`Error: ${(raw as Error)?.message ?? String(raw)}\n`)
    return 1
  }
}
