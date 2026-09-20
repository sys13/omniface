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
}

/**
 * Where keys live. The built-in store is in memory; `fileKeyStore` and `sqlKeyStore` are the
 * durable ones, and anything else that satisfies this interface works the same way.
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
  }
}

/** How a key is stored: never the secret, only its SHA-256. */
export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex')
const hashKey = hashApiKey

export type SeedKey = { key: string; principalId: string; name?: string; kind?: Principal['kind']; scopes: string[] }

export type ApiKeysOptions = {
  /** Keys that exist at startup (e.g. from env). */
  keys?: SeedKey[]
  store?: ApiKeyStore
  /** Prefix for generated keys, e.g. "acme_". */
  prefix?: string
  /**
   * Fill the `authenticate` stage. Default true. Set false when the keys are one provider among
   * several: pass `.adapter` to `auth({ adapters: [...] })` instead, so an unrecognised token can
   * fall through to the next provider rather than being rejected here.
   */
  authenticate?: boolean
}

export type ApiKeyAdapterOptions = {
  store: ApiKeyStore
  /** Keys that exist at startup, inserted on first use. */
  keys?: SeedKey[]
  /** Adapter name, for `ctx.auth.adapter`. Default `api-key`. */
  name?: string
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
  const seed = seeder(options.store, options.keys)
  return defineAuthAdapter({
    name: options.name ?? 'api-key',
    async authenticate(ctx) {
      if (!ctx.credential) return null
      await seed()
      const row = await options.store.findByHash(hashKey(ctx.credential.token))
      if (!row) return null
      if (row.revokedAt) throw errors.unauthenticated('API key has been revoked')
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
})

export function apiKeys(options: ApiKeysOptions = {}) {
  const store = options.store ?? memoryKeyStore()
  const keyPrefix = options.prefix ?? 'fk_'
  const seed = seeder(store, options.keys)
  const adapter = apiKeyAdapter({ store, ...(options.keys ? { keys: options.keys } : {}) })

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
        input: z.object({ name: z.string().min(1), scopes: z.array(z.string()).min(1) }),
        output: z.object({ id: z.string(), name: z.string(), key: z.string(), scopes: z.array(z.string()) }),
      })
        .traits({ scope: 'apiKeys:write' })
        .handle(async ({ input, principal }) => {
          const denied = input.scopes.filter((s) => !hasScope(principal.scopes, s))
          if (denied.length) throw errors.forbidden(`Cannot grant scopes you do not hold: ${denied.join(', ')}`)
          const key = keyPrefix + randomBytes(24).toString('base64url')
          const id = `key_${randomBytes(6).toString('hex')}`
          await store.insert({
            id,
            name: input.name,
            hash: hashKey(key),
            prefix: key.slice(0, keyPrefix.length + 4),
            scopes: input.scopes,
            principal: { id: principal.id, kind: principal.kind, ...(principal.name ? { name: principal.name } : {}) },
            createdAt: new Date().toISOString(),
          })
          return { id, name: input.name, key, scopes: input.scopes }
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
    },
  }

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
