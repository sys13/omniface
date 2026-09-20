import { errors, facet, type App } from 'omniface'
import { idempotency, memoryIdempotencyStore, type IdempotencyStore } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'
import { beforeEach, describe, expect, it } from 'vitest'

const Charge = t.named('Charge', z.object({ id: t.id(), amount: z.number() }))

let runs: number
let fail: (() => never) | undefined
let clock: number
let store: IdempotencyStore

function createApp(options: { store?: IdempotencyStore } = {}): App {
  const f = facet({ plugins: [idempotency({ store: options.store ?? store, now: () => clock })] })
  let seq = 0
  return f.app({
    name: 'billing',
    ops: {
      charges: {
        create: f
          .op({ input: Charge.pick({ amount: true }), output: Charge })
          .traits({ idempotent: true })
          .handle(({ input }) => {
            runs++
            fail?.()
            return { id: `charge_${++seq}`, amount: input.amount }
          }),
        // No trait: the op never claimed idempotence, so a key must not change what it does.
        note: f
          .op({ input: Charge.pick({ amount: true }), output: Charge })
          .handle(({ input }) => {
            runs++
            return { id: `note_${++seq}`, amount: input.amount }
          }),
        get: f
          .op({ input: Charge.pick({ id: true }), output: Charge })
          .traits({ readonly: true, idempotent: true })
          .handle(({ input }) => {
            runs++
            return { id: input.id, amount: 1 }
          }),
      },
    },
  })
}

const call = (app: App, id: string, input: unknown, key?: string) =>
  app.invoke(id, input, { facet: 'internal', ...(key ? { idempotencyKey: key } : {}) })

beforeEach(() => {
  runs = 0
  fail = undefined
  clock = 1_000_000
  store = memoryIdempotencyStore({ now: () => clock })
})

describe('idempotency plugin', () => {
  it('replays the first result and does not run the handler again', async () => {
    const app = createApp()
    const first = await call(app, 'charges.create', { amount: 10 }, 'key_1')
    const second = await call(app, 'charges.create', { amount: 10 }, 'key_1')
    expect(second).toEqual(first)
    expect(second).toMatchObject({ id: 'charge_1' })
    expect(runs).toBe(1)
  })

  it('runs again without a key, and for a different key', async () => {
    const app = createApp()
    await call(app, 'charges.create', { amount: 10 })
    await call(app, 'charges.create', { amount: 10 })
    await call(app, 'charges.create', { amount: 10 }, 'key_1')
    await call(app, 'charges.create', { amount: 10 }, 'key_2')
    expect(runs).toBe(4)
  })

  it('conflicts when one key is reused with different input', async () => {
    const app = createApp()
    await call(app, 'charges.create', { amount: 10 }, 'key_1')
    await expect(call(app, 'charges.create', { amount: 99 }, 'key_1')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('different input'),
    })
    expect(runs).toBe(1)
  })

  it('ignores the order keys were written in when comparing input', async () => {
    const f = facet({ plugins: [idempotency({ store, now: () => clock })] })
    const app = f.app({
      name: 'billing',
      ops: {
        pay: f
          .op({ input: z.object({ a: z.number(), b: z.number() }), output: z.object({ ok: z.boolean() }) })
          .traits({ idempotent: true })
          .handle(() => ((runs++), { ok: true })),
      },
    })
    await call(app, 'pay', { a: 1, b: 2 }, 'key_1')
    await call(app, 'pay', { b: 2, a: 1 }, 'key_1')
    expect(runs).toBe(1)
  })

  it('scopes a key to its op', async () => {
    const app = createApp()
    await call(app, 'charges.create', { amount: 10 }, 'key_1')
    await call(app, 'charges.note', { amount: 10 }, 'key_1')
    expect(runs).toBe(2)
  })

  it('leaves no record when the call failed, so the same key can be retried', async () => {
    const app = createApp()
    fail = () => {
      throw errors.internal('payment processor down')
    }
    await expect(call(app, 'charges.create', { amount: 10 }, 'key_1')).rejects.toMatchObject({ code: 'internal' })
    fail = undefined
    expect(await call(app, 'charges.create', { amount: 10 }, 'key_1')).toMatchObject({ id: 'charge_1' })
    expect(runs).toBe(2)
  })

  it('conflicts while the first call with the key is still in flight', async () => {
    let release: () => void = () => {}
    // Parks the first handler inside its reservation window, so the second call arrives mid-flight.
    const gate = new Promise<void>((resolve) => (release = resolve))
    const f = facet({ plugins: [idempotency({ store, now: () => clock })] })
    const slow = f.app({
      name: 'billing',
      ops: {
        charge: f
          .op({ input: Charge.pick({ amount: true }), output: Charge })
          .traits({ idempotent: true })
          .handle(async ({ input }) => {
            runs++
            await gate
            return { id: 'charge_1', amount: input.amount }
          }),
      },
    })

    const inFlight = call(slow, 'charge', { amount: 10 }, 'key_1')
    await expect(call(slow, 'charge', { amount: 10 }, 'key_1')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('still in progress'),
    })
    release()
    expect(await inFlight).toMatchObject({ id: 'charge_1' })
    expect(runs).toBe(1)
  })

  it('leaves readonly ops and untraited ops alone', async () => {
    const app = createApp()
    await call(app, 'charges.get', { id: 'charge_1' }, 'key_1')
    await call(app, 'charges.get', { id: 'charge_1' }, 'key_1')
    await call(app, 'charges.note', { amount: 5 }, 'key_2')
    await call(app, 'charges.note', { amount: 5 }, 'key_2')
    expect(runs).toBe(4)
  })

  it('stops replaying once the record expires', async () => {
    const app = createApp({ store: memoryIdempotencyStore({ ttlSeconds: 60, now: () => clock }) })
    await call(app, 'charges.create', { amount: 10 }, 'key_1')
    clock += 30_000
    await call(app, 'charges.create', { amount: 10 }, 'key_1')
    expect(runs).toBe(1)
    clock += 61_000
    await call(app, 'charges.create', { amount: 10 }, 'key_1')
    expect(runs).toBe(2)
  })

  it('accepts any store, so production can use a shared one', async () => {
    const records = new Map<string, any>()
    const custom: IdempotencyStore = {
      get: (key) => records.get(key),
      reserve: (record) => (records.has(record.key) ? false : (records.set(record.key, record), true)),
      commit: (record) => void records.set(record.key, record),
      release: (key) => void records.delete(key),
    }
    const app = createApp({ store: custom })
    await call(app, 'charges.create', { amount: 10 }, 'key_1')
    await call(app, 'charges.create', { amount: 10 }, 'key_1')
    expect(runs).toBe(1)
    expect([...records.keys()]).toEqual(['charges.create|key_1'])
  })
})
