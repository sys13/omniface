import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildManifest, facet } from '../src/index.ts'
import { buildSdk } from '../src/sdk.ts'
import { t } from '../src/zod/index.ts'

/**
 * A named type that is a union, not an object. Found by modelling Stripe's `PaymentMethod`
 * (examples/expressibility): every named type used to be emitted as an `interface` when its body
 * started with `{`, which a union of objects also does — and `export interface X { … } | { … }`
 * is not parseable TypeScript, so the whole generated SDK failed to compile.
 */
const PaymentMethod = t.named(
  'PaymentMethod',
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('card'), last4: z.string() }),
    z.object({ type: z.literal('bank_account'), bankName: z.string() }),
  ]),
)

const Charge = t.named('Charge', z.object({ id: t.id(), method: PaymentMethod }))

function chargesApp() {
  const f = facet()
  return f.app({
    name: 'charges',
    version: '1.0.0',
    ops: {
      charges: {
        get: f
          .op({ input: z.object({ id: t.id() }), output: Charge })
          .traits({ readonly: true })
          .handle(() => ({ id: 'ch_1', method: { type: 'card' as const, last4: '4242' } })),
      },
    },
  })
}

describe('generated SDK types', () => {
  const dts = buildSdk(buildManifest(chargesApp()), { facetVersion: '0.0.0' })['sdk/index.d.ts']!

  it('declares a named union as a type alias, not an interface', () => {
    expect(dts).toContain('export type PaymentMethod =')
    expect(dts).not.toContain('export interface PaymentMethod')
  })

  it('still declares a named object type as an interface', () => {
    expect(dts).toContain('export interface Charge')
  })

  // The check that would have caught the original bug whatever its shape: the emitted
  // declarations have to parse. `examples/tasks` already runs tsc over a generated SDK, but that
  // app has no union type, which is how this got through.
  it('parses as TypeScript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'facet-sdk-types-'))
    try {
      const file = join(dir, 'index.d.ts')
      await writeFile(file, dts)
      const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url))
      const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(tsc, ['--ignoreConfig', '--noEmit', '--skipLibCheck', file])
        let out = ''
        child.stdout?.on('data', (d) => (out += d))
        child.stderr?.on('data', (d) => (out += d))
        child.on('close', (code) => resolve({ code, out }))
      })
      expect(result.out, result.out).not.toMatch(/error TS1\d{3}/)
      expect(result.code).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
