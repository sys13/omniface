import type { App, CliConfig } from '../app.ts'
import { defineFacet, registerFacet, projectionOf, settingsOf, type FacetChange } from '../facet.ts'
import { objectProperties, requiredProperties } from '../jsonschema.ts'
import type { Manifest, ManifestOp } from '../manifest.ts'
import { kebab } from '../naming.ts'
import { conventionalCommand } from '../naming.ts'
import { shellQuote } from '../shell.ts'

/** What the CLI facet does with one op: the command it becomes, and how its input is spelled. */
export type CliProjection = { command: string[]; args: string[]; columns?: string[] }

export type CliSettings = { binName: string }

export const cliOf = (op: ManifestOp): CliProjection | null => projectionOf<CliProjection>(op, 'cli')
export const cliSettings = (manifest: Manifest): CliSettings | null => settingsOf<CliSettings>(manifest, 'cli')

function snippet(bin: string, projection: CliProjection, op: ManifestOp, example: Record<string, unknown>): string {
  const parts = [bin, ...projection.command]
  for (const arg of projection.args) if (arg in example) parts.push(shellQuote(String(example[arg])))
  for (const [key, value] of Object.entries(example)) {
    if (projection.args.includes(key) || value === null || value === undefined) continue
    if (value === true) parts.push(`--${kebab(key)}`)
    else if (typeof value === 'object') parts.push(`--${kebab(key)}`, shellQuote(JSON.stringify(value)))
    else parts.push(`--${kebab(key)}`, shellQuote(String(value)))
  }
  if (op.traits.destructive) parts.push('--yes')
  return parts.join(' ')
}

/**
 * The CLI facet. Not served — the generated bin runs in another process and reads the manifest,
 * which is the whole reason a facet's projection has to travel as data.
 */
export const cliFacet = defineFacet<CliConfig, CliProjection, CliSettings>({
  name: 'cli',
  order: 2,
  defaultOn: true,
  normalize: (value) => (value === undefined || value === false ? null : value === true ? {} : (value as CliConfig)),
  references: (config) => [{ where: 'cli.ops', ids: Object.keys(config.ops ?? {}) }],

  project({ op, input }, config) {
    const override = config.ops?.[op.id]
    if (override === false) return null
    const required = requiredProperties(input)
    // Convention: a lone required `id` is positional (`acme tasks get <id>`).
    const conventionalArgs = required.length === 1 && required[0] === 'id' ? ['id'] : []
    return {
      command: override?.command ? override.command.split(/\s+/) : conventionalCommand(op.path),
      args: override?.args ?? conventionalArgs,
      ...(override?.columns ? { columns: override.columns } : {}),
    }
  },

  settings: (app: App, config) => ({ binName: config.binName ?? app.name }),

  // The CLI reads `destructive` as "confirm first", so turning it on breaks scripts: they block on
  // a prompt, or refuse on a non-TTY. REST and MCP only gain a hint.
  observes: { traits: ['destructive'] },

  diff(before, after, { op }): FacetChange[] {
    const changes: FacetChange[] = []
    if (before.command.join(' ') !== after.command.join(' ')) {
      changes.push({
        level: 'breaking',
        rule: 'cli-command-renamed',
        message: `${op}: \`${after.command.join(' ')}\` — was \`${before.command.join(' ')}\`.`,
        detail: 'Scripts, aliases and docs naming the old command stop working.',
      })
    }
    if (before.args.join(' ') !== after.args.join(' ')) {
      changes.push({
        level: 'breaking',
        rule: 'cli-args-changed',
        message: `${op}: positional arguments [${before.args.join(' ')}] → [${after.args.join(' ')}].`,
        detail: 'A value that used to be positional is now a flag, or the reverse; either way the old invocation is wrong.',
      })
    }
    const was = before.columns?.join(',')
    const now = after.columns?.join(',')
    if (was !== now) {
      changes.push({
        level: 'neutral',
        rule: 'cli-columns-changed',
        message: `${op}: table columns ${was ?? '(default)'} → ${now ?? '(default)'}.`,
        detail: 'Presentation only — `--output json` is unchanged.',
      })
    }
    return changes
  },

  diffSettings(before, after): FacetChange[] {
    if (before.binName === after.binName) return []
    return [
      {
        level: 'breaking',
        rule: 'cli-bin-renamed',
        message: `The CLI binary was renamed ${before.binName} → ${after.binName}.`,
        detail: `Every script calling \`${before.binName}\`, and the ${before.binName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_* environment variables, stop resolving.`,
      },
    ]
  },

  present({ manifest, op, example }, projection) {
    const bin = cliSettings(manifest)?.binName ?? manifest.name
    const snip = snippet(bin, projection, op, example)
    return {
      label: 'CLI',
      short: [bin, ...projection.command].join(' '),
      snippet: snip,
      line: `- CLI: \`${snip}\``,
      detail: { command: [bin, ...projection.command].join(' ') },
    }
  },

  summary: () => 'a CLI',

  contract({ app, op, others }, projection) {
    const problems: string[] = []
    const config = app.facets['cli'] as CliConfig | null
    if (!projection) {
      if (config?.ops?.[op.id] !== false) problems.push('no CLI binding')
      return problems
    }
    const props = Object.keys(objectProperties(op.input))
    for (const a of projection.args) if (!props.includes(a)) problems.push(`CLI arg "${a}" is not an input field`)
    for (const c of projection.columns ?? []) {
      const items = objectProperties(op.output)['items']
      const row = items?.items ?? items
      if (row && Object.keys(objectProperties(row, op.output)).length && !(c in objectProperties(row, op.output))) {
        problems.push(`CLI column "${c}" is not an output field`)
      }
    }
    for (const other of others) {
      const theirs = cliOf(other)
      if (theirs && theirs.command.join(' ') === projection.command.join(' ')) {
        problems.push(`CLI command "${projection.command.join(' ')}" collides with ${other.id}`)
      }
    }
    return problems
  },
})

// Registered here rather than in a list elsewhere: a facet module that is imported is a facet the
// app has. It also keeps the import cycle with this facet's server module harmless.
registerFacet(cliFacet)
