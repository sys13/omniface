import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { apiKeyStoreCases } from '@omniface/testing'
import { apiKeyTableSql, fileKeyStore, memoryKeyStore, sqlKeyStore, type ApiKeyStore, type SqlQuery } from 'omniface/plugins'

const dir = mkdtempSync(join(tmpdir(), 'facet-keystore-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let seq = 0
const tmpFile = () => join(dir, `keys-${++seq}.json`)

/** `node:sqlite` is the driver every supported runtime has; if this one does not, say so and move on. */
const sqlite = await import('node:sqlite').catch(() => undefined)

function sqliteStore(): ApiKeyStore {
  const { DatabaseSync } = sqlite as typeof import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec(apiKeyTableSql())
  const query: SqlQuery = async (sql, params) => {
    const statement = db.prepare(sql)
    const bound = params as never[]
    return sql.trimStart().toUpperCase().startsWith('SELECT') ? statement.all(...bound) : (statement.run(...bound), [])
  }
  return sqlKeyStore({ query })
}

const implementations: Record<string, () => ApiKeyStore> = {
  memoryKeyStore: () => memoryKeyStore(),
  fileKeyStore: () => fileKeyStore({ path: tmpFile() }),
  ...(sqlite ? { 'sqlKeyStore (node:sqlite)': sqliteStore } : {}),
}

// Every store answers the same way, or auth means something different depending on where the
// keys happen to live. The cases come from @omniface/testing, not from this file.
describe.each(Object.keys(implementations))('%s', (name) => {
  for (const c of apiKeyStoreCases({ store: implementations[name]! })) {
    it(c.name, async () => expect(await c.run()).toEqual([]))
  }
})

it.skipIf(sqlite)('node:sqlite is unavailable, so the SQL store ran against no driver', () => {})

describe('fileKeyStore', () => {
  it('creates the file on first write and keeps only hashes in it', async () => {
    const path = tmpFile()
    const store = fileKeyStore({ path })
    await store.insert({
      id: 'key_1',
      name: 'CI',
      hash: 'sha256-of-the-secret',
      prefix: 'tasks_ab',
      scopes: ['tasks:read'],
      principal: { id: 'user_1', kind: 'service' },
      createdAt: new Date().toISOString(),
    })
    const text = readFileSync(path, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ version: 1, keys: [{ id: 'key_1' }] })
    expect(text).not.toContain('tasks_abcdef')
  })

  it('survives a restart: a second store over the same file sees the first one’s keys', async () => {
    const path = tmpFile()
    const first = fileKeyStore({ path })
    await first.insert({
      id: 'key_1',
      name: 'CI',
      hash: 'h',
      prefix: 'p',
      scopes: ['*'],
      principal: { id: 'user_1', kind: 'user' },
      createdAt: new Date().toISOString(),
    })
    const second = fileKeyStore({ path })
    expect((await second.findByHash('h'))?.id).toBe('key_1')
    expect(await second.revoke('key_1', 'user_1')).toBe(true)
    expect((await first.findByHash('h'))?.revokedAt).toBeTruthy()
  })
})

describe('sqlKeyStore', () => {
  it('numbers its placeholders for Postgres when asked', async () => {
    const seen: string[] = []
    const store = sqlKeyStore({ query: async (sql) => (seen.push(sql), []), placeholders: '$n' })
    await store.findByHash('h')
    expect(seen[0]).toContain('WHERE hash = $1')
  })

  it('refuses a table name it would have to interpolate unsafely', () => {
    expect(() => sqlKeyStore({ query: async () => [], table: 'keys; DROP TABLE users' })).toThrow(/plain SQL identifier/)
    expect(() => apiKeyTableSql('keys--')).toThrow(/plain SQL identifier/)
  })

  it('unwraps a driver that returns { rows }', async () => {
    const row = {
      id: 'key_1',
      name: 'CI',
      hash: 'h',
      prefix: 'p',
      scopes: JSON.stringify(['*']),
      principal_id: 'user_1',
      principal_kind: 'service',
      principal_name: null,
      created_at: '2024-01-01T00:00:00.000Z',
      revoked_at: null,
    }
    const store = sqlKeyStore({ query: async () => ({ rows: [row] }) })
    expect(await store.findByHash('h')).toEqual({
      id: 'key_1',
      name: 'CI',
      hash: 'h',
      prefix: 'p',
      scopes: ['*'],
      principal: { id: 'user_1', kind: 'service' },
      createdAt: '2024-01-01T00:00:00.000Z',
    })
  })
})
