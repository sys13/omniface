import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, facet, lint } from 'omniface'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import app from '../src/app.ts'

describe('omniface lint', () => {
  it('is clean for the example app', () => {
    expect(lint(app)).toEqual([])
  })

  it('warns past the MCP tool budget and suggests namespace groups', () => {
    const f = facet()
    const ops = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`op${i}`, f.op({ description: `Op ${i}`, output: z.object({}) }).handle(() => ({}))]),
    )
    const findings = lint(f.app({ name: 'big', ops: { things: ops } }))
    expect(findings).toEqual([expect.objectContaining({ rule: 'mcp-tool-budget', level: 'warn' })])
    expect(findings[0]!.message).toContain('mcp.tools.manage_things')
  })

  it('errors on a paginated op without the page shape, and on CLI without REST', () => {
    const f = facet()
    const findings = lint(
      f.app({
        name: 'x',
        ops: { list: f.op({ description: 'List', output: z.object({ rows: z.array(z.string()) }) }).traits({ readonly: true, paginated: true }).handle(() => ({ rows: [] })) },
        facets: { cli: true },
      }),
    )
    expect(findings.map((f) => f.rule).sort()).toEqual(['http-facets-need-rest', 'paginated-shape'])
  })
})

describe('omniface build', () => {
  it('writes the manifest, OpenAPI, llms.txt and a runnable CLI package', async () => {
    const out = mkdtempSync(join(tmpdir(), 'facet-build-'))
    await build(app, out)
    const pkg = JSON.parse(readFileSync(join(out, 'cli/package.json'), 'utf8'))
    expect(pkg.bin).toEqual({ tasks: './bin.mjs' })
    // The generated package asks for the engine that generated it, not a version frozen in source.
    const facetPkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.resolve('omniface'))), 'utf8'))
    expect(pkg.dependencies).toEqual({ '@omniface/cli': `^${facetPkg.version}` })
    expect(statSync(join(out, 'cli/bin.mjs')).mode & 0o111).not.toBe(0)
    expect(JSON.parse(readFileSync(join(out, 'openapi.json'), 'utf8')).paths['/tasks/{id}/complete'].post.operationId).toBe('tasks.complete')
    const llms = readFileSync(join(out, 'llms.txt'), 'utf8')
    expect(llms).toContain('### tasks.create')
    expect(llms).toContain('MCP tool: `tasks_create`')
  })

  it('the installed facet bin builds and inspects from the command line', () => {
    // Inside the workspace, so the generated bin resolves @omniface/cli the way an installed package would.
    const out = join(import.meta.dirname, '../.omniface/test-build')
    rmSync(out, { recursive: true, force: true })
    // The bin the `facet` package installs, not the TypeScript source next to it.
    const devcli = fileURLToPath(new URL('devcli.js', import.meta.resolve('omniface')))
    const entry = join(import.meta.dirname, '../src/app.ts')
    expect(execFileSync('node', [devcli, '--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+/)
    execFileSync('node', [devcli, 'build', entry, '--out', out])
    const help = execFileSync('node', [join(out, 'cli/bin.mjs'), '--help'], { encoding: 'utf8' })
    expect(help).toContain('tasks create <title>')
    const inspected = JSON.parse(execFileSync('node', [devcli, 'inspect', entry, 'tasks.delete', '--json'], { encoding: 'utf8' }))
    expect(inspected.cli.snippet).toBe('tasks tasks delete task_1 --yes')
    rmSync(out, { recursive: true, force: true })
  })
})

describe('omniface diff', () => {
  // The mirror of the conformance "done when": a deliberate change is reported against the facets
  // it actually breaks, through the installed bin, and --strict turns that into an exit code.
  it('names the facets a change breaks and leaves the others alone', () => {
    const devcli = fileURLToPath(new URL('devcli.js', import.meta.resolve('omniface')))
    const entry = join(import.meta.dirname, '../src/app.ts')
    const out = mkdtempSync(join(tmpdir(), 'facet-diff-'))
    execFileSync('node', [devcli, 'build', entry, '--out', out])

    const published = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    for (const op of published.ops) {
      // Three changes the working tree "makes", each landing on one facet: the CLI command was
      // renamed, delete was not destructive, and list's REST route has moved.
      if (op.id === 'tasks.get') op.cli.command = ['tasks', 'show']
      if (op.id === 'tasks.delete') delete op.traits.destructive
      if (op.id === 'tasks.list') op.rest.path = '/v0/tasks'
    }
    const baseline = join(out, 'published.json')
    writeFileSync(baseline, JSON.stringify(published))

    let status = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', [devcli, 'diff', baseline, entry, '--strict'], { encoding: 'utf8' })
    } catch (err) {
      const e = err as { status: number; stdout: string }
      status = e.status
      stdout = e.stdout
    }
    expect(status).toBe(1)
    expect(stdout).toContain('Breaks rest and cli, not mcp, sdk and web.')
    expect(stdout).toContain('[cli-command-renamed]')
    expect(stdout).toContain('[trait-destructive]')
    expect(stdout).toContain('[rest-route-changed]')
    // The SDK and MCP views of all three ops are untouched, so neither is accused of anything.
    expect(stdout).not.toContain('sdk-method-renamed')
    expect(stdout).toContain('Suggested version bump: minor')
    rmSync(out, { recursive: true, force: true })
  })

  it('is silent when the working tree matches what was published', () => {
    const devcli = fileURLToPath(new URL('devcli.js', import.meta.resolve('omniface')))
    const entry = join(import.meta.dirname, '../src/app.ts')
    const stdout = execFileSync('node', [devcli, 'diff', entry, entry, '--strict'], { encoding: 'utf8' })
    expect(stdout).toContain('No change: every facet is identical.')
  })
})
