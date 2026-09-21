#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { App } from './app.ts'
import { build } from './build.ts'
import { runConformanceFor } from './conformance-run.ts'
import { runDiff } from './diff-run.ts'
import { formatDiff } from './diff.ts'
import { runMcpStdio } from './facets/mcp.ts'
import { facetModules } from './facet.ts'
import { inspectAll, inspectOp } from './inspect.ts'
import { applyNamedTypeFixes } from './fix.ts'
import { lint, type LintFinding } from './lint.ts'
import { captureDefinitionSites } from './op.ts'
import { buildManifest } from './manifest.ts'
import { serve } from './server.ts'

const USAGE = `facet — one definition, every interface

Usage:
  omniface dev <entry> [--port 3000]     Serve REST, MCP (/mcp) and the inspector (/_omniface)
  omniface mcp <entry>                   Serve MCP over stdio (key from <APP>_API_KEY)
  omniface inspect <entry> [op] [--json] Show an op on every facet
  omniface build <entry> [--out .omniface]  Write manifest, OpenAPI, llms.txt, the SDK and CLI packages
  omniface lint <entry> [--fix]          Check the definition, optionally inserting t.named()
  omniface conformance <entry> [--strict] Prove every facet still agrees
  omniface diff <before> <after> [--strict]  What changed, and which facets it breaks
  facet --version                     Print the facet version

<entry> is a module whose default export is a facet app.
<before>/<after> are either such a module or a manifest.json from \`omniface build\`.
`

const { version: VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

async function loadApp(entry: string | undefined): Promise<App> {
  if (!entry) throw new Error('Missing <entry>.\n\n' + USAGE)
  const mod = (await import(pathToFileURL(resolve(entry)).href)) as { default?: App }
  if (mod.default?.kind !== 'omniface.app') throw new Error(`${entry} does not default-export a facet app`)
  return mod.default
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

const run = promisify(execFile)

/**
 * `omniface lint --json` in a child process. `--fix` uses it to check its own edits: the files it
 * rewrote are modules this process already imported, so re-linting in place would read the ESM
 * cache and prove nothing.
 */
async function relint(entry: string): Promise<LintFinding[]> {
  const self = process.argv[1] ?? fileURLToPath(import.meta.url)
  const { stdout } = await run(process.execPath, [self, 'lint', entry, '--json'], { encoding: 'utf8' }).catch(
    (err: { stdout?: string; stderr?: string; message: string }) => {
      // A non-zero exit is an `error`-level finding, which is data; no stdout is a real failure.
      if (err.stdout?.trim().startsWith('[')) return { stdout: err.stdout }
      throw new Error(err.stderr?.trim() || err.message)
    },
  )
  return JSON.parse(stdout) as LintFinding[]
}

async function main(argv: string[]): Promise<number> {
  const [command, entry, ...rest] = argv
  switch (command) {
    case '--version':
    case '-v':
    case 'version': {
      process.stdout.write(`${VERSION}\n`)
      return 0
    }
    case 'dev': {
      const app = await loadApp(entry)
      const port = Number(flag(rest, 'port') ?? process.env.PORT ?? 3000)
      serve(app, { port, inspector: true })
      const base = `http://localhost:${port}`
      const m = buildManifest(app)
      process.stderr.write(
        [
          `omniface dev: ${app.name} v${app.version} on ${base}`,
          // One line per facet the app has, from what that facet says about itself. Nothing here
          // knows which facets exist, so a facet added as a module shows up in the banner too.
          ...facetModules()
            .filter((mod) => m.facets[mod.name] != null)
            .map((mod) => `  ${mod.name.padEnd(10)} ${mod.summary?.(m.facets[mod.name]) ?? `${m.ops.filter((o) => o.facets[mod.name] != null).length} op(s)`}`),
          `  ${'inspector'.padEnd(10)} ${base}/_omniface`,
          '',
        ]
          .filter((l) => l !== '')
          .join('\n') + '\n',
      )
      await new Promise(() => {})
      return 0
    }
    case 'mcp': {
      await runMcpStdio(await loadApp(entry))
      await new Promise(() => {})
      return 0
    }
    case 'inspect': {
      const app = await loadApp(entry)
      const json = rest.includes('--json')
      const opId = rest.find((a) => !a.startsWith('--'))
      if (!opId) {
        const all = inspectAll(app)
        if (json) process.stdout.write(JSON.stringify(all, null, 2) + '\n')
        else {
          const on = Object.keys(all.facets)
          process.stdout.write(`${all.name} v${all.version} · plugins: ${all.plugins.join(', ') || 'none'} · facets: ${on.join(', ') || 'none'}\n\n`)
          // One column per facet the app has, filled from what that facet said about the op.
          const cell = (op: (typeof all.ops)[number], facet: string) => op.facets[facet]?.short ?? '—'
          for (const op of all.ops) {
            process.stdout.write(`${op.id.padEnd(20)} ${on.map((f) => cell(op, f).padEnd(28)).join(' ').trimEnd()}\n`)
          }
        }
        return 0
      }
      const op = inspectOp(app, opId)
      if (json) {
        process.stdout.write(JSON.stringify(op, null, 2) + '\n')
        return 0
      }
      const section = (title: string, body: string | null) => `\n${title}\n${body ?? '  (not exposed)'}\n`
      const indent = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n')
      process.stdout.write(
        `${op.id}${op.description ? ` — ${op.description}` : ''}\n` +
          `traits: ${JSON.stringify(op.traits)}  source: ${op.source}\n` +
          // A section per facet the app has, in registry order, from what that facet presented.
          Object.entries(op.facets)
            .map(([, shown]) => section((shown?.label ?? '').toUpperCase(), shown?.snippet ? indent(shown.snippet) : null))
            .join('') +
          section(
            'Pipeline',
            indent(
              (op.pipeline.wraps.length ? `wrapped by: ${op.pipeline.wraps.join(', ')}\n` : '') +
                op.pipeline.stages.map((s) => `${s.stage.padEnd(14)}${s.plugins.join(', ') || '—'}`).join('\n'),
            ),
          ),
      )
      return 0
    }
    case 'build': {
      const app = await loadApp(entry)
      const result = await build(app, flag(rest, 'out') ?? '.omniface')
      process.stdout.write(`Wrote:\n${result.files.map((f) => `  ${f}`).join('\n')}\n`)
      return 0
    }
    case 'conformance': {
      const app = await loadApp(entry)
      const result = await runConformanceFor(entry!, app, {
        fixtures: flag(rest, 'fixtures'),
        only: rest.filter((a, i) => rest[i - 1] === '--op'),
      })
      if (rest.includes('--json')) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        return result.failures.length ? 1 : 0
      }
      for (const f of result.failures) {
        process.stdout.write(`FAIL ${f.name}\n${f.problems.map((p) => `       ${p}`).join('\n')}\n`)
      }
      const passed = result.total - result.failures.length
      process.stdout.write(`\n${passed}/${result.total} cases passed`)
      process.stdout.write(result.mode === 'contract' ? ' (contract only)\n' : `  ·  fixtures: ${result.fixtures}\n`)
      if (result.mode === 'contract') {
        process.stdout.write(
          `\nOnly the checks that read the manifest ran. The rest have to call the app, which needs a\n` +
            `credential and, for writes, a valid input. Put them in conformance.fixtures.ts beside ${entry}:\n\n` +
            `  export default {\n` +
            `    app: () => createApp(),\n` +
            `    apiKey: '…',\n` +
            `    ops: { 'tasks.create': { input: { title: 'Conformance' } } },\n` +
            `  }\n`,
        )
      } else if (result.coverage?.needInput.length) {
        const { needInput, generated, possible } = result.coverage
        process.stdout.write(
          `\n${generated} of ${possible} possible cases. An input for these ops would generate the rest:\n` +
            needInput.map((id) => `  ops['${id}'].input`).join('\n') +
            '\n',
        )
      }
      const short = rest.includes('--strict') && result.coverage?.needInput.length
      return result.failures.length || short ? 1 : 0
    }
    case 'diff': {
      const after = rest.find((a) => !a.startsWith('--'))
      if (!entry || !after) throw new Error('omniface diff needs two sides: <before> <after>.\n\n' + USAGE)
      const result = await runDiff(entry, after)
      if (rest.includes('--json')) {
        const { sources, ...diff } = result
        process.stdout.write(JSON.stringify(diff, null, 2) + '\n')
      } else {
        process.stdout.write(formatDiff(result, { quiet: rest.includes('--quiet') }))
      }
      // Breaking changes are a release decision, not an error, so they only fail the build when
      // the caller says they should — the same bargain `conformance --strict` makes about coverage.
      return rest.includes('--strict') && result.counts.breaking ? 1 : 0
    }
    case 'lint': {
      const fix = rest.includes('--fix')
      // Before the import, because the sites are captured as each `op({...})` call runs.
      if (fix) captureDefinitionSites(true)
      const app = await loadApp(entry)
      let findings = lint(app, undefined, { unusedTraits: true })

      if (fix) {
        const result = await applyNamedTypeFixes(app, findings, {
          read: (file) => readFile(file, 'utf8'),
          write: (file, text) => writeFile(file, text),
          // A fresh process, because the edited file is a module this one has already imported and
          // the ESM cache would hand back the version the fix was meant to replace.
          verify: () => relint(entry!),
        })
        for (const f of result.fixed) process.stdout.write(`fixed [${f.rule}] ${f.target} → t.named('${f.name}', …)  ${f.file}\n`)
        for (const u of result.unfixable) process.stdout.write(`kept  [${u.finding.rule}] ${u.reason}\n`)
        if (result.rolledBack) {
          process.stderr.write(`\nfacet lint --fix changed nothing: ${result.rolledBack}\n`)
          return 1
        }
        if (result.fixed.length) {
          findings = await relint(entry!)
          process.stdout.write(`\n${result.fixed.length} fix(es) applied and checked.\n`)
        }
      }

      if (rest.includes('--json')) {
        process.stdout.write(JSON.stringify(findings, null, 2) + '\n')
        return findings.some((f) => f.level === 'error') ? 1 : 0
      }
      for (const f of findings) process.stdout.write(`${f.level === 'error' ? 'error' : 'warn '} [${f.rule}] ${f.message}\n`)
      process.stdout.write(findings.length ? `\n${findings.length} finding(s)\n` : 'No findings.\n')
      return findings.some((f) => f.level === 'error') ? 1 : 0
    }
    default:
      process.stdout.write(USAGE)
      return command === undefined || command === '--help' || command === 'help' ? 0 : 2
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err: Error) => {
    process.stderr.write(`facet: ${err.message}\n`)
    process.exitCode = 1
  },
)
