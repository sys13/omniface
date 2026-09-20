import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createServer, facet, type SecurityConfig } from '../src/index.ts'
import { createRestApp } from '../src/facets/rest.ts'

/** The smallest app with one read and one write, so CORS and CSRF have something to guard. */
function createApp(security?: SecurityConfig | false) {
  const f = facet()
  return f.app({
    name: 'secure',
    ops: {
      things: {
        list: f
          .op({ output: z.object({ items: z.array(z.string()), nextCursor: z.string().nullable() }) })
          .traits({ readonly: true, public: true, paginated: true })
          .handle(() => ({ items: ['one'], nextCursor: null })),
        create: f
          .op({ input: z.object({ name: z.string() }), output: z.object({ name: z.string() }) })
          .traits({ public: true })
          .handle(({ input }) => input),
      },
    },
    facets: { rest: security === undefined ? true : { security }, mcp: true, cli: true, sdk: true },
  })
}

const call = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) =>
  createRestApp(app).fetch(new Request(`http://api.test${path}`, init))

describe('security headers', () => {
  it('are on without being asked for', async () => {
    const res = await call(createApp(), '/things')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('send HSTS on HTTPS only', async () => {
    const plain = await call(createApp(), '/things')
    expect(plain.headers.get('strict-transport-security')).toBeNull()
    const proxied = await call(createApp(), '/things', { headers: { 'x-forwarded-proto': 'https' } })
    expect(proxied.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains')
  })

  it('are on error responses too', async () => {
    const res = await call(createApp(), '/things', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('can be tuned or turned off', async () => {
    const tuned = await call(createApp({ headers: { frameOptions: 'SAMEORIGIN', contentSecurityPolicy: false, extra: { 'x-acme': '1' } } }), '/things')
    expect(tuned.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(tuned.headers.get('content-security-policy')).toBeNull()
    expect(tuned.headers.get('x-acme')).toBe('1')

    const off = await call(createApp(false), '/things')
    expect(off.headers.get('x-content-type-options')).toBeNull()
  })
})

describe('CORS', () => {
  it('allows nothing cross-origin until an origin is named', async () => {
    const res = await call(createApp(), '/things', { headers: { origin: 'https://app.acme.test' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('answers a preflight for an allowed origin and ignores one for anybody else', async () => {
    const app = createApp({ cors: { origin: ['https://app.acme.test'], credentials: true } })
    const allowed = await call(app, '/things', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.acme.test', 'access-control-request-method': 'POST' },
    })
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.acme.test')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    expect(allowed.headers.get('access-control-allow-methods')).toContain('POST')
    expect(allowed.headers.get('access-control-allow-headers')).toContain('idempotency-key')
    expect(allowed.headers.get('access-control-max-age')).toBe('600')

    const denied = await call(app, '/things', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
    })
    expect(denied.status).toBe(204)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('exposes the headers a client has to read, and relaxes CORP once cross-origin is allowed', async () => {
    const res = await call(createApp({ cors: { origin: 'https://app.acme.test' } }), '/things', {
      headers: { origin: 'https://app.acme.test' },
    })
    expect(res.headers.get('access-control-expose-headers')).toBe('x-request-id, retry-after')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
  })

  it('accepts a predicate, and refuses the one combination the fetch spec forbids', async () => {
    const res = await call(createApp({ cors: { origin: (o) => o.endsWith('.acme.test') } }), '/things', {
      headers: { origin: 'https://team.acme.test' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('https://team.acme.test')
    // Refused where it is configured, not on the request that would have leaked.
    expect(() => createRestApp(createApp({ cors: { origin: '*', credentials: true } }))).toThrow(/cannot be combined/)
  })
})

describe('CSRF', () => {
  const body = { method: 'POST', body: JSON.stringify({ name: 'x' }), headers: {} as Record<string, string> }

  it('refuses a state-changing request from an origin nobody allowed', async () => {
    const res = await call(createApp(), '/things', { ...body, headers: { origin: 'https://evil.test', 'content-type': 'application/json' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'forbidden' })
  })

  it('allows same-origin, and a non-browser client that sends no Origin at all', async () => {
    const same = await call(createApp(), '/things', { ...body, headers: { origin: 'http://api.test', 'content-type': 'application/json' } })
    expect(same.status).toBe(201)
    const cli = await call(createApp(), '/things', { ...body, headers: { 'content-type': 'application/json' } })
    expect(cli.status).toBe(201)
  })

  it('reads the real host behind a proxy', async () => {
    const res = await call(createApp(), '/things', {
      ...body,
      headers: { origin: 'https://api.acme.test', 'x-forwarded-host': 'api.acme.test', 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
    })
    expect(res.status).toBe(201)
  })

  it('trusts the origins CORS already trusts, but never a wildcard', async () => {
    const named = await call(createApp({ cors: { origin: ['https://app.acme.test'] } }), '/things', {
      ...body,
      headers: { origin: 'https://app.acme.test', 'content-type': 'application/json' },
    })
    expect(named.status).toBe(201)

    const wildcard = await call(createApp({ cors: { origin: '*' } }), '/things', {
      ...body,
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
    })
    expect(wildcard.status).toBe(403)
  })

  it('never blocks a safe method', async () => {
    const res = await call(createApp(), '/things', { headers: { origin: 'https://evil.test' } })
    expect(res.status).toBe(200)
  })

  it('can be turned off on its own', async () => {
    const res = await call(createApp({ csrf: false }), '/things', {
      ...body,
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
    })
    expect(res.status).toBe(201)
  })
})

describe('the whole server', () => {
  it('covers MCP over HTTP and the inspector, and gives the inspector a policy it can run under', async () => {
    const server = createServer(createApp(), { inspector: true })
    const mcp = await server.fetch(
      new Request('http://api.test/mcp', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(mcp.status).toBe(403)

    const page = await server.fetch(new Request('http://api.test/_omniface'))
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self' 'unsafe-inline'")
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('mounts the middleware once, so the REST routes are not wrapped twice', async () => {
    const server = createServer(createApp())
    const res = await server.fetch(new Request('http://api.test/things'))
    expect(res.headers.get('vary')).toBe('Origin')
    expect(res.status).toBe(200)
  })
})
