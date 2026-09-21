import type { App } from './app.ts'
import { facetModules, type FacetPresentation } from './facet.ts'
import { exampleValue, type JSONSchema } from './jsonschema.ts'
import { buildManifest, type Manifest } from './manifest.ts'
import { STAGES } from './plugin.ts'
import type { OpTraits } from './traits.ts'

import './facets/builtin.ts'

export type OpInspection = {
  id: string
  description?: string
  source: string
  traits: OpTraits
  errors: string[]
  input: JSONSchema
  output: JSONSchema
  exampleInput: Record<string, unknown>
  /**
   * What each facet shows for this op, keyed by facet name — a heading, a snippet you can run,
   * the line `llms.txt` carries, and whatever else the facet wants to hand over as data. `null`
   * means the facet is on and does not reach this op.
   *
   * The inspector and `omniface inspect` render this record rather than a list of facets they
   * know, which is what makes a facet visible in both by landing once.
   */
  facets: Record<string, FacetPresentation | null>
  pipeline: { wraps: string[]; stages: { stage: string; plugins: string[] }[] }
}

export function inspectOp(app: App, id: string, manifest: Manifest = buildManifest(app)): OpInspection {
  const op = manifest.ops.find((o) => o.id === id)
  if (!op) throw new Error(`omniface inspect: unknown op "${id}". Known: ${manifest.ops.map((o) => o.id).join(', ')}`)
  const example = (exampleValue(op.input) ?? {}) as Record<string, unknown>

  const facets: Record<string, FacetPresentation | null> = {}
  for (const module of facetModules()) {
    const projection = op.facets[module.name]
    if (projection == null) {
      if (module.name in op.facets) facets[module.name] = null
      continue
    }
    facets[module.name] = module.present?.({ manifest, op, example }, projection) ?? null
  }

  return {
    id,
    ...(op.description ? { description: op.description } : {}),
    source: op.source,
    traits: op.traits,
    errors: op.errors,
    input: op.input,
    output: op.output,
    exampleInput: example,
    facets,
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
    ops: manifest.ops.map((o) => inspectOp(app, o.id, manifest)),
  }
}
