import { describe, expect, it, vi } from 'vitest'
import { facet } from '../src/index.ts'
import { apiKeyAdapter, auth } from '../src/auth/index.ts'
import { apiKeys, hashApiKey, memoryKeyStore, neverGrantedScopes, scopes } from '../src/plugins/index.ts'

// Deleting dead keys, an accurate revokeAll count, legacy scopes stripped at authentication, and
// the MCP client's announced name as the key's last-used client.

const KEY = 'tasks_live_key'
const seed = [{ key: KEY, principalId: 'user_key', scopes: ['*'] }]
const owner = { facet: 'rest', credential: { type: 'bearer', token: KEY } } as never
const ctx = (token: string) => ({ facet: 'rest' as const, requestId: 'req_test', credential: { type: 'bearer' as const, token } })

const build = (options: Parameters<typeof apiKeys>[0] = {}) => {
  const plugin = apiKeys({ keys: seed, delete: true, ...options })
  const f = facet({ plugins: [plugin, scopes()] })
  return { app: f.app({ name: 'cleanup', ops: {} }), store: plugin.store }
}
type Built = ReturnType<typeof build>
const mint = async (app: Built['app'], scopes = ['tasks:read']) =>
  (await app.invoke('apiKeys.create', { name: 'k', scopes }, owner)) as { id: string; key: string }
const expire = async (store: Built['store'], key: string) => {
  const row = (await store.findByHash(hashApiKey(key)))!
  await store.insert({ ...row, expiresAt: new Date(Date.now() - 1000).toISOString() })
}

describe('apiKeys.delete', () => {
  it('deletes revoked and expired keys, and refuses an active one', async () => {
    const { app, store } = build()
    const active = await mint(app)
    const revoked = await mint(app)
    const expired = await mint(app)
    await app.invoke('apiKeys.revoke', { id: revoked.id }, owner)
    await expire(store, expired.key)

    await expect(app.invoke('apiKeys.delete', { id: active.id }, owner)).rejects.toMatchObject({ code: 'conflict' })
    expect(await app.invoke('apiKeys.delete', { id: revoked.id }, owner)).toEqual({ id: revoked.id, deleted: true })
    expect(await app.invoke('apiKeys.delete', { id: expired.id }, owner)).toEqual({ id: expired.id, deleted: true })
    await expect(app.invoke('apiKeys.delete', { id: revoked.id }, owner)).rejects.toMatchObject({ code: 'not_found' })
    const ids = ((await app.invoke('apiKeys.list', {}, owner)) as { items: { id: string }[] }).items.map((k) => k.id)
    expect(ids).toContain(active.id)
    expect(ids).not.toContain(revoked.id)
    expect(ids).not.toContain(expired.id)
  })

  it("cannot delete another principal's key", async () => {
    const { app, store } = build()
    const theirs = await mint(app)
    const row = (await store.findByHash(hashApiKey(theirs.key)))!
    await store.insert({ ...row, principal: { id: 'someone_else', kind: 'user' }, revokedAt: new Date().toISOString() })
    await expect(app.invoke('apiKeys.delete', { id: theirs.id }, owner)).rejects.toMatchObject({ code: 'not_found' })
    expect(await store.findByHash(hashApiKey(theirs.key))).toBeTruthy()
  })

  it('is destructive and needs apiKeys:write', async () => {
    const { app } = build({ keys: [...seed, { key: 'reader_key', principalId: 'user_key', scopes: ['apiKeys:read'] }] })
    const reader = { facet: 'rest', credential: { type: 'bearer', token: 'reader_key' } } as never
    await expect(app.invoke('apiKeys.delete', { id: 'key_x' }, reader)).rejects.toMatchObject({ code: 'forbidden' })
    expect(apiKeys({ delete: true }).ops!.apiKeys.delete.traits).toMatchObject({ destructive: true, scope: 'apiKeys:write' })
  })

  it('is absent unless asked for', async () => {
    const app = facet({ plugins: [apiKeys({ keys: seed }), scopes()] }).app({ name: 'plain', ops: {} })
    await expect(app.invoke('apiKeys.delete', { id: 'key_x' }, owner)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('apiKeys.revokeAll', () => {
  it('counts only live keys and leaves expired ones alone', async () => {
    const { app, store } = build({ revokeAll: true })
    const expired = await mint(app)
    await expire(store, expired.key)
    // The seed key and nothing else: the expired key is already dead.
    expect(await app.invoke('apiKeys.revokeAll', {}, owner)).toEqual({ revoked: 1 })
    expect((await store.findByHash(hashApiKey(expired.key)))?.revokedAt).toBeUndefined()
  })
})

describe('never-granted scopes on existing keys', () => {
  it('strips them from minted keys at authentication, not from seed keys', async () => {
    const store = memoryKeyStore()
    const adapter = apiKeyAdapter({ store, keys: seed, neverGrant: ['*', 'automations:write'] })
    const legacy = (scopes: string[], token: string) =>
      store.insert({
        id: `key_${token}`,
        name: token,
        hash: hashApiKey(token),
        prefix: token.slice(0, 8),
        scopes,
        principal: { id: 'user_key', kind: 'user' },
        createdAt: new Date().toISOString(),
      })
    await legacy(['*'], 'legacy_star')
    await legacy(['goals:read', 'automations:write'], 'legacy_auto')
    await legacy(['goals:read', 'automations:*'], 'legacy_wild')
    const scopesOf = async (token: string) => (await adapter.authenticate(ctx(token)))?.principal.scopes
    expect(await scopesOf('legacy_star')).toEqual([])
    expect(await scopesOf('legacy_auto')).toEqual(['goals:read'])
    expect(await scopesOf('legacy_wild')).toEqual(['goals:read'])
    expect(await scopesOf(KEY)).toEqual(['*'])
    // The record is untouched: stripping is a view, so a startup check can still find the row.
    expect((await store.findByHash(hashApiKey('legacy_star')))?.scopes).toEqual(['*'])
  })

  it('applies the plugin neverGrant to its own adapter', async () => {
    const plugin = apiKeys({ neverGrant: ['admin'] })
    await plugin.store.insert({
      id: 'key_old',
      name: 'old',
      hash: hashApiKey('old_key'),
      prefix: 'old_key',
      scopes: ['admin', 'tasks:read'],
      principal: { id: 'u', kind: 'user' },
      createdAt: new Date().toISOString(),
    })
    expect((await plugin.adapter.authenticate(ctx('old_key')))?.principal.scopes).toEqual(['tasks:read'])
  })

  it('names the offending scopes of a key', () => {
    expect(neverGrantedScopes(['*', 'goals:read', 'automations:*'], ['*', 'automations:write'])).toEqual(['*', 'automations:*'])
    expect(neverGrantedScopes(['goals:read'], ['*', 'automations:write'])).toEqual([])
  })
})

describe('last-used client', () => {
  it('prefers the announced client name over the User-Agent, and hands the throttle to the store', async () => {
    const store = memoryKeyStore()
    const touch = vi.spyOn(store, 'touch')
    const adapter = apiKeyAdapter({ store, keys: seed, touchIntervalMs: 60_000 })
    await adapter.authenticate({
      ...ctx(KEY),
      headers: new Headers({ 'user-agent': 'node-fetch/3' }),
      client: { name: 'claude-code', version: '2.0.0' },
    })
    expect((await store.findByHash(hashApiKey(KEY)))?.lastUsedClient).toBe('claude-code')
    const [, at, , ifOlderThan] = touch.mock.calls[0]!
    expect(Date.parse(at) - Date.parse(ifOlderThan!)).toBe(60_000)
  })

  it('falls back to the User-Agent without a client name', async () => {
    const store = memoryKeyStore()
    const adapter = apiKeyAdapter({ store, keys: seed })
    await adapter.authenticate({ ...ctx(KEY), headers: new Headers({ 'user-agent': 'curl/8' }) })
    expect((await store.findByHash(hashApiKey(KEY)))?.lastUsedClient).toBe('curl/8')
  })

  it('reaches the adapter through auth() and through the apiKeys hook', async () => {
    for (const viaAuth of [true, false]) {
      const keys = apiKeys({ keys: seed, authenticate: !viaAuth })
      const plugins = viaAuth ? [auth({ adapters: [keys.adapter] }), keys, scopes()] : [keys, scopes()]
      const app = facet({ plugins }).app({ name: 'named', ops: {} })
      await app.invoke('apiKeys.list', {}, {
        facet: 'mcp',
        credential: { type: 'bearer', token: KEY },
        headers: new Headers({ 'user-agent': 'node' }),
        client: { name: 'claude-desktop' },
      })
      expect((await keys.store.findByHash(hashApiKey(KEY)))?.lastUsedClient, String(viaAuth)).toBe('claude-desktop')
    }
  })
})
