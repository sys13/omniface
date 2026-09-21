import { Hono } from 'hono'
import type { McpConfig } from '../app.ts'
import { defineFacet, registerFacet, projectionOf, settingsOf, type FacetChange } from '../facet.ts'
import { objectProperties, type JSONSchema } from '../jsonschema.ts'
import { isUntrusted, UNTRUSTED_NOTE, type Manifest, type ManifestOp, type ManifestTool } from '../manifest.ts'
import { conventionalToolName } from '../naming.ts'
import type { OpTraits } from '../traits.ts'
import { createMcpHttpHandler } from './mcp.ts'

/**
 * What the MCP facet does with one op: the tool it becomes, or the group it is an action of.
 * Two shapes rather than one because a grouped op has no tool of its own — the group does.
 */
export type McpProjection = { tool: string; description: string; maxItems?: number } | { group: string }

export type McpSettings = { tools: ManifestTool[] }

export const mcpOf = (op: ManifestOp): McpProjection | null => projectionOf<McpProjection>(op, 'mcp')
export const mcpSettings = (manifest: Manifest): McpSettings | null => settingsOf<McpSettings>(manifest, 'mcp')

/** Every MCP tool the app advertises. Empty when the facet is off. */
export const mcpTools = (manifest: Manifest): ManifestTool[] => mcpSettings(manifest)?.tools ?? []

function asObjectSchema(schema: JSONSchema): JSONSchema {
  return schema.type === 'object' ? schema : { type: 'object', properties: {} }
}

function toolAnnotations(traits: OpTraits, untrusted: boolean): ManifestTool['annotations'] {
  return {
    readOnlyHint: Boolean(traits.readonly),
    destructiveHint: Boolean(traits.destructive),
    idempotentHint: Boolean(traits.idempotent || traits.readonly),
    openWorldHint: false,
    ...(untrusted ? { untrustedContentHint: true } : {}),
  }
}

const toolName = (projection: McpProjection): string => ('tool' in projection ? projection.tool : `group:${projection.group}`)

export const mcpFacet = defineFacet<McpConfig, McpProjection, McpSettings>({
  name: 'mcp',
  order: 1,
  defaultOn: true,
  normalize: (value) => (value === undefined || value === false ? null : value === true ? {} : (value as McpConfig)),
  references: (config) => [
    { where: 'mcp.ops', ids: Object.keys(config.ops ?? {}) },
    ...Object.entries(config.tools ?? {}).map(([tool, group]) => ({ where: `mcp.tools.${tool}`, ids: group.ops })),
  ],

  project({ op, output }, config) {
    for (const [tool, group] of Object.entries(config.tools ?? {})) {
      if (group.ops.includes(op.id)) return { group: tool }
    }
    const override = config.ops?.[op.id]
    if (override === false) return null
    const described = override?.description ?? op.op.description ?? op.id
    // MCP has no `untrustedContentHint`, and an agent reads the description, so that is where the
    // warning goes on this facet. WebMCP gets the annotation as well.
    const description = isUntrusted(op.op.traits, output) ? `${described}\n\n${UNTRUSTED_NOTE}` : described
    return {
      tool: override?.name ?? conventionalToolName(op.path),
      description,
      ...(override?.maxItems ? { maxItems: override.maxItems } : {}),
    }
  },

  settings(_app, config, ops): McpSettings {
    const tools: ManifestTool[] = []
    for (const op of ops) {
      const projection = mcpOf(op)
      if (!projection || !('tool' in projection)) continue
      tools.push({
        name: projection.tool,
        description: projection.description,
        inputSchema: asObjectSchema(op.input),
        ...(op.output.type === 'object' ? { outputSchema: op.output } : {}),
        annotations: toolAnnotations(op.traits, isUntrusted(op.traits, op.output)),
        ops: [op.id],
      })
    }
    for (const [name, group] of Object.entries(config.tools ?? {})) {
      const members = group.ops.map((id) => ops.find((o) => o.id === id)).filter((o): o is ManifestOp => Boolean(o))
      const actions = members.map((o) => o.path[o.path.length - 1]!)
      const lines = members.map(
        (o, i) => `- ${actions[i]}: ${o.description ?? o.id}. Input: ${JSON.stringify(o.input.properties ?? {})}`,
      )
      tools.push({
        name,
        description: `${group.description}\n\nActions:\n${lines.join('\n')}`,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: actions, description: 'Which action to perform' },
            input: { type: 'object', description: 'Input for the chosen action (see Actions)' },
          },
          required: ['action'],
        },
        annotations: {
          readOnlyHint: members.every((o) => o.traits.readonly),
          destructiveHint: members.some((o) => o.traits.destructive),
          idempotentHint: members.every((o) => o.traits.idempotent || o.traits.readonly),
          openWorldHint: false,
          ...(members.some((o) => isUntrusted(o.traits, o.output)) ? { untrustedContentHint: true } : {}),
        },
        ops: members.map((o) => o.id),
      })
    }
    return { tools }
  },

  diff(before, after, { op }): FacetChange[] {
    const changes: FacetChange[] = []
    if (toolName(before) !== toolName(after)) {
      changes.push({
        level: 'breaking',
        rule: 'mcp-tool-renamed',
        message: `${op}: MCP tool ${toolName(before)} → ${toolName(after)}.`,
        detail: 'Agents hold tool names in prompts, traces and evals; a rename reads as a removal plus an unfamiliar tool.',
      })
    } else if ('tool' in before && 'tool' in after && before.description !== after.description) {
      changes.push({ level: 'neutral', rule: 'mcp-description-changed', message: `${op}: MCP tool description changed.` })
    }
    if ('tool' in before && 'tool' in after && before.maxItems !== after.maxItems) {
      changes.push({
        level: 'neutral',
        rule: 'mcp-max-items',
        message: `${op}: MCP result cap ${before.maxItems ?? 'none'} → ${after.maxItems ?? 'none'}.`,
      })
    }
    return changes
  },

  diffSettings(before, after): FacetChange[] {
    const changes: FacetChange[] = []
    const afterNames = new Set(after.tools.map((t) => t.name))
    const beforeNames = new Set(before.tools.map((t) => t.name))
    const afterOps = new Set(after.tools.flatMap((t) => t.ops))
    const beforeOps = new Set(before.tools.flatMap((t) => t.ops))
    for (const tool of before.tools) {
      if (afterNames.has(tool.name)) continue
      // A tool that vanished because its only op did is already reported as op-removed; this is
      // the case where the ops live on under a different tool, which no op-level rule can see.
      if (tool.ops.every((id) => !afterOps.has(id))) continue
      const now = tool.ops
        .map((id) => after.tools.find((t) => t.ops.includes(id))?.name ?? 'nothing')
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(', ')
      changes.push({
        level: 'breaking',
        rule: 'mcp-tool-removed',
        message: `MCP tool \`${tool.name}\` is gone; its ops are now reached as ${now}.`,
      })
    }
    for (const tool of after.tools) {
      if (beforeNames.has(tool.name)) continue
      if (tool.ops.every((id) => !beforeOps.has(id))) continue
      changes.push({ level: 'additive', rule: 'mcp-tool-added', message: `MCP tool \`${tool.name}\` is new.` })
    }
    return changes
  },

  present({ manifest, op }, projection) {
    const group = 'group' in projection ? projection.group : undefined
    const tool = mcpTools(manifest).find((t) => (group ? t.name === group : t.ops.length === 1 && t.ops[0] === op.id))
    if (!tool) return null
    return {
      label: 'MCP',
      short: tool.name,
      snippet: JSON.stringify(tool, null, 2),
      line: `- MCP tool: \`${tool.name}\``,
      detail: { tool, ...(group ? { group } : {}) },
    }
  },

  summary: () => 'an MCP server (/mcp)',

  contract({ app, manifest, op, others }, projection) {
    const problems: string[] = []
    const config = app.facets['mcp'] as McpConfig | null
    if (!projection) {
      if (config?.ops?.[op.id] !== false) problems.push('no MCP binding')
      return problems
    }
    const tool = 'tool' in projection ? mcpTools(manifest).find((t) => t.name === projection.tool) : undefined
    if (tool) {
      const props = Object.keys(objectProperties(op.input))
      const toolProps = Object.keys(objectProperties(tool.inputSchema))
      const missing = props.filter((p) => !toolProps.includes(p))
      const extra = toolProps.filter((p) => !props.includes(p))
      if (missing.length) problems.push(`MCP tool is missing input fields: ${missing.join(', ')}`)
      if (extra.length) problems.push(`MCP tool advertises unknown input fields: ${extra.join(', ')}`)
    }
    if ('tool' in projection) {
      for (const other of others) {
        const theirs = mcpOf(other)
        if (theirs && 'tool' in theirs && theirs.tool === projection.tool) {
          problems.push(`MCP tool "${projection.tool}" collides with ${other.id}`)
        }
      }
    }
    return problems
  },

  serve: {
    mountOrder: 0,
    create(app, manifest) {
      const handler = createMcpHttpHandler(app, manifest)
      const hono = new Hono()
      hono.all('/mcp', (c) => handler(c.req.raw))
      return hono
    },
  },
})

// Registered here rather than in a list elsewhere: a facet module that is imported is a facet the
// app has. It also keeps the import cycle with this facet's server module harmless.
registerFacet(mcpFacet)
