import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { defineAuthAdapter, type AuthAdapter } from '../auth/adapter.ts'
import { errors } from '../errors.ts'
import { op, type Principal } from '../op.ts'
import { definePlugin } from '../plugin.ts'
import { hasScope } from './scopes.ts'

export type ApiKeyRecord = {
  id: string
  name: string
  hash: string
  prefix: string
  scopes: string[]
  principal: Omit<Principal, 'scopes'>
  createdAt: string
  revokedAt?: string
  /** ISO time after which the key is refused. Absent: never expires. */
  expiresAt?: string
  /** ISO time the key last authenticated, to within the adapter's throttle. */
  lastUsedAt?: string
  /** Who used it last (the client's User-Agent), truncated. */
  lastUsedClient?: string
}

/**
 * Where keys live. The built-in store is in memory; `fileKeyStore` and `sqlKeyStore` are the
 * durable ones, and anything else that satisfies this interface works the same way.
 * `fileKeyStore` is for one process per file: two processes sharing it can lose each other's
 * writes, revocations included. More than one process means `sqlKeyStore`.
 *
 * `@omniface/testing`'s `apiKeyStoreCases()` is the conformance suite every implementation should pass.
 */
export interface ApiKeyStore {
  /** The record whose secret hashes to this, revoked or not. Callers decide what a revoked key means. */
  findByHash(hash: string): Promise<ApiKeyRecord | undefined>
  /** Insert or replace by `id`, so re-seeding the same startup keys is not an error. */
  insert(record: ApiKeyRecord): Promise<void>
  /** Every key for one principal, revoked ones included. */
  listFor(principalId: string): Promise<ApiKeyRecord[]>
  /** False when the key does not exist, belongs to someone else, or is already revoked. */
  revoke(id: string, principalId: string): Promise<boolean>
  /** Revoke every active key of one principal. Returns how many were revoked. */
  revokeAll(principalId: string): Promise<number>
  /** Stamp last use. The adapter calls this at most once per key per `touchIntervalMs`. */
  touch(id: string, at: string, client?: string): Promise<void>
}

export function memoryKeyStore(): ApiKeyStore {
  const rows = new Map<string, ApiKeyRecord>()
  return {
    async findByHash(hash) {
      for (const row of rows.values()) if (row.hash === hash) return row
      return undefined
    },
    async insert(record) {
      rows.set(record.id, record)
    },
    async listFor(principalId) {
      return [...rows.values()].filter((r) => r.principal.id === principalId)
    },
    async revoke(id, principalId) {
      const row = rows.get(id)
      if (!row || row.principal.id !== principalId || row.revokedAt) return false
      row.revokedAt = new Date().toISOString()
      return true
    },
    async revokeAll(principalId) {
      let n = 0
      for (const row of rows.values()) {
        if (row.principal.id !== principalId || row.revokedAt) continue
        row.revokedAt = new Date().toISOString()
        n++
      }
      return n
    },
    async touch(id, at, client) {
      const row = rows.get(id)
      if (!row) return
      row.lastUsedAt = at
      if (client) row.lastUsedClient = client
      else delete row.lastUsedClient
    },
  }
}

/** How a key is stored: never the secret, only its SHA-256. */
export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex')
const hashKey = hashApiKey

export type SeedKey = { key: string; principalId: string; name?: string; kind?: Principal['kind']; scopes: string[] }

export type ApiKeysOptions = {
  /** Keys that exist at startup (e.g. from env). */
  keys?: SeedKey[]
  /** Default: in memory. `fileKeyStore` is single-process; share keys across processes with `sqlKeyStore`. */
  store?: ApiKeyStore
  /** Prefix for generated keys, e.g. "acme_". */
  prefix?: string
  /**
   * Fill the `authenticate` stage. Default true. Set false when the keys are one provider among
   * several: pass `.adapter` to `auth({ adapters: [...] })` instead, so an unrecognised token can
   * fall through to the next provider rather than being rejected here.
   */
  authenticate?: boolean
  /**
   * Scopes `apiKeys.create` refuses to grant, whoever asks (a requested scope is refused if it would
   * satisfy any of these, so `'*'` and `'x:*'` are refused as well as the literal). For scopes that must stay out of keys even when the caller holds them.
   */
  neverGrant?: string[]
  /** Minimum gap between two writes of one key's `lastUsedAt`. Default 60000. 0 writes every time. */
  touchIntervalMs?: number  /** Add `apiKeys.revokeAll`, which revokes every active key of the caller. Default false: it is one more tool for agents to choose from. */
  revokeAll?: boolean
}

export type ApiKeyAdapterOptions = {
  store: ApiKeyStore
  /** Keys that exist at startup, inserted on first use. */
  keys?: SeedKey[]
  /** Adapter name, for `ctx.auth.adapter`. Default `api-key`. */
  name?: string
  /** Minimum gap between two writes of one key's `lastUsedAt`. Default 60000. */
  touchIntervalMs?: number
}

/** Insert seed keys once, however many callers race for them. */
function seeder(store: ApiKeyStore, keys: SeedKey[] | undefined): () => Promise<void> {
  let seeded: Promise<void> | undefined
  return () =>
    (seeded ??= Promise.all(
      (keys ?? []).map((k, i) =>
        store.insert({
          id: `key_seed_${i}`,
          name: k.name ?? `seed ${i}`,
          hash: hashKey(k.key),
          prefix: k.key.slice(0, 8),
          scopes: k.scopes,
          principal: { id: k.principalId, kind: k.kind ?? 'user' },
          createdAt: new Date().toISOString(),
        }),
      ),
    ).then(() => undefined))
}

/**
 * API keys as an {@link AuthAdapter}, for `auth({ adapters: [...] })`.
 *
 * A bearer that no key matches is declined with `null` rather than rejected, so a JWT or a
 * session cookie can be handled by the adapter after it. A key that matches but is revoked is
 * rejected: that is this adapter's own verdict, not someone else's token.
 */
export function apiKeyAdapter(options: ApiKeyAdapterOptions): AuthAdapter {
  return keyAdapter(options.store, seeder(options.store, options.keys), options.name, options.touchIntervalMs)
}

/** The adapter over a seeder the caller owns, so `apiKeys()` and its adapter seed once between them. */
function keyAdapter(
  store: ApiKeyStore,
  seed: () => Promise<void>,
  name = 'api-key',
  touchIntervalMs = 60_000,
): AuthAdapter {
  /** When each key was last written, so a busy key costs one write per interval, not one per call. */
  const touched = new Map<string, number>()
  return defineAuthAdapter({
    name,
    async authenticate(ctx) {
      if (!ctx.credential) return null
      await seed()
      const row = await store.findByHash(hashKey(ctx.credential.token))
      if (!row) return null
      if (row.revokedAt) throw errors.unauthenticated('API key has been revoked')
      if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) throw errors.unauthenticated('API key has expired')
      const now = Date.now()
      const prev = touched.get(row.id)
      if (prev === undefined || now - prev >= touchIntervalMs) {
        touched.set(row.id, now)
        const client = ctx.headers?.get('user-agent')?.slice(0, 200)
        // Bookkeeping must never fail a request.
        await store.touch(row.id, new Date(now).toISOString(), client).catch(() => touched.delete(row.id))
      }
      return {
        principal: { ...row.principal, scopes: row.scopes },
        session: { provider: 'api-key', keyId: row.id, keyName: row.name },
      }
    },
  })
}

const KeyInfo = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  revoked: z.boolean(),
  expiresAt: z.string().nullable(),
  expired: z.boolean(),
  lastUsedAt: z.string().nullable(),
  lastUsedClient: z.string().nullable(),
})

export function apiKeys(options: ApiKeysOptions = {}) {
  const store = options.store ?? memoryKeyStore()
  const keyPrefix = options.prefix ?? 'fk_'
  const seed = seeder(store, options.keys)
  const adapter = keyAdapter(store, seed, undefined, options.touchIntervalMs)

  const ops = {
    auth: {
      whoami: op({
        description: 'Show who the current credential authenticates as',
        output: z.object({ id: z.string(), kind: z.string(), scopes: z.array(z.string()) }),
      })
        .traits({ readonly: true, public: true })
        .handle(({ principal }) => ({ id: principal.id, kind: principal.kind, scopes: principal.scopes })),
    },
    apiKeys: {
      create: op({
        description: 'Create an API key for the current principal. The secret is shown once.',
        input: z.object({
          name: z.string().min(1),
          scopes: z.array(z.string()).min(1),
          expiresInDays: z.number().int().min(1).max(3650).optional().describe('Days until the key stops working. Omit for never.'),
        }),
        output: z.object({
          id: z.string(),
          name: z.string(),
          key: z.string(),
          scopes: z.array(z.string()),
          expiresAt: z.string().nullable(),
        }),
      })
        .traits({ scope: 'apiKeys:write' })
        .handle(async ({ input, principal }) => {
          const denied = input.scopes.filter((s) => !hasScope(principal.scopes, s))
          if (denied.length) throw errors.forbidden(`Cannot grant scopes you do not hold: ${denied.join(', ')}`)
          const never = input.scopes.filter((s) => options.neverGrant?.some((n) => hasScope([s], n)))
          if (never.length) throw errors.forbidden(`API keys cannot be granted: ${never.join(', ')}`)
          const key = keyPrefix + randomBytes(24).toString('base64url')
          const id = `key_${randomBytes(6).toString('hex')}`
          const expiresAt = input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
            : undefined
          await store.insert({
            id,
            name: input.name,
            hash: hashKey(key),
            prefix: key.slice(0, keyPrefix.length + 4),
            scopes: input.scopes,
            principal: { id: principal.id, kind: principal.kind, ...(principal.name ? { name: principal.name } : {}) },
            createdAt: new Date().toISOString(),
            ...(expiresAt ? { expiresAt } : {}),
          })
          return { id, name: input.name, key, scopes: input.scopes, expiresAt: expiresAt ?? null }
        }),
      list: op({
        description: "List the current principal's API keys (never the secrets)",
        output: z.object({ items: z.array(KeyInfo), nextCursor: z.string().nullable() }),
      })
        .traits({ readonly: true, scope: 'apiKeys:read' })
        .handle(async ({ principal }) => {
          await seed()
          const rows = await store.listFor(principal.id)
          return {
            items: rows.map((r) => ({
              id: r.id,
              name: r.name,
              prefix: r.prefix,
              scopes: r.scopes,
              createdAt: r.createdAt,
              revoked: Boolean(r.revokedAt),
              expiresAt: r.expiresAt ?? null,
              expired: Boolean(r.expiresAt && Date.parse(r.expiresAt) <= Date.now()),
              lastUsedAt: r.lastUsedAt ?? null,
              lastUsedClient: r.lastUsedClient ?? null,
            })),
            nextCursor: null,
          }
        }),
      revoke: op({
        description: 'Revoke one of your API keys. Requests using it fail immediately.',
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string(), revoked: z.literal(true) }),
      })
        .traits({ destructive: true, idempotent: true, scope: 'apiKeys:write' })
        .handle(async ({ input, principal }) => {
          if (!(await store.revoke(input.id, principal.id))) throw errors.notFound(`No active key "${input.id}"`)
          return { id: input.id, revoked: true as const }
        }),
      revokeAll: op({
        description: 'Revoke every active API key you own. Requests using them fail immediately.',
        output: z.object({ revoked: z.number() }),
      })
        .traits({ destructive: true, idempotent: true, scope: 'apiKeys:write' })
        .handle(async ({ principal }) => ({ revoked: await store.revokeAll(principal.id) })),
    },
  }

  if (!options.revokeAll) delete (ops.apiKeys as { revokeAll?: unknown }).revokeAll

  const plugin = definePlugin<{}, typeof ops>({
    name: 'apiKeys',
    ops,
    // What this plugin adds to each facet. Presentation only: a key still means whatever the
    // `authenticate` stage says it means, on every facet at once.
    adapters: {
      rest: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'An API key issued by this app' },
        },
      },
      cli: {
        commands: [{ command: 'whoami', summary: 'Show who the current credential authenticates as', op: 'auth.whoami' }],
      },
    },
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
              // Sole authenticator: an unrecognised key is a bad key, not somebody else's token.
              if (!result) throw errors.unauthenticated('Invalid or revoked API key')
              inv.principal = result.principal
            },
          },
        }),
  })
  /** The same keys as an {@link AuthAdapter}, for `auth({ adapters: [...] })`. */
  return Object.assign(plugin, { adapter, store })
}
