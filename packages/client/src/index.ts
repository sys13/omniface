import type { App, InferIn, InferOut, Manifest, ManifestOp, Op } from 'omniface'

// ---------------------------------------------------------------------------------------------
// Errors

export type ClientErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal'
  | 'network'

/** The same error model as the server, rebuilt from Problem Details. */
export class FacetClientError extends Error {
  readonly code: ClientErrorCode
  readonly status?: number
  readonly issues?: { message: string; path: string }[]
  readonly retryAfter?: number
  readonly requestId?: string

  constructor(
    code: ClientErrorCode,
    message: string,
    extra: { status?: number; issues?: { message: string; path: string }[]; retryAfter?: number; requestId?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: extra.cause })
    this.name = 'FacetClientError'
    this.code = code
    this.status = extra.status
    this.issues = extra.issues
    this.retryAfter = extra.retryAfter
    this.requestId = extra.requestId
  }
}

// ---------------------------------------------------------------------------------------------
// The caller: manifest-driven, shared by the SDK proxy and the CLI engine

export type ClientOptions = {
  baseUrl: string
  apiKey?: string
  /** Embedded manifest. Without one, it is fetched from /.well-known/facet.json on first call. */
  manifest?: Manifest
  fetch?: typeof fetch
  /** Retries for rate limits (any op) and 5xx / network errors (readonly or idempotent ops). Default 2. */
  retries?: number
  /** Longest single wait honoured from Retry-After, in ms. Default 30s. */
  maxRetryWaitMs?: number
  /** Sent as X-Facet-Client so server logs and audit know the caller. */
  clientName?: string
  /** Which facet this runtime is serving, sent as X-Facet-Via. Default 'sdk'; the CLI engine sets 'cli'. */
  via?: 'sdk' | 'cli'
  headers?: Record<string, string>
}

export interface Caller {
  manifest(): Promise<Manifest>
  call(id: string, input?: unknown): Promise<unknown>
  iterate(id: string, input?: Record<string, unknown>): AsyncIterable<unknown>
  /** Every page of a paginated op, collected. Fetches all of them, so mind the size. */
  collect(id: string, input?: Record<string, unknown>): Promise<unknown[]>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createCaller(options: ClientOptions): Caller {
  const doFetch = options.fetch ?? fetch
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const retries = options.retries ?? 2
  const maxWait = options.maxRetryWaitMs ?? 30_000
  let manifestPromise: Promise<Manifest> | undefined

  const manifest = () =>
    (manifestPromise ??= options.manifest
      ? Promise.resolve(options.manifest)
      : doFetch(`${baseUrl}/.well-known/facet.json`).then(async (res) => {
          if (!res.ok) throw new FacetClientError('network', `Could not load manifest from ${baseUrl} (${res.status})`)
          return (await res.json()) as Manifest
        }))

  function buildRequest(op: ManifestOp, input: Record<string, unknown>) {
    const rest = op.rest!
    let path = rest.path
    const remaining: Record<string, unknown> = { ...input }
    for (const param of rest.pathParams) {
      if (remaining[param] === undefined) {
        throw new FacetClientError('invalid_input', `Missing required path parameter "${param}"`)
      }
      path = path.replace(`{${param}}`, encodeURIComponent(String(remaining[param])))
      delete remaining[param]
    }
    const url = new URL(baseUrl + path)
    let body: string | undefined
    if (rest.method === 'GET' || rest.method === 'DELETE') {
      for (const [key, value] of Object.entries(remaining)) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, typeof v === 'object' ? JSON.stringify(v) : String(v))
        else url.searchParams.set(key, typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value))
      }
    } else {
      body = JSON.stringify(remaining)
    }
    return { url: url.toString(), method: rest.method, body }
  }

  async function call(id: string, input: unknown = {}): Promise<unknown> {
    const m = await manifest()
    const op = m.ops.find((o) => o.id === id)
    if (!op) throw new FacetClientError('not_found', `Unknown operation "${id}"`)
    if (!op.rest) throw new FacetClientError('not_found', `Operation "${id}" is not exposed over HTTP`)
    const { url, method, body } = buildRequest(op, (input ?? {}) as Record<string, unknown>)
    const retryable = Boolean(op.traits.readonly || op.traits.idempotent)
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-omniface-client': options.clientName ?? '@omniface/client/0.0.1',
      'x-omniface-via': options.via ?? 'sdk',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      // One key per logical call, reused across retries, so a retried write lands once.
      ...(op.traits.idempotent && !op.traits.readonly ? { 'idempotency-key': crypto.randomUUID() } : {}),
      ...options.headers,
    }

    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await doFetch(url, { method, headers, body })
      } catch (cause) {
        if (retryable && attempt < retries) {
          await sleep(200 * 2 ** attempt)
          continue
        }
        throw new FacetClientError('network', `Request to ${url} failed`, { cause })
      }
      if (res.ok) {
        if (res.status === 204) return undefined
        return res.json()
      }
      const problem = (await res.json().catch(() => ({}))) as {
        code?: ClientErrorCode
        detail?: string
        issues?: { message: string; path: string }[]
        retryAfter?: number
        requestId?: string
      }
      const retryAfter = problem.retryAfter ?? (Number(res.headers.get('retry-after')) || undefined)
      const err = new FacetClientError(problem.code ?? (res.status >= 500 ? 'internal' : 'invalid_input'), problem.detail ?? res.statusText, {
        status: res.status,
        issues: problem.issues,
        retryAfter,
        requestId: problem.requestId ?? res.headers.get('x-request-id') ?? undefined,
      })
      // A rate-limited request never reached the handler, so it is safe to retry for any op.
      const canRetry = attempt < retries && (res.status === 429 || (res.status >= 500 && retryable))
      const waitMs = res.status === 429 ? (retryAfter ?? 1) * 1000 : 200 * 2 ** attempt
      if (canRetry && waitMs <= maxWait) {
        await sleep(waitMs)
        continue
      }
      throw err
    }
  }

  async function* iterate(id: string, input: Record<string, unknown> = {}): AsyncIterable<unknown> {
    let cursor = input.cursor as string | undefined
    do {
      const page = (await call(id, { ...input, ...(cursor ? { cursor } : {}) })) as { items: unknown[]; nextCursor: string | null }
      yield* page.items
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }

  async function collect(id: string, input: Record<string, unknown> = {}): Promise<unknown[]> {
    const items: unknown[] = []
    for await (const item of iterate(id, input)) items.push(item)
    return items
  }

  return { manifest, call, iterate, collect }
}

// ---------------------------------------------------------------------------------------------
// The inferred TypeScript client: createClient<typeof app>()

type Args<I> = {} extends I ? [input?: I] : [input: I]

type Method<I, O> = ((...args: Args<I>) => Promise<O>) &
  (O extends { items: (infer Item)[]; nextCursor: string | null }
    ? {
        /** Every page, one item at a time, fetching as it goes. */
        iterate(...args: Args<I>): AsyncIterable<Item>
        /** Every page, collected into one array. Fetches all of them, so mind the size. */
        autoPaginate(...args: Args<I>): Promise<Item[]>
      }
    : {})

export type ClientOf<T> = {
  [K in keyof T]: T[K] extends Op<infer I, infer O> ? Method<InferIn<I>, InferOut<O>> : ClientOf<T[K]>
}

export type InferClient<A> = A extends App<infer T> ? ClientOf<T> : never

export type Client<A> = InferClient<A> & { readonly $caller: Caller }

export function createClient<A extends App<any>>(options: ClientOptions): Client<A> {
  const caller = createCaller(options)
  const node = (path: string[]): any =>
    new Proxy(() => {}, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined
        if (path.length === 0 && prop === '$caller') return caller
        if (path.length === 0 && prop === 'then') return undefined
        if (prop === 'iterate' && path.length > 0) return (input?: Record<string, unknown>) => caller.iterate(path.join('.'), input)
        if (prop === 'autoPaginate' && path.length > 0) return (input?: Record<string, unknown>) => caller.collect(path.join('.'), input)
        return node([...path, prop])
      },
      apply(_target, _this, args: unknown[]) {
        return caller.call(path.join('.'), args[0])
      },
    })
  return node([])
}
