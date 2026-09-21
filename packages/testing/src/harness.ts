import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { EXIT_CODES, runCli } from '@omniface/cli'
import { createClient, FacetClientError } from '@omniface/client'
import { buildManifest, cliOf, createServer, mcpOf, restOf, webOf, webSettings, type App, type Manifest } from 'omniface'
import { createMcpServer } from 'omniface/mcp'

export const CHANNELS = ['rest', 'sdk', 'cli', 'mcp', 'web'] as const
export type Channel = (typeof CHANNELS)[number]

export type Outcome =
  | {
      ok: true
      value: unknown
      /**
       * The channel answered with a page rather than a document, and `value` is `{ html }`. A
       * screen is a real answer — it succeeded or it refused, with the same code — but what it
       * carries is laid out for a person, so comparing it field for field against JSON would be
       * comparing a rendering to a record. `outcomesAgree` compares everything else, and a test
       * that cares what reached the page (redaction, an internal field) reads the HTML.
       */
      presentation?: boolean
    }
  | { ok: false; code: string; message: string; retryAfter?: number; presentation?: boolean }

export type HarnessOptions = { apiKey?: string }

/** Per-call knobs. `idempotencyKey` is carried the way each facet carries one. */
export type CallOptions = { apiKey?: string; idempotencyKey?: string }

/** The origin every in-process facet is driven against. Exported so a case can build a raw request. */
export const BASE_URL = 'http://facet.test'

/**
 * Drive one app through every MVP facet, the way a real consumer would: raw HTTP, the TS SDK,
 * the CLI engine, and an MCP client. No network: everything runs in-process.
 */
export function createHarness(app: App, options: HarnessOptions = {}) {
  const manifest: Manifest = buildManifest(app)
  const server = createServer(app)
  const fetchFn: typeof fetch = async (input, init) => server.fetch(new Request(input, init))
  const configDir = mkdtempSync(join(tmpdir(), 'facet-harness-'))

  let mcp: Promise<McpClient> | undefined
  const mcpClient = (apiKey: string | undefined) => {
    const connect = async () => {
      const mcpServer = createMcpServer(app, { manifest, credential: apiKey ? { type: 'bearer', token: apiKey } : undefined })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const client = new McpClient({ name: 'facet-harness', version: '0.0.1' })
      await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)])
      return client
    }
    if (apiKey !== options.apiKey) return connect()
    return (mcp ??= connect())
  }

  function opOf(id: string) {
    const op = manifest.ops.find((o) => o.id === id)
    if (!op) throw new Error(`harness: unknown op ${id}`)
    return op
  }

  async function viaRest(id: string, input: Record<string, unknown>, apiKey?: string, idempotencyKey?: string): Promise<Outcome> {
    const op = opOf(id)
    const binding = restOf(op)
    if (!binding) throw new Error(`harness: ${id} has no REST binding`)
    let path = binding.path
    const rest = { ...input }
    for (const p of binding.pathParams) {
      // A path param has no "absent" over HTTP: leaving it out would silently send "undefined".
      if (rest[p] === undefined || rest[p] === '') throw new Error(`harness: ${id} needs a value for the path param "${p}"`)
      path = path.replace(`{${p}}`, encodeURIComponent(String(rest[p])))
      delete rest[p]
    }
    const url = new URL(BASE_URL + path)
    const init: RequestInit = { method: binding.method, headers: {} as Record<string, string> }
    if (apiKey) (init.headers as Record<string, string>).authorization = `Bearer ${apiKey}`
    if (idempotencyKey) (init.headers as Record<string, string>)['idempotency-key'] = idempotencyKey
    if (binding.method === 'GET' || binding.method === 'DELETE') {
      for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    } else {
      init.body = JSON.stringify(rest)
      ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
    }
    const res = await fetchFn(url, init)
    const body = (await res.json()) as any
    if (res.ok) return { ok: true, value: body }
    return { ok: false, code: body.code, message: body.detail, ...(body.retryAfter !== undefined ? { retryAfter: body.retryAfter } : {}) }
  }

  async function viaSdk(id: string, input: Record<string, unknown>, apiKey?: string, idempotencyKey?: string): Promise<Outcome> {
    const client = createClient<App>({
      baseUrl: BASE_URL,
      apiKey,
      manifest,
      fetch: fetchFn,
      retries: 0,
      clientName: 'facet-harness/0.0.1',
      ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
    })
    try {
      return { ok: true, value: await client.$caller.call(id, input) }
    } catch (err) {
      if (err instanceof FacetClientError) {
        return { ok: false, code: err.code, message: err.message, ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}) }
      }
      throw err
    }
  }

  async function viaCli(id: string, input: Record<string, unknown>, apiKey?: string, idempotencyKey?: string): Promise<Outcome> {
    const op = opOf(id)
    const binding = cliOf(op)
    if (!binding) throw new Error(`harness: ${id} has no CLI binding`)
    let stdout = ''
    let stderr = ''
    const argv = [...binding.command, '--json', JSON.stringify(input), '--output', 'json', '--yes', '--base-url', BASE_URL]
    if (apiKey) argv.push('--api-key', apiKey)
    if (idempotencyKey) argv.push('--idempotency-key', idempotencyKey)
    const code = await runCli({
      manifest,
      argv,
      fetch: fetchFn,
      retries: 0,
      configDir,
      env: {},
      io: { stdout: { write: (s) => void (stdout += s), isTTY: false }, stderr: { write: (s) => void (stderr += s) }, stdinIsTTY: false },
    })
    if (code === 0) return { ok: true, value: JSON.parse(stdout) }
    const errorCode = Object.entries(EXIT_CODES).find(([k, v]) => v === code && k !== 'usage')?.[0] ?? `exit_${code}`
    const retry = /Try again in (\d+)s/.exec(stderr)
    const message = /^Error(?: \([a-z_]+\))?: (.*)$/m.exec(stderr)?.[1] ?? stderr
    return { ok: false, code: errorCode, message, ...(retry ? { retryAfter: Number(retry[1]) } : {}) }
  }

  async function viaMcp(id: string, input: Record<string, unknown>, apiKey?: string, idempotencyKey?: string): Promise<Outcome> {
    const op = opOf(id)
    const binding = mcpOf(op)
    if (!binding) throw new Error(`harness: ${id} has no MCP binding`)
    const client = await mcpClient(apiKey)
    const meta = idempotencyKey ? { _meta: { 'omniface/idempotency-key': idempotencyKey } } : {}
    const result =
      'group' in binding
        ? await client.callTool({ name: binding.group, arguments: { action: op.path.at(-1), input }, ...meta })
        : await client.callTool({ name: binding.tool, arguments: input, ...meta })
    if (result.isError) {
      const err = (result._meta as any)?.['omniface/error'] ?? { code: 'unknown', message: '' }
      return { ok: false, code: err.code, message: err.message, ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}) }
    }
    if (result.structuredContent) return { ok: true, value: result.structuredContent }
    const text = (result.content as { type: string; text: string }[])[0]!.text.split('\n\nMore results available')[0]!
    return { ok: true, value: JSON.parse(text) }
  }

  /**
   * The web facet, driven the way a person drives it: open the screen, or open the screen, take
   * the form and its CSRF token, and submit it. Nothing here calls the op directly — if a screen
   * cannot be reached by clicking, conformance should not be able to reach it either.
   */
  async function viaWeb(id: string, input: Record<string, unknown>, apiKey?: string): Promise<Outcome> {
    const op = opOf(id)
    const screen = webOf(op)
    if (!screen) throw new Error(`harness: ${id} has no web screen`)
    const base = webSettings(manifest)?.path ?? ''
    const rest = { ...input }
    let path = screen.path
    for (const p of screen.pathParams) {
      path = path.replace(`{${p}}`, encodeURIComponent(String(rest[p] ?? '')))
      delete rest[p]
    }
    const url = new URL(`${BASE_URL}${base}${path === '/' ? '' : path}`)
    const headers: Record<string, string> = {}
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const read = async (res: Response): Promise<Outcome> => {
      const html = await res.text()
      if (res.ok || res.status === 303) return { ok: true, value: { html }, presentation: true }
      const code = /<meta name="facet-error" content="([^"]+)">/.exec(html)?.[1] ?? `status_${res.status}`
      const detail = /<div class="err"><strong>[^<]*<\/strong><p>([^<]*)<\/p>/.exec(html)?.[1] ?? ''
      const retry = res.headers.get('retry-after')
      return { ok: false, code, message: detail, presentation: true, ...(retry ? { retryAfter: Number(retry) } : {}) }
    }

    if (screen.kind !== 'form') {
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
      return read(await fetchFn(url, { headers }))
    }

    // A write starts on the page it is written on: that is where the token comes from.
    const form = await fetchFn(url, { headers })
    const html = await form.text()
    if (!form.ok) return read(new Response(html, { status: form.status, headers: form.headers }))
    const token = /name="_csrf" value="([^"]*)"/.exec(html)?.[1] ?? ''
    const cookie = (form.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue
      body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    if (token) body.set('_csrf', token)
    return read(
      await fetchFn(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
        body: body.toString(),
      }),
    )
  }

  const channels = { rest: viaRest, sdk: viaSdk, cli: viaCli, mcp: viaMcp, web: (id: string, input: Record<string, unknown>, apiKey?: string) => viaWeb(id, input, apiKey) }

  /** The facets this op is actually projected to, in CHANNELS order. */
  function channelsFor(id: string): Channel[] {
    const op = opOf(id)
    return CHANNELS.filter((c) => op.facets[c] != null)
  }

  return {
    manifest,
    server,
    fetch: fetchFn,
    channelsFor,
    /**
     * A call that claims to come from the agent in a visitor's browser — the claim a page makes
     * with `X-Facet-Via: webmcp`. It goes over REST, because that is the only way a browser can
     * reach the pipeline, and it exists so conformance can call an op the page never advertised.
     */
    async callAsAgent(id: string, input: Record<string, unknown> = {}, opts: CallOptions = options): Promise<Outcome> {
      const op = opOf(id)
      const binding = restOf(op)
      if (!binding) throw new Error(`harness: ${id} has no REST binding`)
      const rest = { ...input }
      let path = binding.path
      for (const p of binding.pathParams) {
        path = path.replace(`{${p}}`, encodeURIComponent(String(rest[p] ?? '')))
        delete rest[p]
      }
      const url = new URL(BASE_URL + path)
      const headers: Record<string, string> = { 'x-omniface-via': 'webmcp', 'x-omniface-client': 'facet-harness/0.0.1' }
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`
      const init: RequestInit = { method: binding.method, headers }
      if (binding.method === 'GET' || binding.method === 'DELETE') {
        for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      } else {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(rest)
      }
      const res = await fetchFn(url, init)
      const body = (await res.json()) as any
      return res.ok ? { ok: true, value: body } : { ok: false, code: body.code, message: body.detail }
    },
    /** A write posted to its screen with no CSRF token, the way a cross-site form would arrive. */
    async postWithoutToken(id: string, input: Record<string, unknown> = {}, opts: CallOptions = options): Promise<Outcome> {
      const op = opOf(id)
      const screen = webOf(op)
      if (screen?.kind !== 'form') throw new Error(`harness: ${id} has no web form`)
      const base = webSettings(manifest)?.path ?? ''
      const rest = { ...input }
      let path = screen.path
      for (const p of screen.pathParams) {
        path = path.replace(`{${p}}`, encodeURIComponent(String(rest[p] ?? '')))
        delete rest[p]
      }
      const body = new URLSearchParams()
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined && v !== null) body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`
      const res = await fetchFn(new URL(`${BASE_URL}${base}${path === '/' ? '' : path}`), {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: body.toString(),
      })
      const html = await res.text()
      if (res.ok || res.status === 303) return { ok: true, value: { html }, presentation: true }
      const code = /<meta name="facet-error" content="([^"]+)">/.exec(html)?.[1] ?? `status_${res.status}`
      return { ok: false, code, message: '', presentation: true }
    },
    /** `opts.apiKey: undefined` calls with no credential; omitting `opts` uses the harness key. */
    call(channel: Channel, id: string, input: Record<string, unknown> = {}, opts: CallOptions = options): Promise<Outcome> {
      return channels[channel](id, input, opts.apiKey, opts.idempotencyKey)
    },
    /**
     * One op through every facet it is projected to, sequentially (so rate limits and writes are
     * deterministic). Pass `only` to narrow the channels.
     */
    async callAll(
      id: string,
      input: Record<string, unknown> = {},
      opts: CallOptions = options,
      only?: readonly Channel[],
    ): Promise<Record<Channel, Outcome>> {
      const out = {} as Record<Channel, Outcome>
      for (const channel of only ?? channelsFor(id)) {
        out[channel] = await channels[channel](id, input, opts.apiKey, opts.idempotencyKey)
      }
      return out
    },
  }
}

export type Harness = ReturnType<typeof createHarness>

/**
 * The drift check: every facet agrees on success vs. error code (and on values, when asked).
 * Channels the op is not projected to may be left out; the first one present is the baseline.
 */
export function outcomesAgree(outcomes: Partial<Record<Channel, Outcome>>, { compareValues = true } = {}): string[] {
  const problems: string[] = []
  const present = CHANNELS.filter((c) => outcomes[c])
  const base = present.find((c) => c === 'rest') ?? present[0]
  if (!base) return problems
  const baseline = outcomes[base]!
  for (const channel of present) {
    const o = outcomes[channel]!
    if (o.ok !== baseline.ok) problems.push(`${channel}: ok=${o.ok}, ${base}: ok=${baseline.ok}`)
    else if (!o.ok && !baseline.ok && o.code !== baseline.code) problems.push(`${channel}: ${o.code}, ${base}: ${baseline.code}`)
    else if (
      o.ok &&
      baseline.ok &&
      compareValues &&
      !o.presentation &&
      !baseline.presentation &&
      JSON.stringify(o.value) !== JSON.stringify(baseline.value)
    ) {
      problems.push(`${channel}: value differs from ${base}`)
    }
  }
  return problems
}
