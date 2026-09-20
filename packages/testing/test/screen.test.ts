import { buildManifest, facet, renderScreen, type App } from 'omniface'
import { t } from 'omniface/zod'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { screenProblems } from '../src/screen.ts'

/**
 * The checker behind the generated `presentation` case, against screens rendered from a definition
 * that carries all four field traits at once — including `deprecated`, which no shipped example app
 * declares on an output field today, so without this it would be an assertion that never fires.
 *
 * Each case is a mutation: take a screen that agrees with its record, break one thing, and require
 * the checker to name it. A checker nobody has watched fail is the same overclaim as a generated
 * suite nobody has watched fail.
 */

const Thing = t.named(
  'Thing',
  z.object({
    id: t.id(),
    title: z.string(),
    secret: t(z.string(), { sensitive: true }),
    ownerEmail: t(z.email(), { pii: true }),
    notes: t(z.string(), { deprecated: 'use title' }),
    ledgerRef: t(z.string(), { internal: true }),
  }),
)

const f = facet()
const list = f
  .op({ description: 'Every thing', input: t.pageInput(), output: t.page(Thing) })
  .traits({ readonly: true, paginated: true })
  .handle(() => ({ items: [], nextCursor: null }))
const get = f
  .op({ description: 'One thing', input: z.object({ id: z.string() }), output: Thing })
  .traits({ readonly: true })
  .handle(() => null as never)

const manifest = buildManifest(f.app({ name: 'acme', ops: { things: { list, get } }, facets: { web: true } }) as unknown as App<any>)
const opOf = (id: string) => manifest.ops.find((o) => o.id === id)!

/** What REST answers: the public record, with `internal` already stripped by the pipeline. */
const record = {
  id: 'thing_1',
  title: 'A thing',
  secret: 'sk_live_9',
  ownerEmail: 'sam@example.com',
  notes: 'old',
}

const detailHtml = (data: unknown = record) => renderScreen(manifest, 'things.get', { data, params: { id: 'thing_1' } })
const tableHtml = (items: unknown[] = [record]) => renderScreen(manifest, 'things.list', { data: { items, nextCursor: null } })

describe('a screen that agrees with its record', () => {
  it('has nothing to report, on a detail or a table', () => {
    expect(screenProblems(opOf('things.get'), detailHtml(), record)).toEqual([])
    expect(screenProblems(opOf('things.list'), tableHtml(), { items: [record], nextCursor: null })).toEqual([])
  })
})

describe('what it catches', () => {
  it('a screen that renders no records at all — the mutation #30 was filed for', () => {
    expect(screenProblems(opOf('things.list'), '<!-- MUTANT: no data -->', { items: [record] })).toEqual([
      'the table shows 0 row(s), REST returned 1',
    ])
    expect(screenProblems(opOf('things.get'), '<!-- MUTANT: no data -->', record)[0]).toMatch(/shows \[\], the rules say/)
  })

  it('a sensitive value printed in the clear', () => {
    const leaked = detailHtml().replace(/<dd data-field="secret">[\s\S]*?<\/dd>/, '<dd data-field="secret">sk_live_9</dd>')
    expect(screenProblems(opOf('things.get'), leaked, record)).toEqual([
      'detail.secret: the sensitive value is on screen in the clear',
    ])
  })

  it('a sensitive field dropped instead of masked', () => {
    const dropped = detailHtml().replace(/<dt data-field="secret">[\s\S]*?<\/dd>/, '')
    expect(screenProblems(opOf('things.get'), dropped, record)[0]).toMatch(/the rules say \[.*secret.*\]/)
  })

  it('a value that disagrees with what REST answered', () => {
    expect(screenProblems(opOf('things.get'), detailHtml(), { ...record, title: 'Something else' })).toEqual([
      'detail.title: shows "A thing", REST says "Something else"',
    ])
  })

  it('pii quietly redacted on one facet and not the others', () => {
    const redacted = detailHtml().replace('sam@example.com', '[redacted]')
    expect(screenProblems(opOf('things.get'), redacted, record)).toEqual([
      'detail.ownerEmail: pii shows "[redacted]", REST says "sam@example.com"',
    ])
  })

  it('a deprecated field the screen does not mark', () => {
    const unmarked = detailHtml().replace(/ <span class="dep">[\s\S]*?<\/span>/, '')
    expect(screenProblems(opOf('things.get'), unmarked, record)).toEqual([
      'detail.notes: deprecated, but the screen does not say so',
    ])
  })

  it('an internal field on screen — a field the rules never listed', () => {
    const leaked = detailHtml().replace('<dl>', '<dl><dt data-field="ledgerRef">Ledger ref</dt><dd data-field="ledgerRef">L-1</dd>')
    expect(screenProblems(opOf('things.get'), leaked, record)[0]).toMatch(/^detail: shows \[ledgerRef, /)
  })

  it('an empty screen and an empty record, which prove nothing at all', () => {
    expect(screenProblems(opOf('things.list'), tableHtml([]), { items: [] })).toEqual([
      'the screen and REST both returned no rows; this case proved nothing — give the op a setup',
    ])
  })
})
