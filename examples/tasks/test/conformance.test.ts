import { createHarness, outcomesAgree, type Channel, type Outcome } from '@omniface/testing'
import type { AuditEntry, LogLine } from 'omniface/plugins'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTasksApp, DEV_KEYS } from '../src/app.ts'
import { cliOf, mcpOf, restOf, sdkOf } from 'omniface'

const expectAgreement = (outcomes: Record<Channel, Outcome>, opts?: { compareValues?: boolean }) =>
  expect(outcomesAgree(outcomes, opts)).toEqual([])

describe('one definition, four facets, same behaviour', () => {
  let logs: LogLine[]
  let auditLog: AuditEntry[]
  let h: ReturnType<typeof createHarness>

  beforeEach(() => {
    logs = []
    auditLog = []
    const app = createTasksApp({ logSink: (l) => logs.push(l), auditSink: (e) => void auditLog.push(e) })
    h = createHarness(app, { apiKey: DEV_KEYS.admin })
  })

  it('creates through every facet with the same shape', async () => {
    const out = await h.callAll('tasks.create', { title: 'Write docs', priority: 'high', assigneeEmail: 'ada@example.com' })
    // Each facet created its own task, so compare shape, not ids.
    expectAgreement(out, { compareValues: false })
    for (const channel of ['rest', 'sdk', 'cli', 'mcp'] as const) {
      const o = out[channel]
      expect(o.ok, channel).toBe(true)
      if (o.ok) expect(o.value).toMatchObject({ title: 'Write docs', priority: 'high', done: false })
    }
  })

  it('reads agree exactly', async () => {
    await h.call('rest', 'tasks.create', { title: 'A' })
    const out = await h.callAll('tasks.get', { id: 'task_1' })
    expectAgreement(out)
    expect(out.rest).toMatchObject({ ok: true, value: { id: 'task_1', title: 'A' } })
  })

  it('never exposes internal fields on any facet', async () => {
    const out = await h.callAll('tasks.create', { title: 'Secret score' })
    for (const o of Object.values(out)) {
      expect(o.ok).toBe(true)
      if (!o.ok) continue
      // The web facet answers with a page, so the claim is made against what reached the page.
      if (o.presentation) expect((o.value as { html: string }).html).not.toContain('internalScore')
      else expect(o.value).not.toHaveProperty('internalScore')
    }
  })

  it('agrees on not_found', async () => {
    const out = await h.callAll('tasks.get', { id: 'task_nope' })
    expectAgreement(out)
    expect(out.mcp).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('agrees on invalid_input', async () => {
    const out = await h.callAll('tasks.create', { title: '' })
    expectAgreement(out)
    expect(out.sdk).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('agrees on unauthenticated (no credential)', async () => {
    const out = await h.callAll('tasks.list', {}, { apiKey: undefined })
    expectAgreement(out)
    expect(out.cli).toMatchObject({ ok: false, code: 'unauthenticated' })
  })

  it('agrees on unauthenticated (bad credential)', async () => {
    const out = await h.callAll('tasks.list', {}, { apiKey: 'not_a_real_key' })
    expectAgreement(out)
    expect(out.rest).toMatchObject({ ok: false, code: 'unauthenticated' })
  })

  it('agrees on forbidden (reader key cannot write)', async () => {
    const out = await h.callAll('tasks.create', { title: 'nope' }, { apiKey: DEV_KEYS.reader })
    expectAgreement(out)
    expect(out.mcp).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('lets public plugin ops through without a key', async () => {
    const out = await h.callAll('auth.whoami', {}, { apiKey: undefined })
    expectAgreement(out)
    expect(out.cli).toMatchObject({ ok: true, value: { id: 'anonymous', kind: 'anonymous' } })
  })

  it('projects plugin-contributed ops like any other', async () => {
    const out = await h.callAll('auth.whoami', {})
    expectAgreement(out)
    expect(out.mcp).toMatchObject({ ok: true, value: { id: 'user_admin', scopes: ['*'] } })
  })

  it('paginates the same way everywhere', async () => {
    for (let i = 1; i <= 5; i++) await h.call('rest', 'tasks.create', { title: `T${i}` })
    const first = await h.callAll('tasks.list', { limit: 2 })
    expectAgreement(first)
    expect(first.rest).toMatchObject({ ok: true, value: { items: [{ title: 'T5' }, { title: 'T4' }] } })
    const cursor = first.rest.ok ? (first.rest.value as { nextCursor: string }).nextCursor : ''
    const second = await h.callAll('tasks.list', { limit: 2, cursor })
    expectAgreement(second)
    expect(second.sdk).toMatchObject({ ok: true, value: { items: [{ title: 'T3' }, { title: 'T2' }] } })
  })

  it('coerces query-string inputs from the schema (booleans, numbers)', async () => {
    await h.call('rest', 'tasks.create', { title: 'open' })
    await h.call('rest', 'tasks.create', { title: 'closed' })
    await h.call('rest', 'tasks.complete', { id: 'task_2' })
    const out = await h.callAll('tasks.list', { done: true, limit: 10 })
    expectAgreement(out)
    expect(out.rest).toMatchObject({ ok: true, value: { items: [{ title: 'closed' }] } })
  })

  it('redacts pii in logs and audit, and records the facet and agent', async () => {
    await h.call('mcp', 'tasks.create', { title: 'Private', assigneeEmail: 'ada@example.com' })
    const line = logs.find((l) => l.msg === 'op completed' && l.op === 'tasks.create')!
    expect(line).toMatchObject({ facet: 'mcp', actor: 'user_admin', client: 'facet-harness/0.0.1' })
    expect(line.input).toMatchObject({ title: 'Private', assigneeEmail: '[redacted]' })
    expect(JSON.stringify(logs)).not.toContain('ada@example.com')

    expect(auditLog).toHaveLength(1)
    expect(auditLog[0]).toMatchObject({
      op: 'tasks.create',
      facet: 'mcp',
      outcome: 'ok',
      actor: { id: 'user_admin', kind: 'agent', via: 'mcp:facet-harness' },
      input: { assigneeEmail: '[redacted]' },
    })
  })

  it('gives handlers typed plugin context (ctx.log)', async () => {
    await h.call('cli', 'tasks.create', { title: 'Logged' })
    expect(logs.find((l) => l.msg === 'task created')).toMatchObject({ facet: 'cli', taskId: 'task_1' })
  })
})

describe('adding one plugin changes every facet', () => {
  it('rateLimit: the 3rd call is rate_limited on REST, SDK, CLI and MCP alike', async () => {
    for (const channel of ['rest', 'sdk', 'cli', 'mcp'] as const) {
      const h = createHarness(createTasksApp({ limit: '2/min', logSink: () => {} }), { apiKey: DEV_KEYS.admin })
      expect((await h.call(channel, 'auth.whoami')).ok).toBe(true)
      expect((await h.call(channel, 'auth.whoami')).ok).toBe(true)
      const third = await h.call(channel, 'auth.whoami')
      expect(third, channel).toMatchObject({ ok: false, code: 'rate_limited' })
      if (!third.ok) expect(third.retryAfter, channel).toBeGreaterThan(0)
    }
  })

  it('REST renders it as 429 + Retry-After + problem+json', async () => {
    const h = createHarness(createTasksApp({ limit: '1/min', logSink: () => {} }), { apiKey: DEV_KEYS.admin })
    const req = () => h.fetch('http://facet.test/auth/whoami', { headers: { authorization: `Bearer ${DEV_KEYS.admin}` } })
    expect((await req()).status).toBe(200)
    const res = await req()
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(await res.json()).toMatchObject({ code: 'rate_limited', status: 429, type: 'https://facet.dev/errors/rate_limited' })
  })
})
