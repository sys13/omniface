/**
 * Runs every study subject through the same three checks — does it load, does it lint, does it
 * build every facet — and prints one table. This is what makes the study a result rather than an
 * argument: each verdict in docs/EXPRESSIBILITY.md is a line of output here.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SUBJECTS = ['linear', 'stripe', 'github', 's3', 'docker', 'kubernetes']
const facetBin = fileURLToPath(new URL('./node_modules/.bin/omniface', import.meta.url))

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(facetBin, args, { cwd: fileURLToPath(new URL('.', import.meta.url)) })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })
}

const rows = []
let failed = 0

for (const subject of SUBJECTS) {
  const lint = await run(['lint', `src/${subject}.ts`])
  const build = await run(['build', `src/${subject}.ts`, '--out', `.out/${subject}`])
  if (build.code !== 0) failed++

  let ops = 0
  let overrides = 0
  let tools = 0
  try {
    const manifest = JSON.parse(await readFile(new URL(`./.out/${subject}/manifest.json`, import.meta.url), 'utf8'))
    ops = manifest.ops.length
    tools = (manifest.facets.mcp?.tools ?? []).length
  } catch {}

  const src = await readFile(new URL(`./src/${subject}.ts`, import.meta.url), 'utf8')
  const facetsBlock = src.slice(src.indexOf('facets: {'))
  overrides = [...facetsBlock.matchAll(/^\s+'[\w.]+':\s*\{/gm)].length

  const findings = /(\d+) finding/.exec(lint.out)?.[1] ?? '0'
  rows.push({ subject, ops, overrides, mcpTools: tools, lintFindings: Number(findings), builds: build.code === 0 ? 'yes' : 'NO' })
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`${pad('subject', 12)}${pad('ops', 6)}${pad('overrides', 11)}${pad('mcp tools', 11)}${pad('lint', 6)}builds`)
console.log('-'.repeat(52))
for (const r of rows) {
  console.log(`${pad(r.subject, 12)}${pad(r.ops, 6)}${pad(r.overrides, 11)}${pad(r.mcpTools, 11)}${pad(r.lintFindings, 6)}${r.builds}`)
}

process.exit(failed === 0 ? 0 : 1)
