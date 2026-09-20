import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ApiKeyRecord, ApiKeyStore } from './api-keys.ts'

/**
 * Durable {@link ApiKeyStore} implementations.
 *
 * Neither adds a dependency. The file store is for single-process apps and dev; the SQL store
 * takes a `query` callback, so it runs on `node:sqlite`, `pg`, `mysql2`, libsql or anything else
 * that can answer parameterised SQL — facet never imports a driver.
 */

// ---------------------------------------------------------------------------------------------
// File

export type FileKeyStoreOptions = {
  /** JSON file holding the records. Created, with its directory, on first write. */
  path: string
}

type FileShape = { version: 1; keys: ApiKeyRecord[] }

/**
 * Keys in one JSON file, written atomically (temp file plus rename) and serialised so concurrent
 * writes cannot interleave. Only the SHA-256 of each key is ever stored, so the file is not a
 * secret — but it is still an identity ledger, and should not be world-readable.
 */
export function fileKeyStore(options: FileKeyStoreOptions): ApiKeyStore {
  const { path } = options
  let queue: Promise<unknown> = Promise.resolve()

  const load = (): ApiKeyRecord[] => {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    if (!text.trim()) return []
    const doc = JSON.parse(text) as FileShape
    return Array.isArray(doc.keys) ? doc.keys : []
  }

  const save = (keys: ApiKeyRecord[]): void => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, keys } satisfies FileShape, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
  }

  /** Every mutation reads, edits and writes as one step, in order. */
  const mutate = <T>(fn: (keys: ApiKeyRecord[]) => { keys?: ApiKeyRecord[]; result: T }): Promise<T> => {
    const next = queue.then(() => {
      const { keys, result } = fn(load())
      if (keys) save(keys)
      return result
    })
    queue = next.catch(() => {})
    return next
  }

  return {
    async findByHash(hash) {
      return mutate((keys) => ({ result: keys.find((k) => k.hash === hash) }))
    },
    async insert(record) {
      await mutate((keys) => ({ keys: [...keys.filter((k) => k.id !== record.id), record], result: undefined }))
    },
    async listFor(principalId) {
      return mutate((keys) => ({ result: keys.filter((k) => k.principal.id === principalId) }))
    },
    async revoke(id, principalId) {
      return mutate((keys) => {
        const row = keys.find((k) => k.id === id)
        if (!row || row.principal.id !== principalId || row.revokedAt) return { result: false }
        const revoked = { ...row, revokedAt: new Date().toISOString() }
        return { keys: keys.map((k) => (k.id === id ? revoked : k)), result: true }
      })
    },
  }
}

// ---------------------------------------------------------------------------------------------
// SQL

/** One parameterised query. Return the rows; a driver that wraps them in `{ rows }` is unwrapped. */
export type SqlQuery = (sql: string, params: unknown[]) => Promise<unknown>

export type SqlKeyStoreOptions = {
  query: SqlQuery
  /** Default `facet_api_keys`. Must be a plain identifier: it is interpolated, not parameterised. */
  table?: string
  /** `?` for SQLite and MySQL (the default), `$n` for Postgres. */
  placeholders?: '?' | '$n'
}

export const DEFAULT_API_KEY_TABLE = 'facet_api_keys'

/** The DDL the SQL store expects. Run it yourself, in whatever migration tool the app uses. */
export function apiKeyTableSql(table: string = DEFAULT_API_KEY_TABLE): string {
  assertIdentifier(table)
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  id TEXT PRIMARY KEY,',
    '  name TEXT NOT NULL,',
    '  hash TEXT NOT NULL UNIQUE,',
    '  prefix TEXT NOT NULL,',
    '  scopes TEXT NOT NULL,',
    '  principal_id TEXT NOT NULL,',
    '  principal_kind TEXT NOT NULL,',
    '  principal_name TEXT,',
    '  created_at TEXT NOT NULL,',
    '  revoked_at TEXT',
    ');',
    `CREATE INDEX IF NOT EXISTS ${table}_hash_idx ON ${table} (hash);`,
    `CREATE INDEX IF NOT EXISTS ${table}_principal_idx ON ${table} (principal_id);`,
  ].join('\n')
}

function assertIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`facet: "${name}" is not a plain SQL identifier; table names are interpolated, not parameterised`)
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const rows = (result as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

function toRecord(row: Record<string, unknown>): ApiKeyRecord {
  const scopes = row.scopes
  const principalName = row.principal_name
  return {
    id: String(row.id),
    name: String(row.name),
    hash: String(row.hash),
    prefix: String(row.prefix),
    scopes: typeof scopes === 'string' ? (JSON.parse(scopes) as string[]) : Array.isArray(scopes) ? (scopes as string[]) : [],
    principal: {
      id: String(row.principal_id),
      kind: String(row.principal_kind) as ApiKeyRecord['principal']['kind'],
      ...(typeof principalName === 'string' && principalName ? { name: principalName } : {}),
    },
    createdAt: String(row.created_at),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
  }
}

/**
 * Keys in a SQL table, over a driver-agnostic `query` callback:
 *
 * ```ts
 * import { DatabaseSync } from 'node:sqlite'
 * const db = new DatabaseSync('keys.db')
 * db.exec(apiKeyTableSql())
 * const store = sqlKeyStore({ query: async (sql, params) => db.prepare(sql).all(...params) })
 * ```
 *
 * The table is created by `apiKeyTableSql()`, not by this function: schema changes belong to the
 * app's migrations, not to a plugin's first request.
 */
export function sqlKeyStore(options: SqlKeyStoreOptions): ApiKeyStore {
  const table = options.table ?? DEFAULT_API_KEY_TABLE
  assertIdentifier(table)
  const numbered = options.placeholders === '$n'
  /** `p(3)` → `?, ?, ?` or `$1, $2, $3`. */
  const p = (count: number, from = 1) =>
    Array.from({ length: count }, (_, i) => (numbered ? `$${from + i}` : '?')).join(', ')
  const run = async (sql: string, params: unknown[]) => rowsOf(await options.query(sql, params))

  const COLUMNS = 'id, name, hash, prefix, scopes, principal_id, principal_kind, principal_name, created_at, revoked_at'

  return {
    async findByHash(hash) {
      const rows = await run(`SELECT ${COLUMNS} FROM ${table} WHERE hash = ${p(1)}`, [hash])
      return rows[0] ? toRecord(rows[0]) : undefined
    },
    async insert(record) {
      // Insert or replace by id: re-seeding the same startup keys must not fail.
      await options.query(`DELETE FROM ${table} WHERE id = ${p(1)}`, [record.id])
      await options.query(
        `INSERT INTO ${table} (${COLUMNS}) VALUES (${p(10)})`,
        [
          record.id,
          record.name,
          record.hash,
          record.prefix,
          JSON.stringify(record.scopes),
          record.principal.id,
          record.principal.kind,
          record.principal.name ?? null,
          record.createdAt,
          record.revokedAt ?? null,
        ],
      )
    },
    async listFor(principalId) {
      const rows = await run(
        `SELECT ${COLUMNS} FROM ${table} WHERE principal_id = ${p(1)} ORDER BY created_at ASC`,
        [principalId],
      )
      return rows.map(toRecord)
    },
    async revoke(id, principalId) {
      // A conditional UPDATE does the work, so two racing revokes cannot both stamp the row.
      // Drivers disagree about how they report affected rows, so the stamp we wrote is what we
      // read back — and because two revokes in the same millisecond would write the same string,
      // an already-revoked row is answered before the UPDATE runs at all.
      const existing = await run(`SELECT revoked_at, principal_id FROM ${table} WHERE id = ${p(1)}`, [id])
      if (!existing[0] || existing[0].revoked_at || existing[0].principal_id !== principalId) return false
      const stamp = new Date().toISOString()
      await options.query(
        `UPDATE ${table} SET revoked_at = ${numbered ? '$1' : '?'} ` +
          `WHERE id = ${numbered ? '$2' : '?'} AND principal_id = ${numbered ? '$3' : '?'} AND revoked_at IS NULL`,
        [stamp, id, principalId],
      )
      const rows = await run(`SELECT revoked_at FROM ${table} WHERE id = ${p(1)}`, [id])
      return rows[0]?.revoked_at === stamp
    },
  }
}
