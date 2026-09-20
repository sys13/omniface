import { describe, expect, it } from 'vitest'
import { betterAuthAdapter, type BetterAuthApi } from 'omniface/auth'
import { conformanceCases, createHarness, outcomesAgree } from '@omniface/testing'
import { createTasksApp, DEV_KEYS } from '../src/app.ts'

/**
 * The epic's "done when": the example app authenticates a real session from an identity provider
 * *and* a raw API key, on all four facets, with the generated conformance suite covering both.
 *
 * Better Auth stands in for the provider. Its server instance is used through the one method the
 * adapter needs — `api.getSession({ headers })` — so this is the real contract with a stub behind
 * it rather than a mock of our own adapter. With Better Auth's bearer plugin the session token
 * travels in `Authorization`, which is the one credential channel all four facets already carry;
 * a cookie reaches REST and MCP-over-HTTP only, and is covered separately below.
 */

const SESSIONS: Record<string, { id: string; scopes: string[]; name: string }> = {
  ba_admin_session: { id: 'user_ba_admin', scopes: ['*'], name: 'Ada' },
  ba_reader_session: { id: 'user_ba_reader', scopes: ['tasks:read'], name: 'Rex' },
}

const betterAuthServer: BetterAuthApi = {
  api: {
    async getSession({ headers }) {
      const token =
        headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
        /better-auth\.session_token=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1]
      const session = token ? SESSIONS[token] : undefined
      if (!session) return null
      return {
        user: { id: session.id, name: session.name, scopes: session.scopes },
        session: { id: `sess_${session.id}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      }
    },
  },
}

const createApp = () =>
  createTasksApp({ logSink: () => {}, authAdapters: [betterAuthAdapter({ auth: betterAuthServer })] })

describe('two identity providers, four facets', () => {
  it('authenticates a Better Auth session and a raw API key the same way everywhere', async () => {
    const harness = createHarness(createApp(), { apiKey: 'ba_admin_session' })
    const bySession = await harness.callAll('auth.whoami', {}, { apiKey: 'ba_admin_session' })
    const byKey = await harness.callAll('auth.whoami', {}, { apiKey: DEV_KEYS.admin })

    expect(outcomesAgree(bySession)).toEqual([])
    expect(outcomesAgree(byKey)).toEqual([])
    for (const [channel, outcome] of Object.entries(bySession)) {
      // The web facet resolves the same principal and renders it; the others hand it back as data.
      if (outcome.ok && outcome.presentation) expect((outcome.value as { html: string }).html).toContain('user_ba_admin')
      else expect(outcome.ok ? outcome.value : channel).toEqual({ id: 'user_ba_admin', kind: 'user', scopes: ['*'] })
    }
    for (const outcome of Object.values(byKey)) {
      if (outcome.ok && outcome.presentation) expect((outcome.value as { html: string }).html).toContain('user_admin')
      else expect(outcome.ok && (outcome.value as { id: string }).id).toBe('user_admin')
    }
  })

  it('refuses a session that neither provider knows, on every facet', async () => {
    const harness = createHarness(createApp())
    const outcomes = await harness.callAll('tasks.list', {}, { apiKey: 'ba_expired_session' })
    expect(outcomesAgree(outcomes, { compareValues: false })).toEqual([])
    for (const outcome of Object.values(outcomes)) expect(outcome.ok ? 'succeeded' : outcome.code).toBe('unauthenticated')
  })

  it('reads a Better Auth cookie over REST, where a browser has one', async () => {
    const harness = createHarness(createApp())
    const res = await harness.fetch('http://facet.test/auth/whoami', {
      headers: { cookie: 'better-auth.session_token=ba_reader_session' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'user_ba_reader', kind: 'user', scopes: ['tasks:read'] })
  })

  it('still enforces scopes against the provider’s principal', async () => {
    const harness = createHarness(createApp())
    const outcomes = await harness.callAll('tasks.create', { title: 'From a session' }, { apiKey: 'ba_reader_session' })
    for (const outcome of Object.values(outcomes)) expect(outcome.ok ? 'succeeded' : outcome.code).toBe('forbidden')
  })
})

// The whole generated suite again, with a Better Auth session as the credential instead of a key:
// every op, every facet, every check its traits imply. Nothing here names an op.
describe('generated conformance, authenticated by Better Auth', () => {
  const cases = conformanceCases({
    app: createApp,
    apiKey: 'ba_admin_session',
    unprivileged: { apiKey: 'ba_reader_session', scopes: ['tasks:read'] },
    ops: {
      'tasks.create': { input: { title: 'Conformance' } },
      'apiKeys.create': { input: { name: 'conformance', scopes: ['tasks:read'] } },
    },
  })
  for (const c of cases) it(c.name, async () => expect((await c.run()).problems).toEqual([]))
})
