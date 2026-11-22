import { errors } from '../errors.ts'
import { definePlugin, type Invocation } from '../plugin.ts'

export type RateSpec = `${number}/${'sec' | 'second' | 'min' | 'minute' | 'hour' | 'day'}` | { requests: number; windowSeconds: number }

const UNIT_SECONDS: Record<string, number> = { sec: 1, second: 1, min: 60, minute: 60, hour: 3600, day: 86400 }

export function parseRate(spec: RateSpec): { requests: number; windowSeconds: number } {
  if (typeof spec === 'object') return spec
  const [count, unit] = spec.split('/')
  const requests = Number(count)
  const windowSeconds = UNIT_SECONDS[unit!]
  if (!Number.isFinite(requests) || requests <= 0 || !windowSeconds) throw new Error(`rateLimit: bad rate "${spec}"`)
  return { requests, windowSeconds }
}

/** One request to take `cost` tokens from the bucket `key`, which holds `requests` and refills over `windowSeconds`. */
export type RateLimitTake = {
  key: string
  requests: number
  windowSeconds: number
  cost: number
  /** The plugin's clock, in ms. */
  now: number
}

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfter: number }

/**
 * Where the token buckets live. `take` refills the bucket for the time since it was last touched,
 * then takes `cost` tokens if it holds that many; a refused take leaves the tokens where they were.
 * It must be atomic per key: with several processes sharing a store, two takes of the last token
 * must not both succeed. The default is in memory, per process; put one in your database or Redis
 * to share limits across instances.
 */
export interface RateLimitStore {
  take(request: RateLimitTake): RateLimitVerdict | Promise<RateLimitVerdict>
}

/** Seconds until a bucket holding `tokens` can pay `cost`, at least 1. */
export function retryAfterSeconds(tokens: number, cost: number, requests: number, windowSeconds: number): number {
  return Math.max(1, Math.ceil((cost - tokens) / (requests / windowSeconds)))
}

export type MemoryRateLimitStoreOptions = {
  /**
   * At most this many buckets (default 10 000). When full, buckets that have refilled completely
   * (the same as never having been touched) are dropped; if every bucket is still live, a new key
   * is refused rather than the map growing, so a caller rotating keys can't exhaust memory.
   */
  maxKeys?: number
}

/** The default store: a token bucket per key in a `Map`, in this process only. */
export function memoryRateLimitStore(options: MemoryRateLimitStoreOptions = {}): RateLimitStore {
  const maxKeys = options.maxKeys ?? 10_000
  const buckets = new Map<string, { tokens: number; at: number; fullAt: number }>()
  return {
    take({ key, requests, windowSeconds, cost, now }) {
      const perMs = requests / windowSeconds / 1000
      if (buckets.size >= maxKeys && !buckets.has(key)) {
        for (const [k, b] of buckets) if (b.fullAt <= now) buckets.delete(k)
        if (buckets.size >= maxKeys) return { ok: false, retryAfter: Math.ceil(windowSeconds) }
      }
      const prev = buckets.get(key)
      const tokens = prev ? Math.min(requests, prev.tokens + (now - prev.at) * perMs) : requests
      const ok = tokens >= cost
      const left = ok ? tokens - cost : tokens
      buckets.set(key, { tokens: left, at: now, fullAt: now + (requests - left) / perMs })
      return ok ? { ok: true } : { ok: false, retryAfter: retryAfterSeconds(tokens, cost, requests, windowSeconds) }
    },
  }
}

export type RateLimitOptions = {
  /** Default limit per key. */
  limit?: RateSpec
  /** Per-op limits, by op id. */
  ops?: Record<string, RateSpec>
  /** Bucket key. Default: the principal id (anonymous callers share one bucket). */
  key?: (inv: Invocation) => string
  /** Where the buckets live. Default: `memoryRateLimitStore()`, per process. */
  store?: RateLimitStore
  /** Clock in ms, for tests. */
  now?: () => number
}

/** Token buckets, cost-aware via the `cost` op trait. Same limits on every facet. */
export function rateLimit(options: RateLimitOptions = {}) {
  const defaultRate = parseRate(options.limit ?? '100/min')
  const opRates = Object.fromEntries(Object.entries(options.ops ?? {}).map(([id, spec]) => [id, parseRate(spec)]))
  const now = options.now ?? Date.now
  const keyOf = options.key ?? ((inv: Invocation) => inv.principal.id)
  const store = options.store ?? memoryRateLimitStore()

  return definePlugin({
    name: 'rateLimit',
    traits: ['cost'],
    hooks: {
      async rateLimit(inv) {
        const opRate = opRates[inv.op.id]
        const rate = opRate ?? defaultRate
        const key = `${opRate ? inv.op.id : '*'}|${keyOf(inv)}`
        const cost = typeof inv.op.op.traits.cost === 'number' ? inv.op.op.traits.cost : 1
        const verdict = await store.take({ key, requests: rate.requests, windowSeconds: rate.windowSeconds, cost, now: now() })
        if (!verdict.ok) throw errors.rateLimited(verdict.retryAfter, `Rate limit exceeded (${rate.requests} per ${rate.windowSeconds}s)`)
      },
    },
  })
}
