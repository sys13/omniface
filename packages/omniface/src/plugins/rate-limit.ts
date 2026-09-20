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

export type RateLimitOptions = {
  /** Default limit per key. */
  limit?: RateSpec
  /** Per-op limits, by op id. */
  ops?: Record<string, RateSpec>
  /** Bucket key. Default: the principal id (anonymous callers share one bucket). */
  key?: (inv: Invocation) => string
  /** Clock in ms, for tests. */
  now?: () => number
}

/** Token buckets, cost-aware via the `cost` op trait. Same limits on every facet. */
export function rateLimit(options: RateLimitOptions = {}) {
  const defaultRate = parseRate(options.limit ?? '100/min')
  const opRates = Object.fromEntries(Object.entries(options.ops ?? {}).map(([id, spec]) => [id, parseRate(spec)]))
  const now = options.now ?? Date.now
  const keyOf = options.key ?? ((inv: Invocation) => inv.principal.id)
  const buckets = new Map<string, { tokens: number; at: number }>()

  return definePlugin({
    name: 'rateLimit',
    traits: ['cost'],
    hooks: {
      rateLimit(inv) {
        const opRate = opRates[inv.op.id]
        const rate = opRate ?? defaultRate
        const bucketKey = `${opRate ? inv.op.id : '*'}|${keyOf(inv)}`
        const cost = typeof inv.op.op.traits.cost === 'number' ? inv.op.op.traits.cost : 1
        const perSecond = rate.requests / rate.windowSeconds
        const t = now()
        const bucket = buckets.get(bucketKey) ?? { tokens: rate.requests, at: t }
        bucket.tokens = Math.min(rate.requests, bucket.tokens + ((t - bucket.at) / 1000) * perSecond)
        bucket.at = t
        if (bucket.tokens < cost) {
          buckets.set(bucketKey, bucket)
          const retryAfter = Math.max(1, Math.ceil((cost - bucket.tokens) / perSecond))
          throw errors.rateLimited(retryAfter, `Rate limit exceeded (${rate.requests} per ${rate.windowSeconds}s)`)
        }
        bucket.tokens -= cost
        buckets.set(bucketKey, bucket)
      },
    },
  })
}
