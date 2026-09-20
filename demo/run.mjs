#!/usr/bin/env node
/**
 * facet — a live demo.
 *
 * Every command below is really executed against the example app and every byte of
 * output is real. Nothing is pre-recorded, and the code slides are sliced straight
 * out of examples/tasks/src/app.ts, so this can never drift from the source.
 *
 *   pnpm demo             paced for an audience
 *   pnpm demo --fast      no typing delay
 *   pnpm demo --manual    advance chapter by chapter with the return key
 *   pnpm demo --no-color  plain text
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'examples', 'tasks')
const APP_TS = join(APP, 'src', 'app.ts')
const BREAKING = join(APP, 'src', 'app.breaking.ts')
const FACET = join(APP, 'node_modules', '.bin', 'omniface')
const PORT = Number(process.env.DEMO_PORT ?? 3010)
const BASE = `http://localhost:${PORT}`

const flags = new Set(process.argv.slice(2))
const FAST = flags.has('--fast')
const MANUAL = flags.has('--manual') && Boolean(stdin.isTTY) // interactive only; piped stdin cannot advance
const COLOR = !flags.has('--no-color') && (stdout.isTTY || !!process.env.FORCE_COLOR)

// ── theme ────────────────────────────────────────────────────────────────────────
const sgr = (open, close) => (s) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s))
const fg = (r, g, b) => sgr(`38;2;${r};${g};${b}`, '39')
const ink = fg(236, 235, 231)
const muted = fg(154, 153, 147)
const faint = fg(104, 103, 98)
const accent = fg(141, 162, 251)
const green = fg(126, 198, 153)
const amber = fg(245, 162, 93)
const red = fg(242, 139, 130)
const cyan = fg(125, 196, 205)
const purple = fg(197, 160, 246)
const bold = sgr(1, 22)
const italic = sgr(3, 23)

const W = Math.max(64, Math.min(stdout.columns || 88, 92))
const seen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length
const write = (s) => stdout.write(s)
const line = (s = '') => write(s + '\n')
const rule = (n) => faint('─'.repeat(Math.max(0, n)))
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? 0 : ms))
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function typeOut(text, delay = 13) {
  if (FAST) return write(text)
  for (const ch of text) {
    write(ch)
    await sleep(delay)
  }
}

// ── syntax highlighting ──────────────────────────────────────────────────────────
const KEYWORDS =
  /^(import|export|from|const|let|var|function|return|type|interface|await|async|new|if|else|try|catch|throw|as|of|in|default|extends|readonly|true|false|null|undefined)$/

function highlightTs(src) {
  if (!COLOR) return src
  const pattern =
    /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|(\b[A-Za-z_$][\w$]*\b)|([{}()[\]<>.,;:?=|&!+\-*/])/g
  return src.replace(pattern, (m, comment, str, num, call, word, punct) => {
    if (comment) return faint(italic(comment))
    if (str) return green(str)
    if (num) return amber(num)
    if (call) return KEYWORDS.test(call) ? purple(call) : accent(call)
    if (word) return KEYWORDS.test(word) ? purple(word) : /^[A-Z]/.test(word) ? cyan(word) : ink(word)
    if (punct) return muted(punct)
    return m
  })
}

function highlightJson(src) {
  if (!COLOR) return src
  return src.replace(
    /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,
    (m, str, colon, lit, num) => {
      if (str) return colon ? cyan(str) + muted(colon) : green(str)
      if (lit) return purple(lit)
      if (num) return amber(num)
      return m
    },
  )
}

const FACET_HEADS = new Set(['REST', 'SDK', 'CLI', 'MCP'])
function renderLine(text, mode) {
  if (mode === 'json') return highlightJson(text)
  if (mode === 'inspect') {
    const trimmed = text.trim()
    if (FACET_HEADS.has(trimmed)) return bold(accent(trimmed))
    if (trimmed.startsWith('traits:')) return muted(text)
    if (/^\w[\w.]*\s+—/.test(trimmed)) return bold(ink(text))
    if (/[{}[\]]|"\s*:/.test(text)) return highlightJson(text)
    return ink(text)
  }
  return ink(text)
}

// ── layout ───────────────────────────────────────────────────────────────────────
function rail(title, rows, tone = accent) {
  const head = `${tone('┌')} ${tone(bold(title))} `
  line('  ' + head + rule(W - 2 - seen(head)))
  for (const row of rows) line('  ' + faint('│') + ' ' + row)
  line('  ' + faint('└' + '─'.repeat(W - 3)))
}

function output(text, mode = 'plain', limit = 0) {
  let body = text === '' ? '(no output)' : text
  if (mode === 'json' && !body.includes('\n')) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2)
    } catch {}
  }
  const all = body.split('\n')
  const shown = limit && all.length > limit ? all.slice(0, limit) : all
  for (const l of shown) line('  ' + faint('│') + ' ' + renderLine(l, mode))
  if (shown.length < all.length) {
    line('  ' + faint('│') + ' ' + faint(italic(`… ${all.length - shown.length} more lines`)))
  }
}

const note = (text) => line(`  ${accent('▸')} ${ink(text)}`)
const aside = (text) => line(`  ${faint('·')} ${muted(text)}`)

function subhead(text) {
  line()
  line('  ' + bold(accent(text)) + ' ' + rule(W - 3 - seen(text)))
}

let chapterNo = 0
async function chapter(title, subtitle) {
  chapterNo += 1
  line()
  line()
  line('  ' + rule(W - 2))
  line(`  ${bold(accent(String(chapterNo).padStart(2, '0')))}  ${bold(ink(title))}`)
  line(`      ${muted(subtitle)}`)
  line('  ' + rule(W - 2))
  await sleep(300)
}

async function cmd(display) {
  line()
  write(`  ${faint('examples/tasks')} ${bold(accent('❯'))} `)
  if (COLOR) write('\x1b[1m\x1b[38;2;236;235;231m')
  await typeOut(display)
  write(COLOR ? '\x1b[39m\x1b[22m\n' : '\n')
  await sleep(180)
}

function tokenizeAnsi(text) {
  const items = []
  const re = /\x1b\[[0-9;]*m/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    for (const ch of text.slice(last, m.index)) items.push({ ch })
    items.push({ esc: m[0] })
    last = m.index + m[0].length
  }
  for (const ch of text.slice(last)) items.push({ ch })
  return items
}

function applyEsc(open, esc) {
  const code = esc.slice(2, -1)
  const dropLast = (pred) => {
    for (let i = open.length - 1; i >= 0; i--) {
      if (pred(open[i])) return void open.splice(i, 1)
    }
  }
  if (code === '0') open.length = 0
  else if (code === '39') dropLast((e) => e.startsWith('\x1b[38'))
  else if (code === '22') dropLast((e) => e === '\x1b[1m')
  else if (code === '23') dropLast((e) => e === '\x1b[3m')
  else open.push(esc)
}

/** Wrap an already-highlighted line without tearing its colour spans apart. */
function wrapAnsi(text, width, cont = '') {
  const items = tokenizeAnsi(text)
  const rows = []
  let buf = ''
  let vis = 0
  const open = []
  let mark = -1
  let markVis = 0
  let markOpen = []
  for (const item of items) {
    if (item.esc) {
      buf += item.esc
      applyEsc(open, item.esc)
      continue
    }
    if (item.ch === ' ' && vis > 0) {
      mark = buf.length
      markVis = vis
      markOpen = open.slice()
    }
    buf += item.ch
    vis += 1
    if (vis >= width) {
      const atSpace = mark > 0 && markVis > width * 0.5
      const head = atSpace ? buf.slice(0, mark) : buf
      const tail = atSpace ? buf.slice(mark + 1) : ''
      rows.push(head + (open.length ? '\x1b[0m' : ''))
      buf = cont + (atSpace ? markOpen : open).join('') + tail
      vis = seen(buf)
      mark = -1
    }
  }
  if (buf !== '' || rows.length === 0) rows.push(buf + (open.length ? '\x1b[0m' : ''))
  return rows
}

function sourceRows(lines, firstLineNo) {
  const rows = []
  lines.forEach((raw, i) => {
    const cont = (raw.match(/^\s*/) ?? [''])[0] + '  '
    wrapAnsi(highlightTs(raw), W - 12, cont).forEach((piece, j) => {
      rows.push(`${j === 0 ? faint(String(firstLineNo + i).padStart(3)) : '   '}  ${piece}`)
    })
  })
  return rows
}

/** Slice real lines out of the example app so a slide can never drift from the source. */
function codeRail(title, from, to) {
  const src = readFileSync(APP_TS, 'utf8').split('\n')
  rail(title, sourceRows(src.slice(from - 1, to), from), cyan)
}

function fileRail(title, path) {
  const src = readFileSync(path, 'utf8').replace(/\s+$/, '').split('\n')
  rail(title, sourceRows(src, 1), cyan)
}

// ── running things for real ──────────────────────────────────────────────────────
function sh(bin, args, opts = {}) {
  const env = { ...process.env, NO_COLOR: '1', ...opts.env }
  delete env.FORCE_COLOR
  const res = spawnSync(bin, args, {
    cwd: opts.cwd ?? APP,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const merged = opts.quiet ? (res.stdout ?? '') : (res.stdout ?? '') + (res.stderr ?? '')
  return { code: res.status ?? 0, out: merged.replace(/\s+$/, '') }
}

let server = null
let serverLog = ''
async function startServer() {
  // Fail loudly if something already holds the port, rather than demoing against it.
  try {
    await fetch(`${BASE}/.well-known/facet.json`)
    return { ok: false, error: `port ${PORT} is already in use — stop that process, or set DEMO_PORT` }
  } catch {}

  const serverEnv = { ...process.env, NO_COLOR: '1' }
  delete serverEnv.FORCE_COLOR
  server = spawn(FACET, ['dev', 'src/app.ts', '--port', String(PORT)], {
    cwd: APP,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  let exited = null
  // omniface dev prints its banner on one stream and its structured logs on the other,
  // so keep both and let the caller pick out what it needs.
  server.stdout.on('data', (chunk) => {
    serverLog += chunk
  })
  server.stderr.on('data', (chunk) => {
    serverLog += chunk
    stderr += chunk
  })
  server.on('exit', (code) => {
    exited = code ?? 0
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (exited !== null) return { ok: false, error: `omniface dev exited with code ${exited}\n${stderr.trim()}` }
    try {
      if ((await fetch(`${BASE}/.well-known/facet.json`)).ok) {
        await realSleep(250)
        const banner = serverLog.split('\n').filter((l) => !l.trim().startsWith('{')).join('\n')
        return { ok: true, banner: banner.replace(/\s+$/, '') }
      }
    } catch {}
    await realSleep(120)
  }
  return { ok: false, error: 'omniface dev did not become ready within 30s' }
}

function cleanup() {
  if (server) {
    server.kill()
    server = null
  }
  try {
    rmSync(BREAKING, { force: true })
  } catch {}
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup()
    process.exit(130)
  })
}
stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') {
    cleanup()
    process.exit(0)
  }
})

async function advance() {
  if (!MANUAL) return sleep(650)
  await new Promise((resolve) => {
    write(`\n  ${faint('press ↵')}`)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.once('data', () => {
      stdin.pause()
      write('\r' + ' '.repeat(W) + '\r')
      resolve()
    })
  })
}

function card(rows, tone = accent) {
  const inner = W - 6
  line('  ' + tone('╭' + '─'.repeat(inner + 2) + '╮'))
  for (const row of rows) {
    line('  ' + tone('│') + ' ' + row + ' '.repeat(Math.max(0, inner - seen(row))) + ' ' + tone('│'))
  }
  line('  ' + tone('╰' + '─'.repeat(inner + 2) + '╯'))
}

// ── the demo ─────────────────────────────────────────────────────────────────────
async function main() {
  if (stdout.isTTY && !flags.has('--no-clear')) write('\x1b[2J\x1b[H')
  line()
  card([
    '',
    bold(ink('omniface')) + muted('   one definition, every interface'),
    '',
    muted('REST') + faint(' · ') + muted('SDK') + faint(' · ') + muted('CLI') + faint(' · ') + muted('MCP'),
    '',
  ])
  line()
  aside('Every command below really runs. Nothing is pre-recorded.')
  await advance()

  // 01 ───────────────────────────────────────────────────────────────────────────
  await chapter('The definition', 'Everything is code. No YAML, no IDL, no second source of truth.')
  codeRail('examples/tasks/src/app.ts', 20, 31)
  line()
  note('Field traits ride along with the fields: ' + cyan('pii') + ', ' + cyan('internal') + '.')
  await advance()
  line()
  codeRail('examples/tasks/src/app.ts', 139, 146)
  line()
  note('An operation, not an endpoint: a description, a schema, traits, a handler.')
  aside('idempotent becomes an HTTP header, an SDK retry key, a CLI flag and an MCP hint.')
  await advance()
  line()
  codeRail('examples/tasks/src/app.ts', 169, 184)
  line()
  note('Four facets opted in. Overrides are typed — a typo in an op id fails tsc.')
  await advance()

  // 02 ───────────────────────────────────────────────────────────────────────────
  await chapter('One op, every facet', 'Nothing below was written by hand. It is all derived.')
  await cmd('omniface inspect src/app.ts tasks.complete')
  output(sh(FACET, ['inspect', 'src/app.ts', 'tasks.complete']).out, 'inspect', 32)
  line()
  note('One operation, rendered as curl, an SDK call, a CLI command and an MCP tool.')
  await advance()

  // 03 ───────────────────────────────────────────────────────────────────────────
  await chapter('Build', 'Runtime first — codegen only for the things that run elsewhere.')
  await cmd('omniface build src/app.ts')
  const built = sh(FACET, ['build', 'src/app.ts'])
  output(built.out)
  line()
  const artifacts = [
    ['.omniface/manifest.json', 'the definition, serialized'],
    ['.omniface/openapi.json', 'OpenAPI 3.1'],
    ['.omniface/llms.txt', 'every op, for agents'],
    ['.omniface/cli/bin.mjs', 'a CLI: engine + manifest'],
  ]
  rail(
    'artifacts',
    artifacts.map(([path, what]) => {
      const kb = (statSync(join(APP, path)).size / 1024).toFixed(1) + ' kB'
      return ink(path.padEnd(24)) + amber(kb.padStart(8)) + '   ' + muted(what)
    }),
    green,
  )
  await advance()

  // 04 ───────────────────────────────────────────────────────────────────────────
  await chapter('Serve', 'One process answers on every facet at once.')
  await cmd(`omniface dev src/app.ts --port ${PORT}`)
  const started = await startServer()
  if (!started.ok) {
    line()
    line('  ' + red(bold('✗ ')) + red(started.error))
    cleanup()
    process.exit(1)
  }
  output(started.banner)
  await advance()

  // 05 ───────────────────────────────────────────────────────────────────────────
  await chapter('The same task, four ways', 'Same pipeline, same errors, same shapes — four front doors.')

  subhead('CLI')
  await cmd(`TASKS_API_KEY=dev_admin_key node .omniface/cli/bin.mjs tasks create "Ship the demo" --priority high --base-url ${BASE}`)
  output(
    sh('node', ['.omniface/cli/bin.mjs', 'tasks', 'create', 'Ship the demo', '--priority', 'high', '--base-url', BASE], {
      env: { TASKS_API_KEY: 'dev_admin_key' },
    }).out,
    'json',
  )

  subhead('REST')
  await cmd(`curl -s -H "Authorization: Bearer dev_admin_key" ${BASE}/tasks`)
  output(sh('curl', ['-s', '-H', 'Authorization: Bearer dev_admin_key', `${BASE}/tasks`]).out, 'json')

  subhead('SDK')
  fileRail('examples/tasks/demo/sdk-demo.ts', join(APP, 'demo', 'sdk-demo.ts'))
  await cmd('node demo/sdk-demo.ts')
  output(sh('node', ['demo/sdk-demo.ts'], { env: { TASKS_BASE_URL: BASE } }).out)
  line()
  note('No codegen. ' + cyan('createClient<TasksApp>()') + ' infers every method from the definition.')
  await advance()

  subhead('MCP')
  await cmd('node demo/mcp-demo.mjs')
  output(sh('node', ['demo/mcp-demo.mjs'], { quiet: true }).out, 'json')
  line()
  note('A real JSON-RPC handshake over stdio — the same one Claude or any MCP host performs.')
  aside('omniface mcp runs the app in its own process, so its store starts empty — hence task_1 again.')
  await advance()

  // 06 ───────────────────────────────────────────────────────────────────────────
  await chapter('Auth is not a facet concern', 'Concerns run in the operation pipeline, so a new facet cannot bypass them.')
  const stages = (await (await fetch(`${BASE}/_omniface/inspect.json`)).json()).ops.find((op) => op.id === 'tasks.create')
    .pipeline.stages
  rail(
    'the pipeline behind every facet',
    stages.map((s) => ink(s.stage.padEnd(16)) + (s.plugins.length ? accent(s.plugins.join(', ')) : faint('—'))),
    purple,
  )

  subhead('no credential')
  await cmd(`curl -s -o /dev/null -w "%{http_code}" ${BASE}/tasks`)
  output(sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${BASE}/tasks`]).out + '  ' + red('Unauthorized'))

  subhead('a reader key attempting a write')
  await cmd(`curl -s -X POST -H "Authorization: Bearer dev_reader_key" -d '{"title":"nope"}' ${BASE}/tasks`)
  output(
    sh('curl', [
      '-s',
      '-X',
      'POST',
      '-H',
      'Authorization: Bearer dev_reader_key',
      '-H',
      'Content-Type: application/json',
      '-d',
      '{"title":"nope"}',
      `${BASE}/tasks`,
    ]).out,
    'json',
  )
  line()
  note('RFC 7807 problem+json, with a request id — and the CLI exits ' + amber('4') + ' on the same error.')
  await advance()

  // 07 ───────────────────────────────────────────────────────────────────────────
  await chapter('Traits travel', 'Mark a field once; every facet and every plugin honours it.')
  codeRail('examples/tasks/src/app.ts', 27, 28)

  const pii = '{"title":"Draft the changelog","assigneeEmail":"alice@example.com"}'
  subhead('create a task carrying an email address')
  await cmd(`curl -s -X POST -H "Authorization: Bearer dev_admin_key" -d '${pii}' ${BASE}/tasks`)
  output(
    sh('curl', [
      '-s',
      '-X',
      'POST',
      '-H',
      'Authorization: Bearer dev_admin_key',
      '-H',
      'Content-Type: application/json',
      '-d',
      pii,
      `${BASE}/tasks`,
    ]).out,
    'json',
  )
  aside('The address comes back — it is part of the API. internalScore does not.')

  subhead('the very same request, in the server log')
  await realSleep(250)
  const logged = serverLog
    .split('\n')
    .filter((l) => l.includes('"op completed"'))
    .pop()
  output(
    (() => {
      try {
        return JSON.stringify(JSON.parse(logged), null, 2)
      } catch {
        return logged ?? '(no log line captured)'
      }
    })(),
    'json',
  )
  line()
  const openapi = readFileSync(join(APP, '.facet', 'openapi.json'), 'utf8')
  const count = (needle) => (openapi.match(new RegExp(needle, 'g')) ?? []).length
  rail(
    'what those two words did',
    [
      green('✓ ') + cyan('pii') + muted('       redacted in the log · ') + amber(String(count('x-omniface-pii'))) +
        muted(' x-omniface-pii marks in openapi.json'),
      green('✓ ') + cyan('internal') + muted('  stripped from every response · ') + amber(String(count('internalScore'))) +
        muted(' mentions in openapi.json'),
    ],
    green,
  )
  line()
  note('Written once on the field. The API, the schema and the logs each do the right thing.')
  await advance()

  // 08 ───────────────────────────────────────────────────────────────────────────
  await chapter('Prove it', 'Tiny input, large output — and every output is checked.')
  await cmd('omniface lint src/app.ts')
  const lint = sh(FACET, ['lint', 'src/app.ts'])
  output(lint.out)
  await cmd('omniface conformance src/app.ts --strict')
  const conf = sh(FACET, ['conformance', 'src/app.ts', '--strict'])
  output(conf.out.split('\n').filter(Boolean).join('\n'), 'plain')
  line()
  note('Cases generated from the definition, driving every op through REST, SDK, CLI and MCP.')
  await advance()

  // 09 ───────────────────────────────────────────────────────────────────────────
  await chapter('Break it on purpose', 'Ask "is this breaking?" once, and get the answer for every facet.')
  const src = readFileSync(APP_TS, 'utf8')
  const before = "    priority: z.enum(['low', 'normal', 'high']),"
  const after = "    priority: z.enum(['low', 'normal']),"
  writeFileSync(BREAKING, src.replace(before, after))
  rail('a one-line edit', [red('- ' + before.trim()), green('+ ' + after.trim())], amber)
  await cmd('omniface diff .omniface/manifest.json src/app.breaking.ts --strict')
  const diff = sh(FACET, ['diff', '.omniface/manifest.json', 'src/app.breaking.ts', '--strict'])
  output(diff.out)
  rmSync(BREAKING, { force: true })
  line()
  note('Exit code ' + amber(String(diff.code)) + ' — so this is a CI gate, not a report nobody reads.')
  await advance()

  // outro ────────────────────────────────────────────────────────────────────────
  cleanup()
  line()
  line()
  card(
    [
      '',
      bold(ink('One TypeScript value.')),
      muted('A REST API, an OpenAPI document, a typed SDK, a CLI and an MCP server —'),
      muted('each one conventional by default, overridable where it matters, and proven'),
      muted('to agree by tests generated from the definition itself.'),
      '',
      faint('omniface dev · inspect · build · lint · conformance · diff'),
      '',
    ],
    accent,
  )
  line()
}

main().catch((err) => {
  cleanup()
  line()
  line('  ' + red(bold('demo failed: ')) + red(err?.stack ?? String(err)))
  process.exit(1)
})
