import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { apiKeys, scopes } from '../src/plugins/index.ts'
import { facet, type OAuthResourceConfig } from '../src/index.ts'
import { createMcpHttpHandler } from '../src/facets/mcp.ts'
import { createRestApp } from '../src/facets/rest.ts'
import { PROTECTED_RESOURCE_PATH } from '../src/facets/oauth.ts'

/**
 * Backlog 2.6, the discovery half: where a caller with no credential goes to get one (RFC 9728).
 *
 * Nothing here authenticates anything. The app names somebody else's authorization server and
 * omniface says so out loud — on the document, and on the refusal that makes the document findable.
 * An agent that reaches a server it has no token for currently has to be handed one out of band;
 * what these cases prove is that it no longer has to be.
 */

const AS = 'https://auth.example.com'

function createApp(oauth?: OAuthResourceConfig) {
  const f = facet({ plugins: [apiKeys({ keys: [{ key: 'k_admin', principalId: 'u1', scopes: ['*'] }] }), scopes()] })
  return f.app({
    name: 'vault',
    ops: {
      things: {
        list: f
          .op({ output: z.object({ items: z.array(z.string()), nextCursor: z.string().nullable() }) })
          .traits({ readonly: true, paginated: true, scope: 'things:read' })
          .handle(() => ({ items: ['one'], nextCursor: null })),
        create: f
          .op({ input: z.object({ name: z.string() }), output: z.object({ name: z.string() }) })
          .traits({ scope: 'things:write' })
          .handle(({ input }) => input),
        ping: f.op({ output: z.object({ ok: z.boolean() }) }).traits({ readonly: true, public: true }).handle(() => ({ ok: true })),
      },
    },
    facets: { rest: true, mcp: true, cli: true, sdk: true },
    ...(oauth ? { oauth } : {}),
  })
}

const rest = (oauth: OAuthResourceConfig | undefined, path: string, init?: RequestInit) =>
  createRestApp(createApp(oauth)).fetch(new Request(`http://api.test${path}`, init))

const declared: OAuthResourceConfig = { authorizationServers: [AS] }

describe('the document', () => {
  it('names the authorization server, and the scopes the ops already declare', async () => {
    const res = await rest(declared, PROTECTED_RESOURCE_PATH)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      resource: 'http://api.test',
      authorization_servers: [AS],
      // Derived, not restated: a hand-written list here is one that goes stale against the traits.
      // The plugin's own ops are in it too, because a plugin op is an op — a caller that has to
      // rotate a key needs the scope for it as much as one that has to read a thing.
      scopes_supported: ['apiKeys:read', 'apiKeys:write', 'things:read', 'things:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'vault',
    })
  })

  it('does not advertise a scope no op enforces', async () => {
    const body = (await (await rest(declared, PROTECTED_RESOURCE_PATH)).json()) as { scopes_supported: string[] }
    expect(body.scopes_supported).not.toContain('*')
  })

  it('takes the resource the app names, for the proxy case the origin gets wrong', async () => {
    const body = (await (await rest({ authorizationServers: [AS], resource: 'https://api.acme.com' }, PROTECTED_RESOURCE_PATH)).json()) as {
      resource: string
    }
    expect(body.resource).toBe('https://api.acme.com')
  })

  it('is not served at all by an app that has not named an authorization server', async () => {
    expect((await rest(undefined, PROTECTED_RESOURCE_PATH)).status).toBe(404)
  })
})

describe('the refusal that makes it findable', () => {
  it('points an anonymous caller at the document', async () => {
    const res = await rest(declared, '/things')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="http://api.test${PROTECTED_RESOURCE_PATH}"`)
  })

  it('says a presented token was the problem, rather than that none was presented', async () => {
    const res = await rest(declared, '/things', { headers: { authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
  })

  it('stays quiet for an app that has not named one — a pointer to nowhere is worse than none', async () => {
    const res = await rest(undefined, '/things')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  it('does not appear on a refusal that a credential would not fix', async () => {
    const res = await rest(declared, '/things', { headers: { authorization: 'Bearer k_admin' }, method: 'POST' })
    expect(res.status).not.toBe(401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })
})

describe('MCP over HTTP', () => {
  const post = (oauth: OAuthResourceConfig | undefined, headers: Record<string, string> = {}) =>
    createMcpHttpHandler(createApp(oauth))(
      new Request('http://api.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    )

  it('tells an agent with no credential where to get one', async () => {
    const res = await post(declared)
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="http://api.test${PROTECTED_RESOURCE_PATH}"`)
  })

  it('says nothing to an agent that already presented one', async () => {
    const res = await post(declared, { authorization: 'Bearer k_admin' })
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  it('says nothing for an app that has not named an authorization server', async () => {
    expect((await post(undefined)).headers.get('www-authenticate')).toBeNull()
  })
})
