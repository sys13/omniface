#!/usr/bin/env node
// The quickstart, from a fresh directory with no clone: pack the packages, install them into an
// empty project the way npm would, and drive a real app through every facet.
//
// Usage: node scripts/smoke-install.mjs [--keep] [--runtime node|bun]

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pack } from './pack.mjs'

const keep = process.argv.includes('--keep')
const runtime = process.argv[process.argv.indexOf('--runtime') + 1] ?? 'node'
const isBun = runtime === 'bun'
const PORT = 3000 + Math.floor(Math.random() * 1000)

const APP = `import { errors, facet } from 'omniface'
import { logging } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'

const f = facet({ plugins: [logging({ sink: () => {} })] })

const Task = t.named('Task', z.object({ id: t.id({ example: 'task_1' }), title: z.string().min(1), done: z.boolean() }))
const TaskId = t.named('TaskId', z.object({ id: t.id({ example: 'task_1' }) }))
const tasks = new Map()
let seq = 0

export default f.app({
  name: 'smoke',
  version: '1.2.3',
  description: 'The quickstart app, installed from npm tarballs',
  ops: {
    tasks: {
      create: f
        .op({ description: 'Create a task', input: Task.pick({ title: true }), output: Task })
        .handle(({ input }) => {
          const task = { id: \`task_\${++seq}\`, title: input.title, done: false }
          tasks.set(task.id, task)
          return task
        }),
      get: f
        .op({ description: 'Get one task', input: TaskId, output: Task, errors: ['not_found'] })
        .traits({ readonly: true })
        .handle(({ input }) => {
          const task = tasks.get(input.id)
          if (!task) throw errors.notFound(\`No task "\${input.id}"\`)
          return task
        }),
    },
  },
  facets: { rest: true, sdk: true, cli: { binName: 'smoke', ops: { 'tasks.create': { args: ['title'] } } }, mcp: true },
})
`

const log = (msg) => process.stdout.write(`smoke: ${msg}\n`)
const fail = (msg) => {
  throw new Error(msg)
}

// Children must run on the runtime under test: the `facet` bin's shebang picks up whatever `node`
// is first on PATH, which is not necessarily the one running this script.
const PATH = `${dirname(process.execPath)}:${process.env.PATH}`

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    env: { ...process.env, PATH, ...options.env },
  })
}

/** Invoke the installed `facet` bin on the runtime under test. */
const facetCmd = (bin, args) => (isBun ? ['bun', [bin, ...args]] : [bin, args])
const facet = (bin, args, options) => run(...facetCmd(bin, args), options)

const tarballs = pack(mkdtempSync(join(tmpdir(), 'facet-tarballs-')))
const dir = mkdtempSync(join(tmpdir(), 'facet-smoke-'))
log(`project at ${dir}`)

writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify(
    {
      name: 'smoke-app',
      private: true,
      version: '1.2.3',
      type: 'module',
      // What the quickstart tells a reader to install: the core, the CLI engine the generated
      // CLI package imports, and a schema library.
      dependencies: {
        omniface: `file:${tarballs['omniface']}`,
        '@omniface/cli': `file:${tarballs['@omniface/cli']}`,
        '@omniface/client': `file:${tarballs['@omniface/client']}`,
        zod: '^4.0.0',
      },
      // The four packages depend on each other by version range; nothing is on the registry at
      // this version yet, so point every one of them at the tarball we just built.
      overrides: Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`])),
      resolutions: Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`])),
    },
    null,
    2,
  ) + '\n',
)
writeFileSync(join(dir, 'app.mjs'), APP)
writeFileSync(join(dir, 'app.ts'), APP)

let server
try {
  log(`installing with ${isBun ? 'bun' : 'npm'}`)
  run(isBun ? 'bun' : 'npm', isBun ? ['install'] : ['install', '--no-audit', '--no-fund', '--loglevel=error'])

  const facetBin = join(dir, 'node_modules/.bin/omniface')
  if (!existsSync(facetBin)) fail('the facet package did not install an `omniface` bin')

  const version = facet(facetBin, ['--version']).trim()
  log(`omniface ${version}`)

  const lint = facet(facetBin, ['lint', 'app.mjs'])
  if (!lint.includes('No findings.')) fail(`omniface lint was not clean:\n${lint}`)

  facet(facetBin, ['build', 'app.mjs'])
  for (const file of ['manifest.json', 'openapi.json', 'llms.txt', 'cli/bin.mjs', 'cli/package.json', 'sdk/index.mjs', 'sdk/index.d.ts', 'sdk/package.json']) {
    if (!existsSync(join(dir, '.omniface', file))) fail(`omniface build did not write .omniface/${file}`)
  }
  const openapi = JSON.parse(readFileSync(join(dir, '.omniface/openapi.json'), 'utf8'))
  if (!openapi.paths['/tasks']?.post) fail('OpenAPI is missing POST /tasks')
  // Every reference the document makes has to resolve inside it, or a generator reading it stops
  // at the first named type.
  for (const ref of String(readFileSync(join(dir, '.omniface/openapi.json'), 'utf8')).matchAll(/"\$ref":\s*"([^"]+)"/g)) {
    const [, pointer] = ref
    if (!pointer.startsWith('#/components/schemas/')) fail(`OpenAPI has a reference outside components: ${pointer}`)
    if (!openapi.components.schemas[pointer.slice('#/components/schemas/'.length)]) fail(`OpenAPI has a dangling reference: ${pointer}`)
  }
  if (!openapi.components.schemas.Task) fail('OpenAPI did not hoist the named Task type into components')

  const sdkPkg = JSON.parse(readFileSync(join(dir, '.omniface/sdk/package.json'), 'utf8'))
  if (sdkPkg.name !== 'smoke-sdk') fail(`unexpected generated SDK package name: ${sdkPkg.name}`)
  const dts = readFileSync(join(dir, '.omniface/sdk/index.d.ts'), 'utf8')
  if (!dts.includes('export interface Task {')) fail('the generated SDK does not declare the named Task type')

  const inspected = JSON.parse(facet(facetBin, ['inspect', 'app.mjs', 'tasks.create', '--json']))
  if (inspected.mcp.tool.name !== 'tasks_create') fail(`unexpected MCP tool name: ${inspected.mcp.tool.name}`)

  const cliHelp = run(process.execPath, [join(dir, '.omniface/cli/bin.mjs'), '--help'])  // a plain node ESM entry
  if (!cliHelp.includes('tasks create')) fail(`the generated CLI has no tasks create:\n${cliHelp}`)

  // The server facets, against a process started exactly as the quickstart starts it.
  log(`omniface dev on :${PORT}`)
  server = spawn(...facetCmd(facetBin, ['dev', 'app.mjs', '--port', String(PORT)]), {
    cwd: dir,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PATH },
  })
  const base = `http://127.0.0.1:${PORT}`
  const deadline = Date.now() + 30_000
  for (;;) {
    if (server.exitCode !== null) fail(`omniface dev exited with ${server.exitCode}`)
    try {
      if ((await fetch(`${base}/openapi.json`)).ok) break
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) fail('omniface dev never served /openapi.json')
    await new Promise((r) => setTimeout(r, 250))
  }

  const created = await (
    await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'From REST' }) })
  ).json()
  if (created.title !== 'From REST') fail(`unexpected REST response: ${JSON.stringify(created)}`)

  const fetched = await (await fetch(`${base}/tasks/${created.id}`)).json()
  if (fetched.id !== created.id) fail(`unexpected GET response: ${JSON.stringify(fetched)}`)

  const missing = await fetch(`${base}/tasks/task_404`)
  if (missing.status !== 404) fail(`expected 404 for a missing task, got ${missing.status}`)

  const wellKnown = await (await fetch(`${base}/.well-known/facet.json`)).json()
  if (wellKnown.name !== 'smoke') fail('no facet manifest at /.well-known/facet.json')

  const cliOut = run(process.execPath, [join(dir, '.omniface/cli/bin.mjs'), 'tasks', 'create', 'From the CLI', '--output', 'json'], {
    env: { ...process.env, SMOKE_BASE_URL: base },
  })
  if (!JSON.parse(cliOut).id) fail(`the generated CLI did not create a task:\n${cliOut}`)

  // The generated SDK, imported the way a consumer's application would import it: by path into
  // the package `omniface build` wrote, resolving `@omniface/client` from the project's node_modules.
  writeFileSync(
    join(dir, 'sdk-check.mjs'),
    [
      `import { createSmokeClient, FacetClientError } from './.omniface/sdk/index.mjs'`,
      `const client = createSmokeClient({ baseUrl: process.argv[2] })`,
      `const created = await client.tasks.create({ title: 'From the generated SDK' })`,
      `const fetched = await client.tasks.get({ id: created.id })`,
      `if (fetched.title !== 'From the generated SDK') throw new Error('round trip failed: ' + JSON.stringify(fetched))`,
      `const err = await client.tasks.get({ id: 'task_404' }).catch((e) => e)`,
      `if (!(err instanceof FacetClientError) || err.code !== 'not_found') throw new Error('expected a typed not_found, got ' + err)`,
      `console.log(created.id)`,
      '',
    ].join('\n'),
  )
  const sdkOut = run(...(isBun ? ['bun', ['sdk-check.mjs', base]] : [process.execPath, ['sdk-check.mjs', base]]))
  if (!sdkOut.trim().startsWith('task_')) fail(`the generated SDK did not round trip:\n${sdkOut}`)

  const mcp = await (
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
  ).text()
  if (!mcp.includes('tasks_create')) fail(`MCP tools/list did not list tasks_create:\n${mcp}`)

  // A TypeScript entry needs a runtime that strips types: Node 22.18+/24, or Bun.
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (isBun || major > 22 || (major === 22 && minor >= 18)) {
    facet(facetBin, ['build', 'app.ts', '--out', '.facet-ts'])
    log('TypeScript entry: ok')
  } else {
    log(`TypeScript entry: skipped (node ${process.versions.node} cannot run .ts directly)`)
  }

  log('every facet answered from a fresh install')
} finally {
  server?.kill('SIGKILL')
  if (keep) log(`keeping ${dir}`)
  else rmSync(dir, { recursive: true, force: true })
}
