import type { ApiKeyRecord, ApiKeyStore } from 'omniface/plugins'

/**
 * Conformance for a store, not for a facet.
 *
 * `ApiKeyStore` is an extension point: the built-in store is in memory, and anything durable —
 * a file, a SQL table, a KV service — has to behave identically or auth behaves differently
 * depending on where keys happen to live. These are the cases that say what "identically" means,
 * written once and run against every implementation:
 *
 * ```ts
 * for (const c of apiKeyStoreCases({ store: () => sqlKeyStore({ query }) })) {
 *   it(c.name, async () => expect(await c.run()).toEqual([]))
 * }
 * ```
 */

export type ApiKeyStoreCaseOptions = {
  /** A fresh, empty store per case, so one case's writes cannot reach another's. */
  store: () => ApiKeyStore | Promise<ApiKeyStore>
}

export type StoreCase = {
  name: string
  /** Empty means the store conformed. Each entry is one human-readable problem. */
  run: () => Promise<string[]>
}

let seq = 0
function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  const n = ++seq
  return {
    id: `key_${n}`,
    name: `key ${n}`,
    hash: `hash_${n}`,
    prefix: 'tst_abcd',
    scopes: ['tasks:read'],
    principal: { id: 'user_1', kind: 'user' },
    createdAt: new Date(1700000000000 + n).toISOString(),
    ...overrides,
  }
}

const eq = (what: string, actual: unknown, expected: unknown): string[] =>
  JSON.stringify(actual) === JSON.stringify(expected) ? [] : [`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`]

export function apiKeyStoreCases(options: ApiKeyStoreCaseOptions): StoreCase[] {
  const fresh = async () => options.store()
  const wrap = (name: string, run: (store: ApiKeyStore) => Promise<string[]>): StoreCase => ({
    name: `api key store · ${name}`,
    run: async () => {
      try {
        return await run(await fresh())
      } catch (err) {
        return [`threw: ${err instanceof Error ? err.message : String(err)}`]
      }
    },
  })

  return [
    wrap('an empty store finds nothing', async (store) => [
      ...eq('findByHash', await store.findByHash('hash_nope'), undefined),
      ...eq('listFor', await store.listFor('user_1'), []),
      ...eq('revoke', await store.revoke('key_nope', 'user_1'), false),
    ]),

    wrap('a record round-trips field for field', async (store) => {
      const row = record({ principal: { id: 'user_1', kind: 'service', name: 'CI' }, scopes: ['a', 'b:*'] })
      await store.insert(row)
      return eq('findByHash', await store.findByHash(row.hash), row)
    }),

    wrap('findByHash matches the hash, not the id or prefix', async (store) => {
      const row = record()
      await store.insert(row)
      return [
        ...eq('by id', await store.findByHash(row.id), undefined),
        ...eq('by prefix', await store.findByHash(row.prefix), undefined),
      ]
    }),

    wrap('listFor returns only that principal, revoked keys included', async (store) => {
      const mine = record({ principal: { id: 'user_1', kind: 'user' } })
      const alsoMine = record({ principal: { id: 'user_1', kind: 'user' } })
      const theirs = record({ principal: { id: 'user_2', kind: 'user' } })
      for (const row of [mine, alsoMine, theirs]) await store.insert(row)
      await store.revoke(alsoMine.id, 'user_1')
      const ids = (await store.listFor('user_1')).map((r) => r.id).sort()
      return [
        ...eq('ids', ids, [mine.id, alsoMine.id].sort()),
        ...eq('other principal', (await store.listFor('user_2')).map((r) => r.id), [theirs.id]),
      ]
    }),

    wrap('insert replaces by id, so re-seeding is not an error', async (store) => {
      const row = record()
      await store.insert(row)
      await store.insert({ ...row, name: 'renamed' })
      const rows = await store.listFor(row.principal.id)
      return [...eq('count', rows.length, 1), ...eq('name', rows[0]?.name, 'renamed')]
    }),

    wrap('revoke stamps the record and is not repeatable', async (store) => {
      const row = record()
      await store.insert(row)
      const first = await store.revoke(row.id, row.principal.id)
      const second = await store.revoke(row.id, row.principal.id)
      const found = await store.findByHash(row.hash)
      return [
        ...eq('first revoke', first, true),
        ...eq('second revoke', second, false),
        ...(found?.revokedAt ? [] : ['the revoked record has no revokedAt']),
        // A revoked key is still findable: the caller decides what revoked means, not the store.
        ...(found ? [] : ['findByHash stopped finding the record once it was revoked']),
      ]
    }),

    wrap("revoke refuses another principal's key", async (store) => {
      const row = record({ principal: { id: 'user_1', kind: 'user' } })
      await store.insert(row)
      const stolen = await store.revoke(row.id, 'user_2')
      const found = await store.findByHash(row.hash)
      return [...eq('revoke', stolen, false), ...(found?.revokedAt ? ['the key was revoked anyway'] : [])]
    }),

    wrap('revokeAll revokes only that principal\'s active keys and counts them', async (store) => {
      const a = record()
      const b = record()
      const other = record({ principal: { id: 'user_2', kind: 'user' } })
      await Promise.all([a, b, other].map((r) => store.insert(r)))
      await store.revoke(a.id, 'user_1')
      const n = await store.revokeAll('user_1')
      const again = await store.revokeAll('user_1')
      const foundB = await store.findByHash(b.hash)
      const foundOther = await store.findByHash(other.hash)
      return [
        ...eq('first revokeAll', n, 1),
        ...eq('second revokeAll', again, 0),
        ...(foundB?.revokedAt ? [] : ['an active key was not revoked']),
        ...(foundOther?.revokedAt ? ["another principal's key was revoked"] : []),
      ]
    }),

    wrap('revokeAll leaves expired keys alone and does not count them', async (store) => {
      const live = record()
      const expired = record({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      const later = record({ expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
      for (const r of [live, expired, later]) await store.insert(r)
      const n = await store.revokeAll('user_1')
      return [
        ...eq('revokeAll', n, 2),
        ...((await store.findByHash(expired.hash))?.revokedAt ? ['an expired key was stamped revoked'] : []),
        ...((await store.findByHash(later.hash))?.revokedAt ? [] : ['a key expiring later was not revoked']),
      ]
    }),

    wrap('delete removes only that principal\'s key, once', async (store) => {
      const mine = record()
      const theirs = record({ principal: { id: 'user_2', kind: 'user' } })
      for (const r of [mine, theirs]) await store.insert(r)
      const stolen = await store.delete(theirs.id, 'user_1')
      const first = await store.delete(mine.id, 'user_1')
      const second = await store.delete(mine.id, 'user_1')
      return [
        ...eq('delete of another principal\'s key', stolen, false),
        ...eq('first delete', first, true),
        ...eq('second delete', second, false),
        ...eq('findByHash after delete', await store.findByHash(mine.hash), undefined),
        ...eq('listFor after delete', (await store.listFor('user_1')).map((r) => r.id), []),
        ...((await store.findByHash(theirs.hash)) ? [] : ["another principal's key was deleted"]),
        ...eq('delete of a missing key', await store.delete('key_nope', 'user_1'), false),
      ]
    }),

    wrap('touch with ifOlderThan writes only over an older or absent last use', async (store) => {
      const row = record()
      await store.insert(row)
      // Absent: written.
      await store.touch(row.id, '2026-01-01T00:00:30.000Z', 'a/1', '2026-01-01T00:00:00.000Z')
      // Last use 00:00:30 is not older than 00:00:10: skipped.
      await store.touch(row.id, '2026-01-01T00:01:10.000Z', 'b/1', '2026-01-01T00:00:10.000Z')
      // Copied: the memory store hands back its own objects.
      const kept = { ...(await store.findByHash(row.hash)) }
      // Last use 00:00:30 is older than 00:01:00: written.
      await store.touch(row.id, '2026-01-01T00:02:00.000Z', 'c/1', '2026-01-01T00:01:00.000Z')
      const moved = await store.findByHash(row.hash)
      return [
        ...eq('kept lastUsedAt', kept?.lastUsedAt, '2026-01-01T00:00:30.000Z'),
        ...eq('kept client', kept?.lastUsedClient, 'a/1'),
        ...eq('moved lastUsedAt', moved?.lastUsedAt, '2026-01-01T00:02:00.000Z'),
        ...eq('moved client', moved?.lastUsedClient, 'c/1'),
      ]
    }),

    wrap('touch records last use and the client', async (store) => {
      const row = record()
      await store.insert(row)
      await store.touch(row.id, '2026-01-01T00:00:00.000Z', 'agent/1')
      const found = await store.findByHash(row.hash)
      return [...eq('lastUsedAt', found?.lastUsedAt, '2026-01-01T00:00:00.000Z'), ...eq('client', found?.lastUsedClient, 'agent/1')]
    }),

    wrap('expiresAt round-trips', async (store) => {
      const row = record({ expiresAt: '2030-01-01T00:00:00.000Z' })
      await store.insert(row)
      return eq('expiresAt', (await store.findByHash(row.hash))?.expiresAt, '2030-01-01T00:00:00.000Z')
    }),

    wrap('concurrent inserts all land', async (store) => {
      const rows = Array.from({ length: 10 }, () => record())
      await Promise.all(rows.map((r) => store.insert(r)))
      const found = await store.listFor('user_1')
      return eq('count', found.length, rows.length)
    }),
  ]
}

/** Run every case and return only the failures. */
export async function runApiKeyStoreConformance(options: ApiKeyStoreCaseOptions): Promise<{ name: string; problems: string[] }[]> {
  const failures: { name: string; problems: string[] }[] = []
  for (const c of apiKeyStoreCases(options)) {
    const problems = await c.run()
    if (problems.length) failures.push({ name: c.name, problems })
  }
  return failures
}
