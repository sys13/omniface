import { createHash } from 'node:crypto'
import { errors } from '../errors.ts'
import { definePlugin, type Invocation } from '../plugin.ts'

/**
 * What a key remembers. `in_flight` is the reservation taken before the handler runs, so two calls
 * racing on one key cannot both reach it; `done` carries the output to replay.
 */
export type IdempotencyRecord = {
  key: string
  opId: string
  /** Hash of the *validated* input, so the same logical call hashes the same from every facet. */
  fingerprint: string
  status: 'in_flight' | 'done'
  output?: unknown
  /** Epoch ms the record was written. */
  at: number
}

export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined | Promise<IdempotencyRecord | undefined>
  /** Must not overwrite a record another caller reserved first; returns false when the key is taken. */
  reserve(record: IdempotencyRecord): boolean | Promise<boolean>
  commit(record: IdempotencyRecord): void | Promise<void>
  release(key: string): void | Promise<void>
}

export type MemoryIdempotencyStoreOptions = {
  /** How long a completed result stays replayable. Default 24h. */
  ttlSeconds?: number
  now?: () => number
}

/** The default store: in-process, TTL'd, pruned lazily. Swap it for Redis or a table in production. */
export function memoryIdempotencyStore(options: MemoryIdempotencyStoreOptions = {}): IdempotencyStore {
  const ttlMs = (options.ttlSeconds ?? 86_400) * 1000
  const now = options.now ?? Date.now
  const records = new Map<string, IdempotencyRecord>()

  const live = (key: string): IdempotencyRecord | undefined => {
    const record = records.get(key)
    if (!record) return undefined
    if (now() - record.at > ttlMs) {
      records.delete(key)
      return undefined
    }
    return record
  }

  return {
    get: live,
    reserve(record) {
      if (live(record.key)) return false
      records.set(record.key, record)
      return true
    },
    commit(record) {
      records.set(record.key, record)
    },
    release(key) {
      records.delete(key)
    },
  }
}

export type IdempotencyOptions = {
  /** Where records live. Default: an in-process store with a 24h TTL. */
  store?: IdempotencyStore
  /** Where the key comes from. Default: the one the facet carried in (`inv.idempotencyKey`). */
  key?: (inv: Invocation) => string | undefined
  now?: () => number
}

/** `key` alone is not enough: the same key on a different op is a different logical call. */
function recordKey(opId: string, key: string): string {
  return `${opId}|${key}`
}

/** Stable across key order, so two facets serializing the same input agree. */
function fingerprint(input: unknown): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, stable(v)]),
      )
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(stable(input)) ?? 'null').digest('hex').slice(0, 32)
}

/**
 * Server-side replay for the `idempotent` trait, in the pipeline, so every facet gets it at once.
 *
 * The trait was already interpreted on the way in — REST accepts an `Idempotency-Key` header, the
 * SDK and CLI mint one per logical call and reuse it across retries, MCP reads it from tool-call
 * `_meta`. This is the half that makes the promise true: the second call with a key returns the
 * first call's result instead of running the handler again.
 *
 * Semantics: a key is scoped to its op. Reusing one with different input is a `conflict`, as is a
 * call arriving while the first is still in flight. A call that *failed* leaves no record, so the
 * caller may retry the same key — only successes are replayed.
 */
export function idempotency(options: IdempotencyOptions = {}) {
  const store = options.store ?? memoryIdempotencyStore({ now: options.now })
  const now = options.now ?? Date.now
  const keyOf = options.key ?? ((inv: Invocation) => inv.idempotencyKey)
  /** Reservations this invocation owns, so `wrap` knows what to commit or release. */
  const pending = new WeakMap<Invocation, { id: string; record: IdempotencyRecord; replayed: boolean }>()

  return definePlugin({
    name: 'idempotency',
    traits: ['idempotent'],
    hooks: {
      async idempotency(inv) {
        const { traits } = inv.op.op
        // A readonly op has nothing to replay, and an op that never claimed the trait opted out.
        if (!traits.idempotent || traits.readonly) return
        const key = keyOf(inv)
        if (!key) return

        const id = recordKey(inv.op.id, key)
        const mine: IdempotencyRecord = {
          key: id,
          opId: inv.op.id,
          fingerprint: fingerprint(inv.input),
          status: 'in_flight',
          at: now(),
        }

        if (await store.reserve(mine)) {
          pending.set(inv, { id, record: mine, replayed: false })
          return
        }

        const existing = await store.get(id)
        if (!existing) {
          // It expired between reserve and get. Treat it as ours rather than failing the caller.
          pending.set(inv, { id, record: mine, replayed: false })
          return
        }
        if (existing.fingerprint !== mine.fingerprint) {
          throw errors.conflict(`Idempotency key "${key}" was already used for "${inv.op.id}" with different input`)
        }
        if (existing.status === 'in_flight') {
          throw errors.conflict(`A request with idempotency key "${key}" is still in progress`)
        }
        pending.set(inv, { id, record: existing, replayed: true })
        inv.respond(existing.output)
      },
    },
    async wrap(inv, next) {
      try {
        const output = await next()
        const entry = pending.get(inv)
        if (entry && !entry.replayed) {
          await store.commit({ ...entry.record, status: 'done', output, at: now() })
        }
        return output
      } catch (err) {
        // A failed call keeps no claim on the key: the caller is meant to retry with the same one.
        const entry = pending.get(inv)
        if (entry && !entry.replayed) await store.release(entry.id)
        throw err
      } finally {
        pending.delete(inv)
      }
    },
  })
}
