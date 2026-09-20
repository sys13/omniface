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
