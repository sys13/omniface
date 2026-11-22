import { facet, toFacetError, type App } from 'omniface'
import { memoryRateLimitStore, rateLimit, type RateLimitStore, type RateLimitTake } from 'omniface/plugins'
import { z } from 'zod'
import { beforeEach, describe, expect, it } from 'vitest'

let clock: number
beforeEach(() => {
  clock = 0
})

function createApp(options: Parameters<typeof rateLimit>[0] = {}): App {
  const f = facet({ plugins: [rateLimit({ now: () => clock, ...options })] })
  return f.app({
    name: 'limits',
    ops: {
      ping: { get: f.op({ input: z.object({}), output: z.object({ ok: z.boolean() }) }).handle(() => ({ ok: true })) },
      heavy: {
        run: f
          .op({ input: z.object({}), output: z.object({ ok: z.boolean() }) })
          .traits({ cost: 2 })
          .handle(() => ({ ok: true })),
      },
    },
  })
}

const outcome = (app: App, id: string) =>
  app.invoke(id, {}, { facet: 'internal' }).then(
    () => 'ok',
    (e) => {
      const err = toFacetError(e)
      return `${err.code}:${err.retryAfter}`
    },
  )

describe('rateLimit', () => {
  it('refuses once the bucket is empty, with a retry hint, and refills over time', async () => {
    const app = createApp({ limit: '2/min' })
    expect(await outcome(app, 'ping.get')).toBe('ok')
    expect(await outcome(app, 'ping.get')).toBe('ok')
    expect(await outcome(app, 'ping.get')).toBe('rate_limited:30')
    clock += 30_000
    expect(await outcome(app, 'ping.get')).toBe('ok')
    expect(await outcome(app, 'ping.get')).toBe('rate_limited:30')
  })

  it('charges the cost trait', async () => {
    const app = createApp({ limit: '3/min' })
    expect(await outcome(app, 'heavy.run')).toBe('ok')
    expect(await outcome(app, 'heavy.run')).toBe('rate_limited:20')
    expect(await outcome(app, 'ping.get')).toBe('ok')
  })

  it('hands the store each take and obeys its verdict', async () => {
    const seen: RateLimitTake[] = []
    let allow = true
    const store: RateLimitStore = {
      async take(t) {
        seen.push(t)
        return allow ? { ok: true } : { ok: false, retryAfter: 7 }
      },
    }
    const app = createApp({ limit: '5/min', ops: { 'heavy.run': '1/hour' }, store, key: () => 'k' })
    clock = 1234
    expect(await outcome(app, 'ping.get')).toBe('ok')
    expect(await outcome(app, 'heavy.run')).toBe('ok')
    allow = false
    expect(await outcome(app, 'ping.get')).toBe('rate_limited:7')
    expect(seen[0]).toEqual({ key: '*|k', requests: 5, windowSeconds: 60, cost: 1, now: 1234 })
    expect(seen[1]).toEqual({ key: 'heavy.run|k', requests: 1, windowSeconds: 3600, cost: 2, now: 1234 })
  })
})

describe('memoryRateLimitStore', () => {
  const take = (store: RateLimitStore, key: string, now: number) =>
    store.take({ key, requests: 1, windowSeconds: 60, cost: 1, now })

  it('keeps keys apart', async () => {
    const store = memoryRateLimitStore()
    expect(await take(store, 'a', 0)).toEqual({ ok: true })
    expect(await take(store, 'a', 0)).toEqual({ ok: false, retryAfter: 60 })
    expect(await take(store, 'b', 0)).toEqual({ ok: true })
  })

  it('refuses new keys when full of live buckets, and frees refilled ones', async () => {
    const store = memoryRateLimitStore({ maxKeys: 2 })
    await take(store, 'a', 0)
    await take(store, 'b', 0)
    expect((await take(store, 'c', 0)).ok).toBe(false)
    // An existing key still gets its own verdict.
    expect(await take(store, 'a', 0)).toEqual({ ok: false, retryAfter: 60 })
    // Once a and b have refilled they are the same as absent.
    expect(await take(store, 'c', 60_000)).toEqual({ ok: true })
  })
})
