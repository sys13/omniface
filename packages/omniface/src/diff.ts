import { objectProperties, requiredProperties, typeOf, type JSONSchema } from './jsonschema.ts'
import { MANIFEST_VERSION, type Manifest, type ManifestAdapters, type ManifestOp } from './manifest.ts'

/**
 * `omniface diff` — what changed between two versions of an app, and which facets it breaks.
 *
 * One definition projects onto several interfaces, so "is this breaking?" has one answer per facet, and they
 * disagree more often than not. Renaming an op's output type breaks a generated SDK and nothing
 * else. Marking an op `destructive` breaks CLI scripts, because the CLI starts prompting, while
 * REST and MCP carry on unchanged. Adding an optional input field breaks nobody. A single
 * verdict would have to take the worst of them and call every release breaking; the useful
 * report is per facet, which is what this produces: "breaks the SDK and a CLI flag, not MCP".
 *
 * The inputs are manifests, not app definitions. The manifest already is every facet's view of
 * every op (docs/README.md, principle 6), so the diff is a data comparison rather than four
 * facet-specific diffs kept in step by hand — a rule added to a facet's projection shows up here
 * the moment it reaches the manifest.
 */

export type FacetKey = 'rest' | 'mcp' | 'cli' | 'sdk' | 'web'

export const FACET_KEYS: readonly FacetKey[] = ['rest', 'mcp', 'cli', 'sdk', 'web']

/**
 * - `breaking` — a caller that worked against `before` can stop working.
 * - `additive` — new surface; every existing caller keeps working.
 * - `neutral` — visible in the manifest, but no caller can tell (help text, descriptions, hints).
 */
export type ChangeLevel = 'breaking' | 'additive' | 'neutral'

export type ManifestChange = {
  level: ChangeLevel
  /** Stable rule id, so CI can allow one class of change without allowing all of them. */
  rule: string
  /** The op the change belongs to, when it belongs to one. */
  op?: string
  /** Which facets a caller would notice this on. Empty means app-wide with no facet projected. */
  facets: FacetKey[]
  message: string
  /** Why it breaks, or what to do instead. Printed indented under the message. */
  detail?: string
}

export type ManifestDiff = {
  before: { name: string; version: string }
  after: { name: string; version: string }
  changes: ManifestChange[]
  /** Facets carrying at least one breaking change — the headline of the report. */
  breakingFacets: FacetKey[]
  /** Facets the app has that carry no breaking change. */
  compatibleFacets: FacetKey[]
  counts: Record<ChangeLevel, number>
  /** Pre-1.0 the breaking bump is `minor` and everything else is `patch` (docs/RELEASING.md). */
  suggestedBump: 'major' | 'minor' | 'patch'
}

// ---------------------------------------------------------------------------------------------
// Comparing schemas
//
// Field-by-field rather than deep-equal: "the output changed" is not actionable, and most real
// changes are one field. Paths are dotted, with `[]` for a step through an array, so `items[].title`
// reads the same as the client code that would break.

const MAX_DEPTH = 6

function deref(node: JSONSchema | undefined, root: JSONSchema): JSONSchema | undefined {
  let current = node
  for (let i = 0; current && typeof current.$ref === 'string' && i < 32; i++) {
    const ref: string = current.$ref
    if (!ref.startsWith('#/')) return current
    let target: any = root
    for (const part of ref.slice(2).split('/')) target = target?.[part]
    current = target
  }
  return current
}

function itemsOf(node: JSONSchema, root: JSONSchema): JSONSchema | undefined {
  if (node.items && typeof node.items === 'object') return deref(node.items, root)
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
    const found = itemsOf(branch as JSONSchema, root)
    if (found) return found
  }
  return undefined
}

type Field = {
  path: string
  type?: string
  required: boolean
  enum?: string[]
  /** Deprecation is a promise about the *next* removal, so it is tracked as its own change. */
  deprecated?: boolean
}

/**
 * Every leaf and branch of a schema as a flat map of path → shape. Recursive schemas are cut at
 * the first repeat on the current path: a cycle has no new fields to report, and the `$ref` name
 * that produced it is compared separately as a type name.
 */
function flattenFields(
  node: JSONSchema | undefined,
  root: JSONSchema,
  prefix = '',
  onPath: JSONSchema[] = [],
  out = new Map<string, Field>(),
): Map<string, Field> {
  const n = deref(node, root)
  if (!n || onPath.includes(n) || onPath.length > MAX_DEPTH) return out
  const next = [...onPath, n]
  if (typeOf(n) === 'array') {
    const items = itemsOf(n, root)
    if (items) flattenFields(items, root, `${prefix}[]`, next, out)
    return out
  }
  const required = new Set(requiredProperties(n, root))
  for (const [key, schema] of Object.entries(objectProperties(n, root))) {
    const path = prefix ? `${prefix}.${key}` : key
    const enumValues = Array.isArray(schema.enum) ? schema.enum.map((v: unknown) => String(v)) : undefined
    out.set(path, {
      path,
      type: typeOf(schema),
      required: required.has(key),
      ...(enumValues ? { enum: enumValues } : {}),
      ...(schema.deprecated ? { deprecated: true } : {}),
    })
    flattenFields(schema, root, path, next, out)
  }
  return out
}

/** The published name of a schema, which is what an SDK or OpenAPI component is called. */
function typeName(schema: JSONSchema | undefined): string | undefined {
  return schema?.['x-omniface-name'] as string | undefined
}

// ---------------------------------------------------------------------------------------------
// Which facets a change is visible on

/** The facets an op is projected onto in a given manifest. */
function opFacets(op: ManifestOp | undefined): FacetKey[] {
  if (!op) return []
  return FACET_KEYS.filter((f) => op[f] !== null && op[f] !== undefined)
}

/** The facets both versions of an op share — where an existing caller could exist to break. */
function sharedFacets(before: ManifestOp, after: ManifestOp): FacetKey[] {
  const a = new Set(opFacets(after))
  return opFacets(before).filter((f) => a.has(f))
}

// ---------------------------------------------------------------------------------------------
// Rules

function diffApp(before: Manifest, after: Manifest, push: (c: ManifestChange) => void): void {
  if (before.name !== after.name) {
    push({
      level: 'breaking',
      rule: 'app-renamed',
      facets: FACET_KEYS.filter((f) => before.facets[f] && after.facets[f]),
      message: `The app was renamed ${before.name} → ${after.name}.`,
      detail: 'The name reaches every facet: SDK package, CLI bin, MCP server name, OpenAPI title.',
    })
  }
  for (const facet of FACET_KEYS) {
    if (before.facets[facet] && !after.facets[facet]) {
      push({ level: 'breaking', rule: 'facet-removed', facets: [facet], message: `The ${facet} facet was turned off.` })
    } else if (!before.facets[facet] && after.facets[facet]) {
      push({ level: 'additive', rule: 'facet-added', facets: [facet], message: `The ${facet} facet was turned on.` })
    }
  }
  const beforeBin = before.cli?.binName
  const afterBin = after.cli?.binName
  if (beforeBin && afterBin && beforeBin !== afterBin) {
    push({
      level: 'breaking',
      rule: 'cli-bin-renamed',
      facets: ['cli'],
      message: `The CLI binary was renamed ${beforeBin} → ${afterBin}.`,
      detail: `Every script calling \`${beforeBin}\`, and the ${beforeBin.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_* environment variables, stop resolving.`,
    })
  }
  const beforeMount = before.web?.path
  const afterMount = after.web?.path
  if (beforeMount && afterMount && beforeMount !== afterMount) {
    push({
      level: 'breaking',
      rule: 'web-mount-moved',
      facets: ['web'],
      message: `The web facet moved ${beforeMount} → ${afterMount}.`,
      detail: 'Every screen URL changes at once: bookmarks, links and any WebMCP registration tied to the page.',
    })
  }
  const beforePkg = before.sdk?.packageName
  const afterPkg = after.sdk?.packageName
  if (beforePkg && afterPkg && beforePkg !== afterPkg) {
    push({
      level: 'breaking',
      rule: 'sdk-package-renamed',
      facets: ['sdk'],
      message: `The SDK package was renamed ${beforePkg} → ${afterPkg}.`,
      detail: `Every \`import … from '${beforePkg}'\` stops resolving, and the old name keeps installing the old version.`,
    })
  }
}

function diffOpPresence(before: Manifest, after: Manifest, push: (c: ManifestChange) => void): void {
  const afterOps = new Map(after.ops.map((o) => [o.id, o]))
  for (const op of before.ops) {
    if (afterOps.has(op.id)) continue
    push({
      level: 'breaking',
      rule: 'op-removed',
      op: op.id,
      facets: opFacets(op),
      message: `${op.id} is gone.`,
      detail: 'Either the op was deleted or it became `internal`, which removes it from every facet.',
    })
  }
  const beforeOps = new Map(before.ops.map((o) => [o.id, o]))
  for (const op of after.ops) {
    if (beforeOps.has(op.id)) continue
    push({ level: 'additive', rule: 'op-added', op: op.id, facets: opFacets(op), message: `${op.id} is new.` })
  }
}

function diffProjection(before: ManifestOp, after: ManifestOp, push: (c: ManifestChange) => void): void {
  for (const facet of FACET_KEYS) {
    const was = before[facet] !== null && before[facet] !== undefined
    const is = after[facet] !== null && after[facet] !== undefined
    if (was && !is) {
      push({
        level: 'breaking',
        rule: 'op-unprojected',
        op: before.id,
        facets: [facet],
        message: `${before.id} is no longer exposed on ${facet}.`,
      })
    } else if (!was && is) {
      push({ level: 'additive', rule: 'op-projected', op: before.id, facets: [facet], message: `${before.id} is now exposed on ${facet}.` })
    }
  }
}

function diffSchema(
  before: ManifestOp,
  after: ManifestOp,
  io: 'input' | 'output',
  push: (c: ManifestChange) => void,
): void {
  const facets = sharedFacets(before, after)
  if (!facets.length) return
  const from = flattenFields(before[io], before[io])
  const to = flattenFields(after[io], after[io])
  const id = before.id

  // A renamed type is a renamed SDK class and a renamed OpenAPI component (docs/SCHEMA.md), even
  // when every field inside it is identical.
  const wasNamed = typeName(before[io])
  const isNamed = typeName(after[io])
  if (wasNamed !== isNamed && (wasNamed || isNamed)) {
    push({
      level: 'breaking',
      rule: 'type-renamed',
      op: id,
      facets: facets.filter((f) => f === 'sdk' || f === 'rest'),
      message: `${id} ${io} type ${wasNamed ?? '(derived)'} → ${isNamed ?? '(derived)'}.`,
      detail: 'Generated SDKs export the type under this name, and OpenAPI components are keyed by it.',
    })
  }

  for (const [path, field] of from) {
    const now = to.get(path)
    if (!now) {
      const detail =
        io === 'input'
          ? 'Callers still sending it fail validation; the SDK property and the CLI flag are gone.'
          : 'Anything reading it — a CLI column, an SDK property, an agent parsing the tool result — sees nothing.'
      push({
        level: 'breaking',
        rule: `${io}-field-removed`,
        op: id,
        facets,
        message: `${id}: ${io} field \`${path}\` removed.`,
        detail,
      })
      continue
    }
    if (field.type && now.type && field.type !== now.type) {
      push({
        level: 'breaking',
        rule: `${io}-field-retyped`,
        op: id,
        facets,
        message: `${id}: ${io} field \`${path}\` is ${now.type}, was ${field.type}.`,
      })
    }
    if (io === 'input' && !field.required && now.required) {
      push({
        level: 'breaking',
        rule: 'input-field-required',
        op: id,
        facets,
        message: `${id}: input field \`${path}\` is now required.`,
        detail: 'Every existing call that omitted it fails validation.',
      })
    }
    if (io === 'input' && field.required && !now.required) {
      push({ level: 'additive', rule: 'input-field-optional', op: id, facets, message: `${id}: input field \`${path}\` is now optional.` })
    }
    if (io === 'output' && field.required && !now.required) {
      push({
        level: 'breaking',
        rule: 'output-field-optional',
        op: id,
        facets,
        message: `${id}: output field \`${path}\` may now be absent.`,
        detail: 'It was guaranteed; callers that never checked for it now can be handed undefined.',
      })
    }
    if (field.enum && now.enum) {
      const removed = field.enum.filter((v) => !now.enum!.includes(v))
      const added = now.enum.filter((v) => !field.enum!.includes(v))
      // Input enums are what a caller may send, output enums what it must handle, so widening
      // one is safe and widening the other is not.
      if (removed.length && io === 'input') {
        push({
          level: 'breaking',
          rule: 'input-enum-narrowed',
          op: id,
          facets,
          message: `${id}: input field \`${path}\` no longer accepts ${removed.map((v) => `\`${v}\``).join(', ')}.`,
        })
      }
      if (added.length && io === 'output') {
        push({
          level: 'breaking',
          rule: 'output-enum-widened',
          op: id,
          facets,
          message: `${id}: output field \`${path}\` can now be ${added.map((v) => `\`${v}\``).join(', ')}.`,
          detail: 'An exhaustive switch over the old values falls through on the new one.',
        })
      }
      if (added.length && io === 'input') {
        push({ level: 'additive', rule: 'input-enum-widened', op: id, facets, message: `${id}: input field \`${path}\` also accepts ${added.map((v) => `\`${v}\``).join(', ')}.` })
      }
      if (removed.length && io === 'output') {
        push({ level: 'additive', rule: 'output-enum-narrowed', op: id, facets, message: `${id}: output field \`${path}\` no longer returns ${removed.map((v) => `\`${v}\``).join(', ')}.` })
      }
    }
    if (!field.deprecated && now.deprecated) {
      push({ level: 'neutral', rule: `${io}-field-deprecated`, op: id, facets, message: `${id}: ${io} field \`${path}\` is deprecated.` })
    }
  }

  for (const [path, field] of to) {
    if (from.has(path)) continue
    if (io === 'input' && field.required) {
      push({
        level: 'breaking',
        rule: 'input-field-added-required',
        op: id,
        facets,
        message: `${id}: new required input field \`${path}\`.`,
        detail: 'Every existing call is missing it. Ship it optional first, then require it.',
      })
    } else {
      push({
        level: 'additive',
        rule: `${io}-field-added`,
        op: id,
        facets,
        message: `${id}: new ${io} field \`${path}\`${io === 'input' ? ' (optional)' : ''}.`,
      })
    }
  }
}

function diffTraits(before: ManifestOp, after: ManifestOp, push: (c: ManifestChange) => void): void {
  const facets = sharedFacets(before, after)
  const id = before.id
  const b = before.traits
  const a = after.traits

  if (b.scope !== a.scope) {
    push({
      level: a.scope ? 'breaking' : 'additive',
      rule: 'trait-scope',
      op: id,
      facets,
      message: a.scope
        ? `${id} now requires the \`${a.scope}\` scope${b.scope ? ` (was \`${b.scope}\`)` : ''}.`
        : `${id} no longer requires the \`${b.scope}\` scope.`,
      ...(a.scope ? { detail: 'Existing credentials without it are rejected, on every facet at once.' } : {}),
    })
  }
  if (b.public && !a.public) {
    push({
      level: 'breaking',
      rule: 'trait-public',
      op: id,
      facets,
      message: `${id} is no longer public.`,
      detail: 'Unauthenticated callers now get 401.',
    })
  } else if (!b.public && a.public) {
    push({ level: 'additive', rule: 'trait-public', op: id, facets, message: `${id} is now public.` })
  }
  // The CLI reads `destructive` as "confirm first", so turning it on is a breaking change for
  // scripts — they block on a prompt, or refuse on a non-TTY — while REST and MCP only gain a hint.
  if (!b.destructive && a.destructive) {
    const cli = facets.filter((f) => f === 'cli')
    push({
      level: cli.length ? 'breaking' : 'neutral',
      rule: 'trait-destructive',
      op: id,
      facets: cli.length ? cli : facets,
      message: `${id} is now destructive.`,
      detail: cli.length ? 'The CLI prompts before running it; unattended scripts need --yes.' : 'MCP gains destructiveHint.',
    })
  } else if (b.destructive && !a.destructive) {
    push({ level: 'neutral', rule: 'trait-destructive', op: id, facets, message: `${id} is no longer destructive.` })
  }
  if (b.paginated !== a.paginated) {
    push({
      level: b.paginated ? 'breaking' : 'additive',
      rule: 'trait-paginated',
      op: id,
      facets,
      message: b.paginated ? `${id} is no longer paginated.` : `${id} is now paginated.`,
      ...(b.paginated ? { detail: 'Callers looping on nextCursor, and `.autoPaginate()`, have nothing to page on.' } : {}),
    })
  }
  for (const trait of ['readonly', 'idempotent'] as const) {
    if (Boolean(b[trait]) !== Boolean(a[trait])) {
      push({
        level: 'neutral',
        rule: `trait-${trait}`,
        op: id,
        facets,
        message: `${id} is ${a[trait] ? 'now' : 'no longer'} ${trait}.`,
        detail: 'Changes MCP hints and retry behaviour; the REST binding change, if any, is reported separately.',
      })
    }
  }

  const removedErrors = before.errors.filter((e) => !after.errors.includes(e))
  const addedErrors = after.errors.filter((e) => !before.errors.includes(e))
  if (addedErrors.length) {
    push({
      level: 'additive',
      rule: 'errors-added',
      op: id,
      facets,
      message: `${id} can now fail with ${addedErrors.join(', ')}.`,
      detail: 'A new member of the SDK error union and a new CLI exit code for this command.',
    })
  }
  if (removedErrors.length) {
    push({ level: 'neutral', rule: 'errors-removed', op: id, facets, message: `${id} no longer declares ${removedErrors.join(', ')}.` })
  }
}

function diffBindings(before: ManifestOp, after: ManifestOp, push: (c: ManifestChange) => void): void {
  const id = before.id

  const br = before.rest
  const ar = after.rest
  if (br && ar) {
    if (br.method !== ar.method || br.path !== ar.path) {
      push({
        level: 'breaking',
        rule: 'rest-route-changed',
        op: id,
        facets: ['rest'],
        message: `${id}: ${ar.method} ${ar.path} — was ${br.method} ${br.path}.`,
        detail: 'The old route 404s. Anything holding a URL — a webhook, a bookmark, a generated SDK — is pointed at nothing.',
      })
    }
    if (br.status !== ar.status) {
      push({
        level: 'breaking',
        rule: 'rest-status-changed',
        op: id,
        facets: ['rest'],
        message: `${id}: success status ${br.status} → ${ar.status}.`,
        detail: 'Clients that match on the exact status, rather than the 2xx class, stop matching.',
      })
    }
  }

  const bm = before.mcp
  const am = after.mcp
  if (bm && am) {
    const bTool = 'tool' in bm ? bm.tool : `group:${bm.group}`
    const aTool = 'tool' in am ? am.tool : `group:${am.group}`
    if (bTool !== aTool) {
      push({
        level: 'breaking',
        rule: 'mcp-tool-renamed',
        op: id,
        facets: ['mcp'],
        message: `${id}: MCP tool ${bTool} → ${aTool}.`,
        detail: 'Agents hold tool names in prompts, traces and evals; a rename reads as a removal plus an unfamiliar tool.',
      })
    } else if ('tool' in bm && 'tool' in am && bm.description !== am.description) {
      push({ level: 'neutral', rule: 'mcp-description-changed', op: id, facets: ['mcp'], message: `${id}: MCP tool description changed.` })
    }
    if ('tool' in bm && 'tool' in am && bm.maxItems !== am.maxItems) {
      push({ level: 'neutral', rule: 'mcp-max-items', op: id, facets: ['mcp'], message: `${id}: MCP result cap ${bm.maxItems ?? 'none'} → ${am.maxItems ?? 'none'}.` })
    }
  }

  const bc = before.cli
  const ac = after.cli
  if (bc && ac) {
    if (bc.command.join(' ') !== ac.command.join(' ')) {
      push({
        level: 'breaking',
        rule: 'cli-command-renamed',
        op: id,
        facets: ['cli'],
        message: `${id}: \`${ac.command.join(' ')}\` — was \`${bc.command.join(' ')}\`.`,
        detail: 'Scripts, aliases and docs naming the old command stop working.',
      })
    }
    if (bc.args.join(' ') !== ac.args.join(' ')) {
      push({
        level: 'breaking',
        rule: 'cli-args-changed',
        op: id,
        facets: ['cli'],
        message: `${id}: positional arguments [${bc.args.join(' ')}] → [${ac.args.join(' ')}].`,
        detail: 'A value that used to be positional is now a flag, or the reverse; either way the old invocation is wrong.',
      })
    }
    const bCols = bc.columns?.join(',')
    const aCols = ac.columns?.join(',')
    if (bCols !== aCols) {
      push({
        level: 'neutral',
        rule: 'cli-columns-changed',
        op: id,
        facets: ['cli'],
        message: `${id}: table columns ${bCols ?? '(default)'} → ${aCols ?? '(default)'}.`,
        detail: 'Presentation only — `--output json` is unchanged.',
      })
    }
  }

  const bw = before.web
  const aw = after.web
  if (bw && aw) {
    if (bw.path !== aw.path) {
      push({
        level: 'breaking',
        rule: 'web-route-changed',
        op: id,
        facets: ['web'],
        message: `${id}: screen ${aw.path} — was ${bw.path}.`,
        detail: 'The old URL 404s. A bookmark, a link in an email, a browser agent holding the route all land on nothing.',
      })
    }
    if (bw.kind !== aw.kind) {
      push({
        level: 'breaking',
        rule: 'web-screen-kind-changed',
        op: id,
        facets: ['web'],
        message: `${id}: screen kind ${bw.kind} → ${aw.kind}.`,
        detail: 'A table that became a form is a different page. The trait behind it (`readonly`, `paginated`) changed too.',
      })
    }
    if (!bw.confirm && aw.confirm) {
      push({
        level: 'breaking',
        rule: 'web-confirm-added',
        op: id,
        facets: ['web'],
        message: `${id}: the screen now asks before it runs.`,
        detail: 'Same reason the CLI starts prompting: the op became `destructive`, and an unattended caller now stops.',
      })
    } else if (bw.confirm && !aw.confirm) {
      push({
        level: 'additive',
        rule: 'web-confirm-removed',
        op: id,
        facets: ['web'],
        message: `${id}: the screen no longer asks before it runs.`,
      })
    }
    if (bw.fields.join(',') !== aw.fields.join(',')) {
      push({
        level: 'neutral',
        rule: 'web-fields-changed',
        op: id,
        facets: ['web'],
        message: `${id}: fields on screen [${bw.fields.join(' ')}] → [${aw.fields.join(' ')}].`,
        detail: 'Presentation only — the schema change behind it, if there was one, is reported on its own.',
      })
    }
    if (bw.title !== aw.title) {
      push({ level: 'neutral', rule: 'web-title-changed', op: id, facets: ['web'], message: `${id}: screen title "${bw.title}" → "${aw.title}".` })
    }
  }

  const bs = before.sdk
  const as_ = after.sdk
  if (bs && as_ && bs.method.join('.') !== as_.method.join('.')) {
    push({
      level: 'breaking',
      rule: 'sdk-method-renamed',
      op: id,
      facets: ['sdk'],
      message: `${id}: SDK method ${bs.method.join('.')}() → ${as_.method.join('.')}().`,
    })
  }
}

function diffTools(before: Manifest, after: Manifest, push: (c: ManifestChange) => void): void {
  if (!before.facets.mcp || !after.facets.mcp) return
  const afterNames = new Set(after.mcpTools.map((t) => t.name))
  const beforeNames = new Set(before.mcpTools.map((t) => t.name))
  for (const tool of before.mcpTools) {
    if (afterNames.has(tool.name)) continue
    // A tool that vanished because its only op did is already reported as op-removed; this is the
    // case where the ops live on under a different tool, which no op-level rule can see.
    if (tool.ops.every((id) => !after.ops.some((o) => o.id === id))) continue
    push({
      level: 'breaking',
      rule: 'mcp-tool-removed',
      facets: ['mcp'],
      message: `MCP tool \`${tool.name}\` is gone; its ops are now reached as ${tool.ops
        .map((id) => {
          const op = after.ops.find((o) => o.id === id)
          return op?.mcp ? ('tool' in op.mcp ? op.mcp.tool : op.mcp.group) : 'nothing'
        })
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(', ')}.`,
    })
  }
  for (const tool of after.mcpTools) {
    if (beforeNames.has(tool.name)) continue
    if (tool.ops.every((id) => !before.ops.some((o) => o.id === id))) continue
    push({ level: 'additive', rule: 'mcp-tool-added', facets: ['mcp'], message: `MCP tool \`${tool.name}\` is new.` })
  }
}

function adapterIndex(adapters: ManifestAdapters[]): Map<string, ManifestAdapters> {
  return new Map(adapters.map((a) => [a.plugin, a]))
}

/** Plugin contributions: a login route or a global flag is as load-bearing as an op's binding. */
function diffAdapters(before: Manifest, after: Manifest, push: (c: ManifestChange) => void): void {
  const now = adapterIndex(after.adapters)
  const was = adapterIndex(before.adapters)
  const plugins = [...new Set([...was.keys(), ...now.keys()])].sort()
  for (const plugin of plugins) {
    const b = was.get(plugin)
    const a = now.get(plugin)
    const label = (s: string) => `${plugin}: ${s}`

    const bRoutes = new Set((b?.rest?.routes ?? []).map((r) => `${r.method} ${r.path}`))
    const aRoutes = new Set((a?.rest?.routes ?? []).map((r) => `${r.method} ${r.path}`))
    for (const route of bRoutes) {
      if (!aRoutes.has(route)) push({ level: 'breaking', rule: 'adapter-route-removed', facets: ['rest'], message: label(`\`${route}\` is gone.`) })
    }
    for (const route of aRoutes) {
      if (!bRoutes.has(route)) push({ level: 'additive', rule: 'adapter-route-added', facets: ['rest'], message: label(`\`${route}\` is new.`) })
    }

    const bSchemes = Object.keys(b?.rest?.securitySchemes ?? {})
    const aSchemes = new Set(Object.keys(a?.rest?.securitySchemes ?? {}))
    for (const scheme of bSchemes) {
      if (!aSchemes.has(scheme)) {
        push({
          level: 'breaking',
          rule: 'adapter-security-scheme-removed',
          facets: ['rest'],
          message: label(`security scheme \`${scheme}\` is gone.`),
          detail: 'Callers authenticating this way have no way in, and generated clients lose the credential slot.',
        })
      }
    }

    const bFlags = new Set((b?.cli?.flags ?? []).map((f) => f.name))
    const aFlags = new Set((a?.cli?.flags ?? []).map((f) => f.name))
    for (const flag of bFlags) {
      if (!aFlags.has(flag)) push({ level: 'breaking', rule: 'adapter-cli-flag-removed', facets: ['cli'], message: label(`global flag \`--${flag}\` is gone.`) })
    }
    for (const flag of aFlags) {
      if (!bFlags.has(flag)) push({ level: 'additive', rule: 'adapter-cli-flag-added', facets: ['cli'], message: label(`global flag \`--${flag}\` is new.`) })
    }

    const bCommands = new Set((b?.cli?.commands ?? []).map((c) => c.command))
    const aCommands = new Set((a?.cli?.commands ?? []).map((c) => c.command))
    for (const command of bCommands) {
      if (!aCommands.has(command)) push({ level: 'breaking', rule: 'adapter-cli-command-removed', facets: ['cli'], message: label(`command \`${command}\` is gone.`) })
    }
    for (const command of aCommands) {
      if (!bCommands.has(command)) push({ level: 'additive', rule: 'adapter-cli-command-added', facets: ['cli'], message: label(`command \`${command}\` is new.`) })
    }

    const bOptions = new Set((b?.sdk?.options ?? []).map((o) => o.name))
    const aOptions = new Set((a?.sdk?.options ?? []).map((o) => o.name))
    for (const option of bOptions) {
      if (!aOptions.has(option)) push({ level: 'breaking', rule: 'adapter-sdk-option-removed', facets: ['sdk'], message: label(`SDK option \`${option}\` is gone.`) })
    }
    for (const option of aOptions) {
      if (!bOptions.has(option)) push({ level: 'additive', rule: 'adapter-sdk-option-added', facets: ['sdk'], message: label(`SDK option \`${option}\` is new.`) })
    }
  }
}

// ---------------------------------------------------------------------------------------------

const LEVEL_ORDER: Record<ChangeLevel, number> = { breaking: 0, additive: 1, neutral: 2 }

export function diffManifests(before: Manifest, after: Manifest): ManifestDiff {
  const changes: ManifestChange[] = []
  const push = (c: ManifestChange) => changes.push(c)

  if (before.facet !== after.facet) {
    push({
      level: 'neutral',
      rule: 'manifest-version',
      facets: [],
      message: `Manifest format ${before.facet} → ${after.facet} (this facet reads v${MANIFEST_VERSION}).`,
      detail: 'Fields the older format did not carry are compared as absent, so some changes may read as additions.',
    })
  }

  diffApp(before, after, push)
  diffOpPresence(before, after, push)

  const afterOps = new Map(after.ops.map((o) => [o.id, o]))
  for (const op of before.ops) {
    const next = afterOps.get(op.id)
    if (!next) continue
    diffProjection(op, next, push)
    diffSchema(op, next, 'input', push)
    diffSchema(op, next, 'output', push)
    diffTraits(op, next, push)
    diffBindings(op, next, push)
    if (op.description !== next.description) {
      push({ level: 'neutral', rule: 'op-description-changed', op: op.id, facets: sharedFacets(op, next), message: `${op.id}: description changed.` })
    }
  }

  diffTools(before, after, push)
  diffAdapters(before, after, push)

  changes.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.op ?? '').localeCompare(b.op ?? '') || a.rule.localeCompare(b.rule))

  const breaking = new Set<FacetKey>()
  for (const c of changes) if (c.level === 'breaking') for (const f of c.facets) breaking.add(f)
  const live = FACET_KEYS.filter((f) => before.facets[f] || after.facets[f])
  const counts = { breaking: 0, additive: 0, neutral: 0 }
  for (const c of changes) counts[c.level]++

  return {
    before: { name: before.name, version: before.version },
    after: { name: after.name, version: after.version },
    changes,
    breakingFacets: live.filter((f) => breaking.has(f)),
    compatibleFacets: live.filter((f) => !breaking.has(f)),
    counts,
    suggestedBump: counts.breaking ? 'minor' : counts.additive ? 'patch' : 'patch',
  }
}

// ---------------------------------------------------------------------------------------------
// Report

const list = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/** The one sentence the epic asks for: which facets this breaks, and which it leaves alone. */
export function verdict(diff: ManifestDiff): string {
  if (!diff.changes.length) return 'No change: every facet is identical.'
  if (!diff.breakingFacets.length) {
    return diff.counts.additive
      ? `Compatible on every facet: ${diff.counts.additive} addition(s), nothing removed or reshaped.`
      : 'Compatible on every facet: nothing a caller can observe changed.'
  }
  const unaffected = diff.compatibleFacets.length ? `, not ${list([...diff.compatibleFacets])}` : ''
  return `Breaks ${list([...diff.breakingFacets])}${unaffected}.`
}

export type FormatDiffOptions = {
  /** Drop `neutral` changes, which are the bulk of a normal release. */
  quiet?: boolean
}

export function formatDiff(diff: ManifestDiff, options: FormatDiffOptions = {}): string {
  const shown = options.quiet ? diff.changes.filter((c) => c.level !== 'neutral') : diff.changes
  const width = Math.max(0, ...shown.map((c) => c.facets.join(' ').length))
  const lines: string[] = [
    `${diff.before.name} ${diff.before.version} → ${diff.after.name} ${diff.after.version}`,
    '',
  ]
  for (const level of ['breaking', 'additive', 'neutral'] as const) {
    const group = shown.filter((c) => c.level === level)
    if (!group.length) continue
    lines.push(`${level.toUpperCase()} (${group.length})`)
    for (const c of group) {
      lines.push(`  ${c.facets.join(' ').padEnd(width)}  ${c.message}  [${c.rule}]`)
      if (c.detail) lines.push(`  ${''.padEnd(width)}  ${c.detail}`)
    }
    lines.push('')
  }
  if (options.quiet && diff.counts.neutral) lines.push(`(${diff.counts.neutral} neutral change(s) hidden)`, '')
  lines.push(verdict(diff))
  if (diff.counts.breaking) {
    lines.push(`Suggested version bump: ${diff.suggestedBump} — pre-1.0, minor is the breaking bump (docs/RELEASING.md).`)
  }
  return lines.join('\n') + '\n'
}
