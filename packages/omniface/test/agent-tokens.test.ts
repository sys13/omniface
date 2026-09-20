import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { facet, type App } from '../src/index.ts'
import { agentTokens, apiKeys, auth, scopes } from '../src/plugins/index.ts'

// Backlog 12.8: the attenuated agent credential. The property under test is one sentence — a token
// minted for the agent in someone's browser carries strictly less than the person does — and every
// case here is a way that could fail to be true.

const KEYS = { admin: 'dev_admin', reader: 'dev_reader' }

function makeApp(options: { ceiling?: string[]; ttlSeconds?: number } = {}) {
  const keys = apiKeys({
    keys: [
      { key: KEYS.admin, principalId: 'user_admin', scopes: ['*'] },
      { key: KEYS.reader, principalId: 'user_reader', scopes: ['tasks:read'] },
    ],
    authenticate: false,
  })
  const agent = agentTokens({ ceiling: options.ceiling ?? ['tasks:read'], ttlSeconds: options.ttlSeconds ?? 300, authenticate: false })
  const f = facet({ plugins: [auth({ adapters: [keys.adapter, agent.adapter] }), keys, agent, scopes()] })

  const read = f
    .op({ input: z.object({}), output: z.object({ ok: z.boolean() }) })
    .traits({ readonly: true, scope: 'tasks:read' })
    .handle(() => ({ ok: true }))
  const write = f
    .op({ input: z.object({}), output: z.object({ ok: z.boolean() }) })
    .traits({ scope: 'tasks:write' })
    .handle(() => ({ ok: true }))

  return f.app({
    name: 'acme',
    ops: { tasks: { read, write } },
    facets: { rest: true, web: { agent: { allow: 'readonly', credential: 'attenuated' } } },
  }) as unknown as App<any>
}

const bearer = (token: string) => ({ type: 'bearer' as const, token })

const mint = async (app: App<any>, apiKey: string, input: Record<string, unknown> = {}) =>
  (await app.invoke('agentToken.mint', input, { facet: 'rest', credential: bearer(apiKey) })) as {
    token: string
    scopes: string[]
    expiresAt: string
  }

describe('a token can only ever narrow', () => {
  it('gives the ceiling by default, not what the person holds', async () => {
    const app = makeApp()
    const minted = await mint(app, KEYS.admin)
    // The admin holds `*`. The token does not.
    expect(minted.scopes).toEqual(['tasks:read'])
  })

  it('never exceeds what the caller holds, even inside the ceiling', async () => {
    const app = makeApp({ ceiling: ['tasks:read', 'tasks:write'] })
    const minted = await mint(app, KEYS.reader)
    expect(minted.scopes).toEqual(['tasks:read'])
  })

  it('refuses out loud when asked for something the caller cannot grant', async () => {
    const app = makeApp({ ceiling: ['tasks:read', 'tasks:write'] })
    await expect(mint(app, KEYS.reader, { scopes: ['tasks:write'] })).rejects.toThrow(/cannot carry: tasks:write/)
  })

  it('refuses anything outside the ceiling, whoever asks', async () => {
    const app = makeApp({ ceiling: ['tasks:read'] })
    await expect(mint(app, KEYS.admin, { scopes: ['tasks:write'] })).rejects.toThrow(/cannot carry/)
  })

  it('needs somebody to act for', async () => {
    const app = makeApp()
    await expect(app.invoke('agentToken.mint', {}, { facet: 'rest' })).rejects.toThrow(/Authentication required|Sign in/)
  })
})

describe('what the token then does', () => {
  it('authenticates as an agent acting for the person', async () => {
    const app = makeApp()
    const { token } = await mint(app, KEYS.admin)
    const who = (await app.invoke('tasks.read', {}, { facet: 'rest', credential: bearer(token) })) as { ok: boolean }
    expect(who).toEqual({ ok: true })
  })

  it('is refused for the op the person could have run', async () => {
    const app = makeApp()
    const { token } = await mint(app, KEYS.admin)
    await expect(app.invoke('tasks.write', {}, { facet: 'rest', credential: bearer(token) })).rejects.toThrow(
      /Missing required scope "tasks:write"/,
    )
    // The same person, with their own credential, is unaffected.
    await expect(app.invoke('tasks.write', {}, { facet: 'rest', credential: bearer(KEYS.admin) })).resolves.toEqual({ ok: true })
  })

  it('stops working when it expires', async () => {
    const app = makeApp({ ttlSeconds: -1 })
    const { token } = await mint(app, KEYS.admin)
    await expect(app.invoke('tasks.read', {}, { facet: 'rest', credential: bearer(token) })).rejects.toThrow(/expired/)
  })

  it('is not a way for an agent to refresh its own authority', async () => {
    const app = makeApp()
    // The mint op is not `readonly`, so the default agent declaration never advertises it, and
    // 12.7's gate refuses the call whether or not the page offered it.
    await expect(
      app.invoke('agentToken.mint', {}, { facet: 'webmcp', credential: bearer(KEYS.admin) }),
    ).rejects.toThrow(/not offered to browser agents/)
  })
})

describe('the app cannot ask for attenuation it has no way to do', () => {
  it('refuses to start when the plugin that mints is missing', () => {
    const f = facet({ plugins: [scopes({ requireAuth: false })] })
    const ping = f.op({ input: z.object({}), output: z.object({ ok: z.boolean() }) }).traits({ readonly: true, public: true }).handle(() => ({ ok: true }))
    expect(() =>
      f.app({ name: 'acme', ops: { ping }, facets: { web: { agent: { credential: 'attenuated' } } } }),
    ).toThrow(/needs the agentTokens\(\) plugin/)
  })
})
