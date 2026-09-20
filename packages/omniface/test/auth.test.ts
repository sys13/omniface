import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { facet, FacetError, type AuthAdapter } from '../src/index.ts'
import {
  apiKeyAdapter,
  auth,
  betterAuthAdapter,
  clerkAdapter,
  jwtAdapter,
  principalFromClaims,
  scopesFromClaims,
  verifyJwt,
  workOsJwksUri,
  workosAdapter,
} from '../src/auth/index.ts'
import { apiKeys, memoryKeyStore, scopes } from '../src/plugins/index.ts'
import { createRestApp } from '../src/facets/rest.ts'

// ---------------------------------------------------------------------------------------------
// A real issuer: a keypair, a JWKS endpoint, and tokens signed with it.

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))

type Issuer = {
  url: string
  jwks: { keys: unknown[] }
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>
  fetch: typeof fetch
}

async function createIssuer(url: string, kid = 'test-key'): Promise<Issuer> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const jwks = { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] }

  const sign: Issuer['sign'] = async (claims, header = {}) => {
    const head = encodeJson({ alg: 'RS256', typ: 'JWT', kid, ...header })
    const body = encodeJson({ iss: url, exp: Math.floor(Date.now() / 1000) + 600, ...claims })
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    )
    return `${head}.${body}.${b64url(signature)}`
  }

  // The issuer's own HTTP surface: OIDC discovery and the JWKS.
  const fetchFn = (async (input: RequestInfo | URL) => {
    const target = String(input instanceof Request ? input.url : input)
    if (target === `${url}/.well-known/openid-configuration`) {
      return Response.json({ issuer: url, jwks_uri: `${url}/jwks` })
    }
    if (target === `${url}/jwks` || target === workOsJwksUri('client_test')) return Response.json(jwks)
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  return { url, jwks, sign, fetch: fetchFn }
}

const ctx = (token?: string) => ({ facet: 'rest' as const, requestId: 'req_test', ...(token ? { credential: { type: 'bearer' as const, token } } : {}) })

// ---------------------------------------------------------------------------------------------

describe('jwt verification', () => {
  it('accepts a token signed by the issuer and maps its claims onto a principal', async () => {
    const issuer = await createIssuer('https://issuer.test')
    const adapter = jwtAdapter({ issuer: issuer.url, fetch: issuer.fetch })
    const token = await issuer.sign({ sub: 'user_1', scope: 'tasks:read tasks:write', email: 'a@b.test' })

    const result = await adapter.authenticate(ctx(token))
    expect(result?.principal).toEqual({ id: 'user_1', kind: 'user', scopes: ['tasks:read', 'tasks:write'], name: 'a@b.test' })
    expect(result?.expiresAt).toBeGreaterThan(Date.now() / 1000)
  })

  it('finds the JWKS by OIDC discovery when no jwksUri is given', async () => {
    const issuer = await createIssuer('https://issuer.test')
    const claims = await verifyJwt(await issuer.sign({ sub: 'user_1' }), { issuer: issuer.url, fetch: issuer.fetch })
    expect(claims.sub).toBe('user_1')
  })

  it('rejects a forged signature, a foreign issuer, a wrong audience and an expired token', async () => {
    const issuer = await createIssuer('https://issuer.test')
    const other = await createIssuer('https://issuer.test') // same URL, different key
    const options = { issuer: issuer.url, jwksUri: `${issuer.url}/jwks`, fetch: issuer.fetch }

    const forged = await other.sign({ sub: 'user_1' })
    await expect(verifyJwt(forged, options)).rejects.toThrow(/signature is invalid/)

    const foreign = await issuer.sign({ sub: 'user_1', iss: 'https://evil.test' })
    await expect(verifyJwt(foreign, options)).rejects.toThrow(/issuer .* is not accepted/)

    const token = await issuer.sign({ sub: 'user_1', aud: 'other-api' })
    await expect(verifyJwt(token, { ...options, audience: 'my-api' })).rejects.toThrow(/audience is not accepted/)

    const expired = await issuer.sign({ sub: 'user_1', exp: Math.floor(Date.now() / 1000) - 3600 })
    await expect(verifyJwt(expired, options)).rejects.toThrow(/has expired/)

    const endless = await issuer.sign({ sub: 'user_1', exp: undefined })
    await expect(verifyJwt(endless, options)).rejects.toThrow(/no expiry/)
  })

  it('refuses `alg: none` and any algorithm the app did not allow', async () => {
    const issuer = await createIssuer('https://issuer.test')
    const options = { issuer: issuer.url, jwksUri: `${issuer.url}/jwks`, fetch: issuer.fetch }
    const unsigned = `${encodeJson({ alg: 'none', typ: 'JWT' })}.${encodeJson({ sub: 'root', iss: issuer.url })}.`
    await expect(verifyJwt(unsigned, options)).rejects.toThrow(/algorithm "none" is not supported/)

    const token = await issuer.sign({ sub: 'user_1' })
    await expect(verifyJwt(token, { ...options, algorithms: ['ES256'] })).rejects.toThrow(/is not accepted by this app/)
  })

  it('rejects an unknown signing key rather than falling through', async () => {
    const issuer = await createIssuer('https://issuer.test')
    const token = await issuer.sign({ sub: 'user_1' }, { kid: 'rotated-away' })
    await expect(verifyJwt(token, { issuer: issuer.url, jwksUri: `${issuer.url}/jwks`, fetch: issuer.fetch })).rejects.toThrow(
      /unknown key "rotated-away"/,
    )
  })

  it('declines a bearer that is not a JWT, so another adapter can have it', async () => {
    const issuer = await createIssuer('https://issuer.test')
    const adapter = jwtAdapter({ issuer: issuer.url, fetch: issuer.fetch })
    expect(await adapter.authenticate(ctx('tasks_opaque_key'))).toBeNull()
    expect(await adapter.authenticate(ctx())).toBeNull()
  })

  it('caches the JWKS instead of fetching it per request', async () => {
    const issuer = await createIssuer('https://issuer.test')
    let fetches = 0
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches++
      return issuer.fetch(input, init)
    }) as typeof fetch
    const adapter = jwtAdapter({ issuer: issuer.url, jwksUri: `${issuer.url}/jwks`, fetch: counting })
    for (let i = 0; i < 5; i++) await adapter.authenticate(ctx(await issuer.sign({ sub: 'user_1' })))
    expect(fetches).toBe(1)
  })

  it('reads scopes from scope, scp and permissions, and a client-credentials token is a service', () => {
    expect(scopesFromClaims({ scope: 'a b', scp: ['c'], permissions: ['d', 'a'] })).toEqual(['a', 'b', 'c', 'd'])
    expect(principalFromClaims({ sub: 'svc_1', client_id: 'svc_1' })?.kind).toBe('service')
    expect(principalFromClaims({})).toBeNull()
  })
})

describe('provider adapters', () => {
  it('clerk verifies the instance token and reads org permissions', async () => {
    const issuer = await createIssuer('https://clerk.acme.test')
    const adapter = clerkAdapter({ issuer: issuer.url, jwksUri: `${issuer.url}/jwks`, fetch: issuer.fetch })
    const token = await issuer.sign({ sub: 'user_2abc', sid: 'sess_1', azp: 'https://app.acme.test', o: { id: 'org_1', per: 'tasks:read,tasks:write' } })
    const result = await adapter.authenticate(ctx(token))
    expect(result?.principal).toEqual({ id: 'user_2abc', kind: 'user', scopes: ['tasks:read', 'tasks:write'] })
  })

  it('clerk refuses a token minted for another authorized party', async () => {
    const issuer = await createIssuer('https://clerk.acme.test')
    const adapter = clerkAdapter({
      issuer: issuer.url,
      jwksUri: `${issuer.url}/jwks`,
      fetch: issuer.fetch,
      authorizedParties: ['https://app.acme.test'],
    })
    const token = await issuer.sign({ sub: 'user_2abc', azp: 'https://phishing.test' })
    await expect(adapter.authenticate(ctx(token))).rejects.toThrow(/authorized party/)
  })

  it('workos derives its JWKS URL from the client id and reads permissions', async () => {
    const issuer = await createIssuer('https://api.workos.com/user_management/client_test')
    const adapter = workosAdapter({ clientId: 'client_test', fetch: issuer.fetch })
    const token = await issuer.sign({ sub: 'user_01H', sid: 'session_1', org_id: 'org_1', role: 'admin', permissions: ['tasks:read'] })
    const result = await adapter.authenticate(ctx(token))
    expect(result?.principal).toEqual({ id: 'user_01H', kind: 'user', scopes: ['tasks:read'] })
    expect(workOsJwksUri('client_test')).toBe('https://api.workos.com/sso/jwks/client_test')
  })
})

describe('better auth adapter', () => {
  const session = {
    user: { id: 'user_ba', name: 'Ada', email: 'ada@acme.test', scopes: ['tasks:read'] },
    session: { id: 'sess_1', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  }
  /** What a Better Auth server instance exposes, typed structurally. */
  const instance = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const bearer = headers.get('authorization') === 'Bearer sess_token'
        const cookie = headers.get('cookie')?.includes('better-auth.session_token=sess_token')
        return bearer || cookie ? session : null
      },
    },
  }

  it('reads a session from a Better Auth instance, by bearer or by cookie', async () => {
    const adapter = betterAuthAdapter({ auth: instance })
    const byBearer = await adapter.authenticate(ctx('sess_token'))
    expect(byBearer?.principal).toEqual({ id: 'user_ba', kind: 'user', scopes: ['tasks:read'], name: 'Ada' })
    expect(byBearer?.expiresAt).toBeGreaterThan(Date.now() / 1000)

    const headers = new Headers({ cookie: 'better-auth.session_token=sess_token' })
    const byCookie = await adapter.authenticate({ facet: 'rest', requestId: 'req_1', headers })
    expect(byCookie?.principal.id).toBe('user_ba')
  })

  it('declines when there is no session, and when there is nothing to send', async () => {
    const adapter = betterAuthAdapter({ auth: instance })
    expect(await adapter.authenticate(ctx('nope'))).toBeNull()
    expect(await adapter.authenticate({ facet: 'cli', requestId: 'req_1' })).toBeNull()
  })

  it('reads the same session over HTTP when the auth server is another process', async () => {
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url !== 'https://auth.acme.test/api/auth/get-session') return new Response('not found', { status: 404 })
      const headers = new Headers(init?.headers)
      return headers.get('authorization') === 'Bearer sess_token' ? Response.json(session) : new Response(null, { status: 401 })
    }) as typeof fetch
    const adapter = betterAuthAdapter({ baseUrl: 'https://auth.acme.test', fetch: fetchFn })
    expect((await adapter.authenticate(ctx('sess_token')))?.principal.id).toBe('user_ba')
    expect(await adapter.authenticate(ctx('other'))).toBeNull()
  })

  it('needs an instance or a base URL', () => {
    expect(() => betterAuthAdapter({})).toThrow(/either `auth`/)
  })
})

// ---------------------------------------------------------------------------------------------
// The plugin: several providers on one app, in the pipeline every facet runs.

const KEY = 'tasks_live_key'

async function appWith(adapters: AuthAdapter[], options: { onUnknownCredential?: 'reject' | 'anonymous' } = {}) {
  const store = memoryKeyStore()
  const keys = apiKeys({
    store,
    authenticate: false,
    keys: [{ key: KEY, principalId: 'user_key', scopes: ['tasks:read'] }],
  })
  const f = facet({
    plugins: [auth({ adapters: [keys.adapter, ...adapters], ...options }), keys, scopes()],
  })
  return f.app({
    name: 'authtest',
    ops: {
      whoAmI: f
        .op({ output: z.object({ id: z.string(), kind: z.string(), scopes: z.array(z.string()), adapter: z.string().nullable() }) })
        .traits({ readonly: true, scope: 'tasks:read' })
        .handle(({ principal, ctx: c }) => ({
          id: principal.id,
          kind: principal.kind,
          scopes: principal.scopes,
          adapter: c.auth?.adapter ?? null,
        })),
      open: f
        .op({ output: z.object({ ok: z.boolean() }) })
        .traits({ readonly: true, public: true })
        .handle(() => ({ ok: true })),
    },
  })
}

describe('auth() over several adapters', () => {
  it('lets each adapter take the credentials it recognises', async () => {
    const issuer = await createIssuer('https://issuer.test')
    const app = await appWith([jwtAdapter({ issuer: issuer.url, fetch: issuer.fetch })])

    const byKey = (await app.invoke('whoAmI', {}, { facet: 'rest', credential: { type: 'bearer', token: KEY } })) as any
    expect(byKey).toEqual({ id: 'user_key', kind: 'user', scopes: ['tasks:read'], adapter: 'api-key' })

    const jwt = await issuer.sign({ sub: 'user_jwt', scope: 'tasks:read' })
    const byJwt = (await app.invoke('whoAmI', {}, { facet: 'rest', credential: { type: 'bearer', token: jwt } })) as any
    expect(byJwt).toEqual({ id: 'user_jwt', kind: 'user', scopes: ['tasks:read'], adapter: 'jwt' })
  })

  it('rejects a credential nobody recognises instead of quietly downgrading it', async () => {
    const app = await appWith([])
    await expect(app.invoke('open', {}, { facet: 'rest', credential: { type: 'bearer', token: 'garbage' } })).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    const lenient = await appWith([], { onUnknownCredential: 'anonymous' })
    await expect(lenient.invoke('open', {}, { facet: 'rest', credential: { type: 'bearer', token: 'garbage' } })).resolves.toEqual({
      ok: true,
    })
  })

  it('leaves an anonymous call anonymous, and a scoped op still refuses it', async () => {
    const app = await appWith([])
    await expect(app.invoke('open', {}, { facet: 'cli' })).resolves.toEqual({ ok: true })
    await expect(app.invoke('whoAmI', {}, { facet: 'cli' })).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it("renders a provider outage as internal, not as 'your credential is bad'", async () => {
    const broken: AuthAdapter = {
      name: 'broken',
      authenticate() {
        throw new TypeError('fetch failed')
      },
    }
    const app = await appWith([broken])
    const err = await app.invoke('open', {}, { facet: 'rest', credential: { type: 'bearer', token: 'x' } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FacetError)
    expect((err as FacetError).code).toBe('internal')
  })

  it('refuses an expired session even if the adapter returned one', async () => {
    const stale: AuthAdapter = {
      name: 'stale',
      authenticate: () => ({ principal: { id: 'u', kind: 'user', scopes: ['*'] }, expiresAt: Math.floor(Date.now() / 1000) - 10 }),
    }
    const app = await appWith([stale])
    await expect(app.invoke('open', {}, { facet: 'rest', credential: { type: 'bearer', token: 'x' } })).rejects.toThrow(/expired/)
  })

  it('carries a cookie session from the REST facet all the way to the adapter', async () => {
    const cookieOnly: AuthAdapter = {
      name: 'cookie',
      authenticate: (c) =>
        c.headers?.get('cookie')?.includes('session=good')
          ? { principal: { id: 'user_cookie', kind: 'user', scopes: ['tasks:read'] } }
          : null,
    }
    const app = await appWith([cookieOnly], { onUnknownCredential: 'anonymous' })
    const rest = createRestApp(app)
    const res = await rest.fetch(new Request('http://app.test/who-am-i', { headers: { cookie: 'session=good' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'user_cookie', adapter: 'cookie' })
  })

  it('refuses to be configured with no adapters, or two of the same name', () => {
    expect(() => auth({ adapters: [] })).toThrow(/at least one adapter/)
    const one = apiKeyAdapter({ store: memoryKeyStore() })
    expect(() => auth({ adapters: [one, one] })).toThrow(/two adapters named/)
  })
})

describe('apiKeys as one provider among several', () => {
  it('declines an unknown key as an adapter but rejects one as the sole authenticator', async () => {
    const store = memoryKeyStore()
    const adapter = apiKeyAdapter({ store, keys: [{ key: KEY, principalId: 'user_key', scopes: ['*'] }] })
    expect(await adapter.authenticate(ctx('not-a-key'))).toBeNull()
    expect((await adapter.authenticate(ctx(KEY)))?.principal.id).toBe('user_key')

    const plugin = apiKeys({ store, keys: [{ key: KEY, principalId: 'user_key', scopes: ['*'] }] })
    await expect(plugin.hooks!.authenticate!({ credential: { type: 'bearer', token: 'not-a-key' }, facet: 'rest', requestId: 'r' } as never)).rejects.toThrow(
      /Invalid or revoked API key/,
    )
  })

  it('rejects a revoked key rather than declining it', async () => {
    const store = memoryKeyStore()
    const adapter = apiKeyAdapter({ store, keys: [{ key: KEY, principalId: 'user_key', scopes: ['*'] }] })
    await adapter.authenticate(ctx(KEY))
    expect(await store.revoke('key_seed_0', 'user_key')).toBe(true)
    await expect(adapter.authenticate(ctx(KEY))).rejects.toThrow(/revoked/)
  })
})
