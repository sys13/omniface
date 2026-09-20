import type { App, NormalizedFacets } from './app.ts'
import { objectProperties, type JSONSchema } from './jsonschema.ts'
import { buildManifest, type Manifest } from './manifest.ts'
import { takeUnreachedTraitSchemas } from './traits.ts'

export type LintFinding = {
  level: 'error' | 'warn'
  rule: string
  message: string
  /** The op the finding is about, when it is about one. */
  op?: string
  /**
   * What `omniface lint --fix` would rewrite: the op's `input:` or `output:`, wrapped in `t.named()`.
   * A name is only suggested for an expression written inline — when the schema is a `const`, the
   * fix uses the name it already has, which is better than anything derived.
   */
  fix?: { io: 'input' | 'output'; suggestedName: string }
}

export type LintOptions = {
  /**
   * Check for traits set on schemas no op reaches. Off by default because the trait registry is
   * process-wide rather than per-app: in a process that built several apps — a test suite, or
   * conformance's fresh app per case — an orphan cannot be attributed to the app being linted.
   * `omniface lint` turns it on, having loaded exactly one definition.
   */
  unusedTraits?: boolean
}

export const MCP_TOOL_BUDGET = 15

/**
 * Whether a schema refers to itself. Checking for `$defs` alone missed the shape zod 4 actually
 * emits for a recursive type — a bare `{ $ref: '#' }` pointing at the document root, with no
 * `$defs` anywhere — which is the case the rule exists for, so any internal `$ref` counts.
 */
function isRecursive(json: JSONSchema, depth = 0): boolean {
  if (!json || typeof json !== 'object' || depth > 12) return false
  if (typeof json.$ref === 'string' && json.$ref.startsWith('#')) return true
  if (json.$defs) return true
  return Object.entries(json).some(([key, value]) =>
    key === 'x-omniface-name'
      ? false
      : Array.isArray(value)
        ? value.some((v) => isRecursive(v as JSONSchema, depth + 1))
        : isRecursive(value as JSONSchema, depth + 1),
  )
}

/** `tasks.create` + `input` → `TasksCreateInput`: the name a schema would have had anyway. */
function derivedName(path: string[], io: 'input' | 'output'): string {
  const pascal = (s: string) => s.replace(/(^|[^A-Za-z0-9])([a-z])/g, (_, _sep, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '')
  return `${path.map(pascal).join('')}${io === 'input' ? 'Input' : 'Output'}`
}

/**
 * When per-op overrides stop being exceptions (docs/DX.md, the ladder). A ratio rather than a
 * count, because "a few" means something different in a six-op app than a sixty-op one, with a
 * floor so a two-op app is never accused of anything.
 */
export const OVERRIDE_BUDGET = { ratio: 1 / 3, min: 3 }

/** The override kinds that reshape an op on one facet — ladder step 3. `false` is step 2: it turns
 * the projection off rather than restating it, which is a decision, not a divergence. */
const OVERRIDE_KEYS = {
  rest: ['method', 'path', 'status'],
  mcp: ['name', 'description', 'maxItems'],
  cli: ['command', 'args', 'columns'],
} as const

const ADVICE: Record<string, string> = {
  rest: 'Rewriting many paths usually means the ops are named wrong; rename the ops instead.',
  mcp: 'Descriptions that restate the field list are better written on the op, where every facet gets them.',
  cli: 'Mirroring every op 1:1 as a hand-named command is the CLI facet doing the definition\u2019s job.',
}

function overriddenOps(facets: NormalizedFacets, facet: keyof typeof OVERRIDE_KEYS): string[] {
  const ops = (facets[facet] as { ops?: Record<string, unknown> } | null)?.ops ?? {}
  const keys = OVERRIDE_KEYS[facet] as readonly string[]
  return Object.entries(ops)
    .filter(([, o]) => o && typeof o === 'object' && keys.some((k) => k in (o as object)))
    .map(([id]) => id)
}

/** Checks that keep "tiny input, large output" honest. Most correctness checks already run at startup. */
export function lint(app: App, manifest: Manifest = buildManifest(app), options: LintOptions = {}): LintFinding[] {
  const findings: LintFinding[] = []

  if (manifest.mcpTools.length > MCP_TOOL_BUDGET) {
    const byNamespace = new Map<string, string[]>()
    for (const op of manifest.ops) {
      if (op.mcp && 'tool' in op.mcp && op.path.length > 1) {
        byNamespace.set(op.path[0]!, [...(byNamespace.get(op.path[0]!) ?? []), op.id])
      }
    }
    const suggestions = [...byNamespace.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([ns, ids]) => `  mcp.tools.manage_${ns}: { description: '…', ops: ${JSON.stringify(ids)} }`)
    findings.push({
      level: 'warn',
      rule: 'mcp-tool-budget',
      message:
        `${manifest.mcpTools.length} MCP tools (budget ${MCP_TOOL_BUDGET}). Agents choose tools less reliably past this. ` +
        `Consider grouping by intent, e.g.:\n${suggestions.join('\n')}`,
    })
  }

  if ((manifest.facets.cli || manifest.facets.sdk) && !manifest.facets.rest) {
    findings.push({
      level: 'error',
      rule: 'http-facets-need-rest',
      message: 'The CLI and SDK call the server over HTTP, so they need the rest facet enabled.',
    })
  }

  for (const op of manifest.ops) {
    if (op.traits.paginated) {
      const input = objectProperties(op.input)
      const output = objectProperties(op.output)
      if (!('cursor' in input) || !('items' in output) || !('nextCursor' in output)) {
        findings.push({
          level: 'error',
          rule: 'paginated-shape',
          message: `${op.id} is paginated but its input lacks cursor or its output lacks items/nextCursor. Use t.pageInput() and t.page().`,
        })
      }
    }
    if (!op.description) {
      findings.push({
        level: 'warn',
        rule: 'op-description',
        message: `${op.id} has no description; MCP tools, CLI help and docs fall back to the id.`,
      })
    }
    if (op.traits.destructive && op.traits.readonly) {
      findings.push({ level: 'error', rule: 'trait-conflict', message: `${op.id} is both readonly and destructive.` })
    }
  }

  // Named types: the same schema used by more than one op should have a name (docs/SCHEMA.md, Decisions).
  const seen = new Map<object, string[]>()
  for (const reg of app.ops.values()) {
    if (reg.op.traits.internal) continue
    for (const schema of [reg.op.input, reg.op.output]) seen.set(schema, [...(seen.get(schema) ?? []), reg.id])
  }
  for (const reg of app.ops.values()) {
    for (const [schema, json] of [
      [reg.op.input, reg.inputSchema],
      [reg.op.output, reg.outputSchema],
    ] as const) {
      const users = seen.get(schema) ?? []
      const io = schema === reg.op.input ? 'input' : 'output'
      if (users.length > 1 && users[0] === reg.id && !json['x-omniface-name'] && json.type === 'object' && Object.keys(json.properties ?? {}).length) {
        findings.push({
          level: 'warn',
          rule: 'name-shared-types',
          message: `A schema shared by ${[...new Set(users)].join(', ')} has no name. Wrap it in t.named('…', schema) for stable SDK and OpenAPI names.`,
          op: reg.id,
          fix: { io, suggestedName: derivedName(reg.path, io) },
        })
      }
      if (isRecursive(json) && !json['x-omniface-name']) {
        findings.push({
          level: 'error',
          rule: 'name-recursive-types',
          message:
            `${reg.id} uses a recursive schema without a name. The schema refers to itself, and an anonymous ` +
            `type has nothing for the reference to point at, so every generator downstream has to invent a name ` +
            `or inline forever. Wrap it in t.named('…', schema).`,
          op: reg.id,
          fix: { io, suggestedName: derivedName(reg.path, io) },
        })
      }
    }
  }

  // Override budget: step 3 of the ladder is for exceptions, and stops being an exception when
  // most of a facet is written that way (docs/DX.md).
  for (const facet of ['rest', 'mcp', 'cli'] as const) {
    if (!manifest.facets[facet]) continue
    const overridden = overriddenOps(app.facets, facet)
    const projected = manifest.ops.filter((op) => op[facet]).length
    if (overridden.length >= OVERRIDE_BUDGET.min && projected > 0 && overridden.length / projected > OVERRIDE_BUDGET.ratio) {
      findings.push({
        level: 'warn',
        rule: 'override-budget',
        message:
          `${overridden.length} of ${projected} ${facet} ops carry a per-op override (${overridden.join(', ')}). ` +
          `Overrides are the ladder's step 3, for the cases convention and traits cannot reach. ${ADVICE[facet]}`,
      })
    }
  }

  // Traits on a schema no op's input or output ever reached. `pii` that redacts nothing and
  // `internal` that strips nothing read as protection in the source while protecting nothing, so
  // the point is to make a trait that is doing no work visible rather than silent.
  for (const traits of options.unusedTraits ? takeUnreachedTraitSchemas() : []) {
    const shown = Object.entries(traits)
      .filter(([k]) => k !== 'description')
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ')
    findings.push({
      level: 'warn',
      rule: 'unused-trait',
      message:
        `Traits { ${shown} }${traits.description ? ` (on "${traits.description}")` : ''} are set on a schema no op reaches, ` +
        'so they affect nothing. Either the field was dropped from the op and the declaration outlived it, or the tagged ' +
        'schema was replaced by an untagged one.',
    })
  }

  return findings
}
