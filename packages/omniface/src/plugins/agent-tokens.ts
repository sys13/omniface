import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { defineAuthAdapter, type AuthAdapter } from '../auth/adapter.ts'
import { errors } from '../errors.ts'
import { op, type Principal } from '../op.ts'
import { definePlugin } from '../plugin.ts'
import { hasScope } from './scopes.ts'

/**
 * Attenuated credentials for the agent in a visitor's browser (docs/BACKLOG.md 12.8, the
 * proposal's W5).
 *
 * The problem this exists for: a WebMCP tool body is a same-origin `fetch` from a page the person
 * is already signed in to, so it carries their session cookie, so the agent holds *the person's
 * entire authority*. `scopes()` cannot narrow anything, because the principal is the person. Every
 * capability the app has is then one sentence away from an agent that reads a web page for a
 * living.
 *
 * The fix is attenuation, and it is ordinary: the page asks for a short-lived token that holds a
 * subset of what the person holds, and the tools carry that instead. Everything downstream —
 * scopes, rate limits, audit — then works exactly as it already does for an API key, because it
 * *is* one, with an expiry and a smaller grant.
 *
 * Two properties this leans on rather than re-implements: a token can only ever narrow (the mint
 * op refuses a scope the caller does not hold, and the ceiling caps it again), and the mint op is
 * not advertised to agents by default, so an agent cannot refresh its own authority — 12.7's gate
 * refuses a `webmcp` caller that tries.
 */

export type AgentTokenRecord = {
  id: string
  hash: string
  principal: Principal
  expiresAt: number
  /** What the token was minted for, recorded so audit can say it. */
  note?: string
}

export interface AgentTokenStore {
  insert(record: AgentTokenRecord): Promise<void>
  find(hash: string): Promise<AgentTokenRecord | undefined>
  /** Drop what has expired. Called on every mint; there is no background timer to leak. */
  sweep(now: number): Promise<void>
}

export function memoryAgentTokenStore(): AgentTokenStore {
  const rows = new Map<string, AgentTokenRecord>()
  return {
    async insert(record) {
      rows.set(record.hash, record)
    },
    async find(hash) {
      return rows.get(hash)
    },
    async sweep(now) {
      for (const [hash, row] of rows) if (row.expiresAt <= now) rows.delete(hash)
    },
  }
}

export type AgentTokensOptions = {
  /** How long a token lives, in seconds. Default 300 — a task, not a session. */
  ttlSeconds?: number
  /**
   * The most a token may ever carry, whatever the person holds. Default `[]`, which mints a token
   * with no scopes at all: an app that has not decided what an agent may do has decided nothing,
   * and nothing is the safe reading of that.
   */
  ceiling?: string[]
  store?: AgentTokenStore
  /** Prefix for minted tokens, so they are recognisable in a log. Default `fat_`. */
  prefix?: string
  /**
   * Fill the `authenticate` stage. Default true. Set false to pass `.adapter` to
   * `auth({ adapters: [...] })` instead, so an unrecognised token falls through to the next
   * provider rather than being rejected here.
   */
  authenticate?: boolean
}

/** Stored as a hash, like an API key: the server never keeps anything it could hand back. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export type AgentTokenAdapterOptions = { store: AgentTokenStore; name?: string }

/**
 * Agent tokens as an {@link AuthAdapter}. A bearer this does not recognise is declined with `null`
 * so the next provider sees it; one it recognises and finds expired is rejected, because that is
 * this adapter's own verdict about its own token.
 */
export function agentTokenAdapter(options: AgentTokenAdapterOptions): AuthAdapter {
  return defineAuthAdapter({
    name: options.name ?? 'agent-token',
    async authenticate(ctx) {
      if (!ctx.credential) return null
      const row = await options.store.find(hashToken(ctx.credential.token))
      if (!row) return null
      if (row.expiresAt <= Date.now()) throw errors.unauthenticated('Agent token has expired')
      return {
        principal: row.principal,
        session: { provider: 'agent-token', tokenId: row.id, expiresAt: new Date(row.expiresAt).toISOString() },
      }
    },
  })
}

export function agentTokens(options: AgentTokensOptions = {}) {
  const store = options.store ?? memoryAgentTokenStore()
  const ttl = (options.ttlSeconds ?? 300) * 1000
  const ceiling = options.ceiling ?? []
  const prefix = options.prefix ?? 'fat_'
  const adapter = agentTokenAdapter({ store })

  const ops = {
    agentToken: {
      mint: op({
        description:
          'Mint a short-lived, scope-narrowed token for the agent in this browser. Never more than the caller already holds.',
        input: z.object({ scopes: z.array(z.string()).optional(), note: z.string().max(200).optional() }),
        output: z.object({ token: z.string(), scopes: z.array(z.string()), expiresAt: z.string() }),
      })
        .traits({ cost: 2 })
        .handle(async ({ input, principal }) => {
          if (principal.kind === 'anonymous') throw errors.unauthenticated('Sign in before minting an agent token')
          // Narrowing only, twice over: what the app allows an agent at all, and then what this
          // caller actually holds. A token can never be a way to acquire something.
          const asked = input.scopes ?? ceiling
          const granted = asked.filter((s) => hasScope(ceiling, s) && hasScope(principal.scopes, s))
          const denied = asked.filter((s) => !granted.includes(s))
          if (denied.length && input.scopes) {
            throw errors.forbidden(`An agent token cannot carry: ${denied.join(', ')}`)
          }
          const now = Date.now()
          await store.sweep(now)
          const token = prefix + randomBytes(24).toString('base64url')
          const expiresAt = now + ttl
          await store.insert({
            id: `agt_${randomBytes(6).toString('hex')}`,
            hash: hashToken(token),
            // `kind: 'agent'`, acting for the person: audit should say an agent did this, and
            // anything keyed on the principal id still resolves to whose tab it was.
            principal: { id: principal.id, kind: 'agent', scopes: granted, ...(principal.name ? { name: principal.name } : {}) },
            expiresAt,
            ...(input.note ? { note: input.note } : {}),
          })
          return { token, scopes: granted, expiresAt: new Date(expiresAt).toISOString() }
        }),
    },
  }

  const plugin = definePlugin<{}, typeof ops>({
    name: 'agentTokens',
    ops,
    ...(options.authenticate === false
      ? {}
      : {
          hooks: {
            async authenticate(inv) {
              if (!inv.credential) return
              const result = await adapter.authenticate({
                credential: inv.credential,
                ...(inv.headers ? { headers: inv.headers } : {}),
                facet: inv.facet,
                requestId: inv.requestId,
              })
              // Not the sole authenticator, ever: this plugin only knows its own tokens, and the
              // session or API key the page used to *mint* one has to keep working. An
              // unrecognised bearer is left for whatever authenticates next.
              if (result) inv.principal = result.principal
            },
          },
        }),
  })
  /** The same tokens as an {@link AuthAdapter}, for `auth({ adapters: [...] })`. */
  return Object.assign(plugin, { adapter, store })
}
