import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildManifest, createServer, definePlugin, facet, type Credential } from '../src/index.ts'
import { buildOpenApi } from '../src/facets/openapi.ts'
import { t } from '../src/zod/index.ts'

// The per-facet `adapters` slot (backlog 3.1): the only place a plugin may touch a facet, and
// still barred from deciding whether an op runs.

const Note = t.named('Note', z.object({ id: t.id(), body: z.string() }))

/** A plugin that fills every slot, so each one can be driven end to end. */
function demo() {
  return definePlugin<{ who: string }>({
    name: 'demo',
    hooks: {
      // The cookie is only *found* by the REST adapter; what it means is decided here, once, for
      // every facet — which is exactly the division the slot exists to keep.
      authenticate(inv) {
        if (inv.credential?.token === 'cookie-token') {
          inv.principal = { id: 'user_cookie', kind: 'user', scopes: ['*'] }
        }
        inv.ctx.who = inv.principal.id
      },
    },
    adapters: {
      rest: {
        credential: (request): Credential | undefined => {
          const cookie = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get('cookie') ?? '')
          return cookie ? { type: 'bearer', token: cookie[1]! } : undefined
        },
        routes: [
          { method: 'GET', path: '/ping', summary: 'Liveness for the demo plugin', handler: () => Response.json({ pong: true }) },
          // Deliberately named like an op route: the namespace is what keeps it from shadowing one.
          { method: 'GET', path: '/notes', handler: () => Response.json({ notAnOp: true }) },
        ],
        headers: (ctx) => ({ 'x-demo-op': ctx.op, 'x-demo-ok': String(ctx.ok) }),
        securitySchemes: { demoCookie: { type: 'apiKey', in: 'cookie', name: 'session' } },
      },
      mcp: {
        instructions: 'Calls are recorded by the demo plugin.',
        client: (ctx) => (ctx.transport === 'http' ? { name: 'demo-fallback', version: '9' } : undefined),
      },
      cli: {
        flags: [{ name: 'demo-token', summary: 'A demo credential', env: 'DEMO_TOKEN', credential: true }],
        commands: [{ command: 'ping', summary: 'Who am I', op: 'notes.whoami' }],
      },
      sdk: { options: [{ name: 'demoToken', summary: 'A demo credential', header: 'x-demo-token', credential: true }] },
    },
  })
}

function demoApp(plugins = [demo()]) {
  const f = facet({ plugins })
  return f.app({
    name: 'notes',
    ops: {
      notes: {
        list: f
          .op({ input: t.pageInput(), output: t.page(Note) })
          .traits({ readonly: true, paginated: true, public: true })
          .handle(() => ({ items: [{ id: 'n1', body: 'hi' }], nextCursor: null })),
        whoami: f
          .op({ output: z.object({ id: z.string() }) })
          .traits({ readonly: true, public: true })
          .handle(({ principal }) => ({ id: principal.id })),
      },
    },
  })
}

const call = (app: ReturnType<typeof demoApp>, path: string, init?: RequestInit) =>
  createServer(app).fetch(new Request(`http://facet.test${path}`, init))

describe('the adapters slot', () => {
  it('collects adapters onto the app, in install order', () => {
    const app = demoApp()
    expect(app.adapters.map((a) => a.plugin)).toEqual(['demo'])
    expect(app.adapters[0]!.rest?.routes?.length).toBe(2)
  })

  it('carries the serializable half into the manifest, namespaced', () => {
    const manifest = buildManifest(demoApp())
    expect(manifest.adapters).toEqual([
      {
        plugin: 'demo',
        rest: {
          routes: [
            { method: 'GET', path: '/_demo/ping', summary: 'Liveness for the demo plugin' },
            { method: 'GET', path: '/_demo/notes' },
          ],
          securitySchemes: { demoCookie: { type: 'apiKey', in: 'cookie', name: 'session' } },
        },
        mcp: { instructions: 'Calls are recorded by the demo plugin.' },
        cli: {
          flags: [{ name: 'demo-token', summary: 'A demo credential', env: 'DEMO_TOKEN', credential: true }],
          commands: [{ command: 'ping', summary: 'Who am I', op: 'notes.whoami' }],
        },
        sdk: { options: [{ name: 'demoToken', summary: 'A demo credential', header: 'x-demo-token', credential: true }] },
      },
    ])
  })

  it('leaves out what a facet the app has turned off would advertise', () => {
    const f = facet({ plugins: [demo()] })
    const app = f.app({
      name: 'notes',
      ops: { notes: { whoami: f.op({ output: z.object({ id: z.string() }) }).traits({ readonly: true, public: true }).handle(() => ({ id: 'x' })) } },
      facets: { rest: true },
    })
    expect(buildManifest(app).adapters).toEqual([
      { plugin: 'demo', rest: { routes: [{ method: 'GET', path: '/_demo/ping', summary: 'Liveness for the demo plugin' }, { method: 'GET', path: '/_demo/notes' }], securitySchemes: { demoCookie: { type: 'apiKey', in: 'cookie', name: 'session' } } } },
    ])
  })
})

describe('REST adapters', () => {
  it('mounts plugin routes under the plugin namespace', async () => {
    const res = await call(demoApp(), '/_demo/ping')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pong: true })
  })

  it('cannot shadow an op route, however a route is named', async () => {
    const app = demoApp()
    expect(await (await call(app, '/notes')).json()).toEqual({ items: [{ id: 'n1', body: 'hi' }], nextCursor: null })
    expect(await (await call(app, '/_demo/notes')).json()).toEqual({ notAnOp: true })
  })

  it('finds a credential the default header reader misses', async () => {
    const res = await call(demoApp(), '/notes/whoami', { headers: { cookie: 'session=cookie-token' } })
    expect(await res.json()).toEqual({ id: 'user_cookie' })
  })

  it('leaves the Authorization header in charge when there is one', async () => {
    const res = await call(demoApp(), '/notes/whoami', {
      headers: { cookie: 'session=cookie-token', authorization: 'Bearer something-else' },
    })
    expect(await res.json()).toEqual({ id: 'anonymous' })
  })

  it('decorates a response the facet has already decided, on success and on failure', async () => {
    const ok = await call(demoApp(), '/notes/whoami')
    expect(ok.headers.get('x-demo-op')).toBe('notes.whoami')
    expect(ok.headers.get('x-demo-ok')).toBe('true')
    const missing = await call(demoApp(), '/notes?limit=nonsense')
    expect(missing.status).toBe(400)
    expect(missing.headers.get('x-demo-ok')).toBe('false')
  })

  it('advertises contributed security schemes and routes in OpenAPI', () => {
    const openapi = buildOpenApi(buildManifest(demoApp())) as any
    expect(openapi.components.securitySchemes.demoCookie).toEqual({ type: 'apiKey', in: 'cookie', name: 'session' })
    expect(openapi.components.securitySchemes.bearer).toEqual({ type: 'http', scheme: 'bearer' })
    expect(openapi.paths['/_demo/ping'].get.summary).toBe('Liveness for the demo plugin')
    expect(openapi.paths['/_demo/ping'].get['x-omniface-plugin']).toBe('demo')
  })
})

describe('what an adapter may not do', () => {
  const broken = (adapters: any) => () => demoApp([definePlugin({ name: 'bad', adapters })])

  it('refuses a flag that shadows a built-in global flag', () => {
    expect(broken({ cli: { flags: [{ name: 'api-key', summary: 'nope' }] } })).toThrow(/built-in global flag/)
  })

  it('refuses a command that shadows a built-in command', () => {
    expect(broken({ cli: { commands: [{ command: 'login', summary: 'nope', op: 'notes.whoami' }] } })).toThrow(/built-in/)
  })

  it('refuses a command that names an op the app does not have', () => {
    expect(broken({ cli: { commands: [{ command: 'nope', summary: 'nope', op: 'notes.missing' }] } })).toThrow(/unknown op/)
  })

  it('refuses a route that escapes its namespace or repeats itself', () => {
    expect(broken({ rest: { routes: [{ method: 'GET', path: 'ping', handler: () => new Response() }] } })).toThrow(/must start with/)
    expect(
      broken({ rest: { routes: [{ method: 'GET', path: '/../notes', handler: () => new Response() }] } }),
    ).toThrow(/may not contain/)
    expect(
      broken({
        rest: {
          routes: [
            { method: 'GET', path: '/x', handler: () => new Response() },
            { method: 'GET', path: '/x', handler: () => new Response() },
          ],
        },
      }),
    ).toThrow(/declared twice/)
  })

  it('refuses two plugins that claim the same CLI command, flag or SDK option', () => {
    const rival = (adapters: any) => () =>
      demoApp([demo(), definePlugin({ name: 'rival', adapters })])
    expect(rival({ cli: { commands: [{ command: 'ping', summary: 'mine now', op: 'notes.whoami' }] } })).toThrow(
      /already plugin "demo"/,
    )
    expect(rival({ cli: { flags: [{ name: 'demo-token', summary: 'mine now' }] } })).toThrow(/already plugin "demo"/)
    expect(rival({ sdk: { options: [{ name: 'demoToken', summary: 'mine now' }] } })).toThrow(/already plugin "demo"/)
  })

  it('refuses a plugin command that shadows one of the app\'s own', () => {
    expect(
      broken({ cli: { commands: [{ command: 'notes whoami', summary: 'nope', op: 'notes.whoami' }] } }),
    ).toThrow(/already op "notes.whoami"/)
  })

  it('refuses an SDK option that shadows a built-in client option', () => {
    expect(broken({ sdk: { options: [{ name: 'baseUrl', summary: 'nope' }] } })).toThrow(/built-in client option/)
  })

  it('has no way to see an invocation, let alone stop one (Gate 1)', () => {
    // The shape of the slot is the enforcement: no member of it is handed an Invocation, and the
    // only thing mounted on the HTTP facet lives under a namespace of its own.
    const adapters = demoApp().adapters[0]!
    const members = [
      ...Object.values(adapters.rest ?? {}),
      ...Object.values(adapters.mcp ?? {}),
    ].filter((v) => typeof v === 'function') as ((arg: unknown) => unknown)[]
    expect(members.length).toBeGreaterThan(0)
    for (const member of members) expect(member.length).toBeLessThanOrEqual(1)
  })
})
