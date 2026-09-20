import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createServer, facet } from '../src/index.ts'
import { createMcpServer, memoryClientRegistry } from '../src/facets/mcp.ts'
import { audit, type AuditEntry } from '../src/plugins/audit.ts'

// Backlog 3.5: the same agent, the same tool, two transports — one audit trail. Streamable HTTP is
// stateless, so the request that runs the tool never saw the `initialize` that named the client.

const CLIENT = { name: 'acme-agent', version: '1.2.3' }

function app(entries: AuditEntry[]) {
  const f = facet({ plugins: [audit({ sink: (e) => void entries.push(e) })] })
  return f.app({
    name: 'notes',
    ops: {
      notes: {
        touch: f
          .op({ input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) })
          .traits({ public: true })
          .handle(({ input }) => ({ id: input.id })),
      },
    },
  })
}

const stable = (entry: AuditEntry) => ({ ...entry, at: '<at>', requestId: '<id>' })

async function overStdio(entries: AuditEntry[]): Promise<void> {
  const server = createMcpServer(app(entries), { transport: 'stdio' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new McpClient(CLIENT)
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  await client.callTool({ name: 'notes_touch', arguments: { id: 'n1' } })
  await client.close()
}

async function overHttp(entries: AuditEntry[], client = new McpClient(CLIENT)): Promise<void> {
  const hono = createServer(app(entries))
  const transport = new StreamableHTTPClientTransport(new URL('http://facet.test/mcp'), {
    fetch: async (input, init) => hono.fetch(new Request(input as string, init as RequestInit)),
  })
  await client.connect(transport)
  await client.callTool({ name: 'notes_touch', arguments: { id: 'n1' } })
  await client.close()
}

describe('actor attribution over MCP', () => {
  it('names the agent on stdio', async () => {
    const entries: AuditEntry[] = []
    await overStdio(entries)
    expect(entries.map(stable)).toEqual([
      {
        at: '<at>',
        requestId: '<id>',
        op: 'notes.touch',
        facet: 'mcp',
        actor: { id: 'anonymous', kind: 'agent', via: 'mcp:acme-agent' },
        outcome: 'ok',
        input: { id: 'n1' },
      },
    ])
  })

  it('produces an identical record over stateless Streamable HTTP', async () => {
    const viaStdio: AuditEntry[] = []
    const viaHttp: AuditEntry[] = []
    await overStdio(viaStdio)
    await overHttp(viaHttp)
    expect(viaHttp.map(stable)).toEqual(viaStdio.map(stable))
  })

  it('falls back to unknown-client for a caller that never introduced itself', async () => {
    const entries: AuditEntry[] = []
    const hono = createServer(app(entries))
    // A raw JSON-RPC tool call, with no `initialize` before it: nothing to attribute it to.
    await hono.fetch(
      new Request('http://facet.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'notes_touch', arguments: { id: 'n1' } },
        }),
      }),
    )
    expect(entries.map((e) => e.actor.via)).toEqual(['mcp:unknown-client'])
  })
})

describe('the client registry', () => {
  it('forgets an announcement once it has expired', () => {
    const registry = memoryClientRegistry({ ttlMs: -1 })
    registry.remember('k', CLIENT)
    expect(registry.lookup('k')).toBeUndefined()
  })

  it('keeps only the newest entries', () => {
    const registry = memoryClientRegistry({ max: 2 })
    registry.remember('a', { name: 'a' })
    registry.remember('b', { name: 'b' })
    registry.remember('c', { name: 'c' })
    expect(registry.lookup('a')).toBeUndefined()
    expect(registry.lookup('c')).toEqual({ name: 'c' })
  })

  it('does not let one caller inherit the name of another', () => {
    const registry = memoryClientRegistry()
    registry.remember('token-a\u0000\u0000agent/1', CLIENT)
    expect(registry.lookup('token-b\u0000\u0000agent/1')).toBeUndefined()
  })
})
