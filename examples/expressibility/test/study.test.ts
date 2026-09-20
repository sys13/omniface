import { describe, expect, it } from 'vitest'
import { buildManifest, lint, type App } from 'omniface'
import { createGithubApp } from '../src/github.ts'
import { createDockerApp } from '../src/docker.ts'
import { createKubernetesApp } from '../src/kubernetes.ts'
import { createStorageApp } from '../src/s3.ts'
import { createStripeApp } from '../src/stripe.ts'
import { createTrackerApp } from '../src/linear.ts'

/**
 * The study's claims, as assertions. docs/EXPRESSIBILITY.md reads these numbers off a table; this
 * keeps the table from going stale, and makes a regression in the convention layer visible as a
 * subject that suddenly needs more overrides than it did.
 */

const SUBJECTS: { name: string; app: () => App; maxFindings: number }[] = [
  { name: 'linear', app: createTrackerApp, maxFindings: 0 },
  { name: 'stripe', app: createStripeApp, maxFindings: 0 },
  { name: 'github', app: createGithubApp, maxFindings: 1 },
  { name: 's3', app: createStorageApp, maxFindings: 0 },
  { name: 'docker', app: createDockerApp, maxFindings: 1 },
  { name: 'kubernetes', app: createKubernetesApp, maxFindings: 0 },
]

describe.each(SUBJECTS)('$name', ({ app, maxFindings }) => {
  it('builds a manifest with every op projected to at least one facet', () => {
    const manifest = buildManifest(app())
    expect(manifest.ops.length).toBeGreaterThan(0)
    for (const op of manifest.ops) {
      expect(op.rest ?? op.sdk ?? op.cli ?? op.mcp, `${op.id} reaches no facet`).toBeTruthy()
    }
  })

  it('lints within its budget', () => {
    const instance = app()
    expect(lint(instance, buildManifest(instance)).length).toBeLessThanOrEqual(maxFindings)
  })
})

describe('the control subject', () => {
  it('needs no per-op override on any facet', () => {
    const { facets } = createTrackerApp()
    expect(facets.rest?.ops ?? {}).toEqual({})
    expect(facets.cli?.ops ?? {}).toEqual({})
    expect(facets.mcp?.ops ?? {}).toEqual({})
  })
})

describe('generated ops (kubernetes)', () => {
  it('projects every generated resource onto every facet', () => {
    const manifest = buildManifest(createKubernetesApp())
    for (const kind of ['deployments', 'services', 'configMaps']) {
      for (const verb of ['get', 'list', 'apply', 'delete', 'changesSince']) {
        const op = manifest.ops.find((o) => o.id === `${kind}.${verb}`)
        expect(op, `${kind}.${verb} is missing`).toBeTruthy()
        expect(op!.rest).toBeTruthy()
        expect(op!.cli).toBeTruthy()
      }
    }
  })

  it('keeps the MCP surface inside the tool budget by grouping', () => {
    const manifest = buildManifest(createKubernetesApp())
    // Fifteen resource ops collapse into three grouped tools; without the groups this app would
    // sit exactly on MCP_TOOL_BUDGET and a fourth CRD would break it.
    expect(manifest.mcpTools.length).toBeLessThan(15)
    expect(manifest.mcpTools.map((tool) => tool.name)).toContain('deployments_admin')
  })
})

describe('composite identity (github)', () => {
  it('needs an explicit path for every op whose identity is a tuple', () => {
    const manifest = buildManifest(createGithubApp())
    const issueGet = manifest.ops.find((op) => op.id === 'repos.issues.get')!
    expect(issueGet.rest!.path).toBe('/repos/{owner}/{repo}/issues/{number}')
    expect(issueGet.rest!.pathParams).toEqual(['owner', 'repo', 'number'])
  })
})
