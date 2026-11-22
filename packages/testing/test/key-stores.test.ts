import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, describe, expect, it } from 'vitest'
import { apiKeyTableSql, fileKeyStore, memoryKeyStore, sqlKeyStore, type ApiKeyStore } from 'omniface/plugins'
import { apiKeyStoreCases } from '../src/index.ts'

// Every key store that ships with omniface runs the same conformance cases: memory, a JSON file,
// and SQL in both placeholder styles (Postgres via PGlite, SQLite via node:sqlite). A fresh table
// or file per case, so no case sees another's rows.

const run = (name: string, store: () => ApiKeyStore | Promise<ApiKeyStore>) =>
  describe(`${name} key store`, () => {
    for (const c of apiKeyStoreCases({ store })) it(c.name, async () => expect(await c.run()).toEqual([]))
  })

run('memory', () => memoryKeyStore())

const dir = mkdtempSync(join(tmpdir(), 'omniface-keys-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0
run('file', () => fileKeyStore({ path: join(dir, `keys-${++files}.json`) }))

const pg = new PGlite()
afterAll(() => pg.close())
let pgTables = 0
run('sql (Postgres, PGlite)', async () => {
  const table = `keys_${++pgTables}`
  await pg.exec(apiKeyTableSql(table))
  return sqlKeyStore({ table, placeholders: '$n', query: (sql, params) => pg.query(sql, params) })
})

const sqlite = new DatabaseSync(':memory:')
afterAll(() => sqlite.close())
let liteTables = 0
run('sql (SQLite, node:sqlite)', () => {
  const table = `keys_${++liteTables}`
  sqlite.exec(apiKeyTableSql(table))
  return sqlKeyStore({
    table,
    query: async (sql, params) => sqlite.prepare(sql).all(...(params as (string | null)[])),
  })
})
