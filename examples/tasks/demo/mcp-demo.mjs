#!/usr/bin/env node
// A real MCP host: spawns `omniface mcp` over stdio and speaks JSON-RPC to it.
// Nothing in this file is facet-aware — it is the handshake any MCP client performs.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const FACET = join(APP, 'node_modules/.bin/omniface')

const child = spawn(FACET, ['mcp', 'src/app.ts'], {
  cwd: APP,
  env: { ...process.env, TASKS_API_KEY: process.env.TASKS_API_KEY ?? 'dev_admin_key' },
  stdio: ['pipe', 'pipe', 'ignore'],
})

let nextId = 0
const pending = new Map()
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.startsWith('{')) return
  const msg = JSON.parse(line)
  const resolve = pending.get(msg.id)
  if (resolve) {
    pending.delete(msg.id)
    resolve(msg)
  }
})

const send = (method, params) => {
  const id = ++nextId
  const done = new Promise((resolve) => pending.set(id, resolve))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return done
}
const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
const indent = (text) => text.split('\n').map((line) => '  ' + line).join('\n')

const init = await send('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'demo-host', version: '1.0.0' },
})
notify('notifications/initialized')
console.log('-> initialize')
console.log(`<- ${init.result.serverInfo.name} ${init.result.serverInfo.version} · protocol ${init.result.protocolVersion}`)

console.log('\n-> tools/list')
const tools = (await send('tools/list')).result.tools
console.log(`<- ${tools.length} tools`)
console.log(indent(tools.map((tool) => tool.name).join(', ')))

const args = { title: 'Ship the demo', priority: 'high' }
console.log(`\n-> tools/call  tasks_create ${JSON.stringify(args)}`)
const call = await send('tools/call', { name: 'tasks_create', arguments: args })
console.log('<- structuredContent')
console.log(indent(JSON.stringify(call.result.structuredContent, null, 2)))

child.stdin.end()
child.kill()
process.exit(0)
