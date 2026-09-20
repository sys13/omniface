import { Hono, type Context } from 'hono'
import { credentialFromAdapters } from '../adapters.ts'
import type { App } from '../app.ts'
import { toFacetError } from '../errors.ts'
import { coerceString, objectProperties, typeOf } from '../jsonschema.ts'
import { buildManifest, type Manifest, type ManifestOp } from '../manifest.ts'
import { presentFields } from '../presentation.ts'
import { credentialFromHeaders, newRequestId } from './http.ts'
import { renderIndex, renderScreen, type ScreenContext } from './web.ts'

/**
 * Mounting the web facet (docs/BACKLOG.md 12.5): the screens, served.
 *
 * Nothing here can run an operation the manifest does not project onto a screen, and nothing here
 * runs one any other way than `app.invoke` — the same call path a `curl` takes, with the same
 * plugins in the same order. A screen is a projection; this is the router for it.
 *
 * What a page needs that an API must not have is its own security posture, so it gets one: a CSP
 * that permits the inlined style and script and nothing else, and `form-action 'self'` so a
 * submission cannot be redirected off-origin. Writes carry a double-submit CSRF token on top of
 * the origin check the shared security middleware already makes, because a console is the one
 * facet that carries ambient authority — a cookie the browser attaches whether the person meant
 * it or not.
 *
 * Sign-in itself is 2.6: until the per-facet auth presentation lands, a session reaches the
 * pipeline the way it already does everywhere else — through the request headers, which the auth
 * plugin's adapters read.
 */

/**
 * A page may run its own inlined script and style, call its own origin, and submit to itself.
 * Nothing else. `connect-src 'self'` is what lets a WebMCP tool body reach the op's REST route —
 * its own origin and no other, which is also the answer to "where can a tool send my data".
 */
export const WEB_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

const CSRF_COOKIE = 'facet_csrf'
const CSRF_FIELD = '_csrf'

export type WebAppOptions = {
  /** Overrides `facets.web.path`, for a host app that mounts the router somewhere else. */
  basePath?: string
  /** Turn the CSRF token off. Only for a host app that has its own, and says so. */
  csrf?: false
  /** For tests: a fixed token instead of a random one. */
  newToken?: () => string
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

/** Constant-time-ish: same length, every byte compared. Tokens are ours, so length is not secret. */
function tokenMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Form values are strings; ops take types. The coercion is `coerceString`, the same one REST uses
 * on a query string, so a number is a number on both. An unchecked box sends nothing, which is
 * how HTML says `false` — for a boolean field that is a value, not an absence.
 */
function inputFromForm(op: ManifestOp, form: Record<string, string>, params: Record<string, string>): Record<string, unknown> {
  const props = objectProperties(op.input)
  const input: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(props)) {
    if (op.web!.pathParams.includes(name)) continue
    const raw = form[name]
    if (typeOf(schema) === 'boolean') {
      input[name] = raw !== undefined && raw !== '' && raw !== 'false'
      continue
    }
    if (raw === undefined || raw === '') continue
    input[name] = coerceString(raw, schema)
  }
  for (const p of op.web!.pathParams) if (params[p] !== undefined) input[p] = params[p]
  return input
}

/** The input a table or detail screen is answered with: its route params plus its query string. */
function inputFromQuery(op: ManifestOp, c: Context, params: Record<string, string>): Record<string, unknown> {
  const props = objectProperties(op.input)
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(c.req.query())) {
    if (key in props) input[key] = coerceString(value, props[key])
  }
  for (const [key, value] of Object.entries(params)) if (key in props) input[key] = value
  return input
}

/** A validation failure, mapped back onto the fields the person was looking at. */
function fieldErrors(op: ManifestOp, issues: { path: string; message: string }[] | undefined): Record<string, string> {
  const names = new Set(presentFields(op.input).map((f) => f.name))
  const out: Record<string, string> = {}
  for (const issue of issues ?? []) {
    const field = issue.path.split('.')[0]!.replace(/\[.*$/, '')
    if (names.has(field)) out[field] ??= issue.message
  }
  return out
}

/** Where a successful write lands: the app's `then`, else the resource's table, else the index. */
function landingUrl(manifest: Manifest, op: ManifestOp, base: string, result: unknown): string {
  const id = result && typeof result === 'object' ? (result as Record<string, unknown>)['id'] : undefined
  const fill = (target: ManifestOp): string | undefined => {
    let path = target.web!.path
    for (const p of target.web!.pathParams) {
      const value = p === 'id' && id !== undefined ? String(id) : undefined
      if (value === undefined) return undefined
      path = path.replace(`{${p}}`, encodeURIComponent(value))
    }
    return `${base}${path === '/' ? '' : path}` || '/'
  }
  const then = op.web!.then
  if (then && then !== 'back') {
    const target = manifest.ops.find((o) => o.id === then && o.web)
    const url = target ? fill(target) : undefined
    if (url) return url
  }
  const table = manifest.ops.find((o) => o.web?.kind === 'table' && o.path[0] === op.path[0])
  return (table && fill(table)) ?? base ?? '/'
}

/**
 * Static before dynamic, segment by segment: `/tasks/new` has to be tried before `/tasks/{id}`, or
 * the form screen is answered by the detail screen with an id of "new". Ops that tie keep manifest
 * order, so a route's position is still something an author can reason about.
 */
function routeOrder(manifest: Manifest): ManifestOp[] {
  const segments = (op: ManifestOp) => op.web!.path.split('/').filter(Boolean)
  return manifest.ops
    .filter((op) => op.web)
    .map((op, i) => ({ op, i }))
    .sort((a, b) => {
      const as = segments(a.op)
      const bs = segments(b.op)
      for (let i = 0; i < Math.min(as.length, bs.length); i++) {
        const dynamic = (s: string) => (s.startsWith('{') ? 1 : 0)
        if (dynamic(as[i]!) !== dynamic(bs[i]!)) return dynamic(as[i]!) - dynamic(bs[i]!)
      }
      return a.i - b.i
    })
    .map((x) => x.op)
}

/**
 * Every screen the manifest projects, as routes. `GET` renders; `POST` runs the op and redirects,
 * so a reload does not re-submit. A screen for an op the app turned off is not mounted at all.
 */
export function createWebApp(app: App, manifest: Manifest = buildManifest(app), options: WebAppOptions = {}): Hono {
  const hono = new Hono()
  const base = options.basePath ?? manifest.web?.path ?? ''
  const adapters = app.adapters ?? []
  const csrfOn = options.csrf !== false
  const mint = options.newToken ?? randomToken

  const page = (c: Context, html: string, status = 200) => {
    c.header('content-security-policy', WEB_CSP)
    return c.html(html, status as 200)
  }

  /** One per session, set on the first GET and reused after: the other half of the double submit. */
  const csrfToken = (c: Context): string | undefined => {
    if (!csrfOn) return undefined
    const existing = readCookie(c.req.header('cookie'), CSRF_COOKIE)
    if (existing) return existing
    const token = mint()
    const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : ''
    c.header('set-cookie', `${CSRF_COOKIE}=${token}; Path=${base || '/'}; SameSite=Lax; HttpOnly${secure}`, { append: true })
    return token
  }

  const invoke = (c: Context, op: ManifestOp, input: Record<string, unknown>) =>
    app.invoke(op.id, input, {
      facet: 'web',
      requestId: c.req.header('x-request-id') ?? newRequestId(),
      // The `rest` adapter slot, on purpose: a screen is an HTTP request with the same headers and
      // the same cookies, so a plugin that can find a credential in one can find it in the other.
      // A slot of its own would be a second place for the same answer to be given differently.
      credential: credentialFromHeaders(c.req.raw.headers) ?? credentialFromAdapters(adapters, 'rest', c.req.raw),
      headers: c.req.raw.headers,
    })

  const errorPage = (c: Context, op: ManifestOp, raw: unknown, ctx: ScreenContext) => {
    const err = toFacetError(raw)
    const fields = fieldErrors(op, err.issues)
    return page(
      c,
      renderScreen(manifest, op.id, {
        ...ctx,
        error: {
          title: err.code.replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase()),
          detail: err.message,
          code: err.code,
          ...(Object.keys(fields).length ? { fields } : {}),
        },
      }),
      err.status,
    )
  }

  hono.get(base || '/', (c) => page(c, renderIndex(manifest, { basePath: base, csrfToken: csrfToken(c) })))

  for (const op of routeOrder(manifest)) {
    const route = `${base}${op.web!.path === '/' ? '' : op.web!.path}`.replace(/\{([^}]+)\}/g, ':$1') || '/'
    const reads = op.web!.kind !== 'form'

    hono.get(route, async (c) => {
      const params = c.req.param() as Record<string, string>
      const ctx: ScreenContext = { basePath: base, params, csrfToken: csrfToken(c) }
      // A form is shown before anything runs; a table or a detail *is* the op's answer.
      if (!reads) return page(c, renderScreen(manifest, op.id, ctx))
      try {
        const data = await invoke(c, op, inputFromQuery(op, c, params))
        return page(c, renderScreen(manifest, op.id, { ...ctx, data }))
      } catch (raw) {
        return errorPage(c, op, raw, ctx)
      }
    })

    if (reads) continue

    hono.post(route, async (c) => {
      const params = c.req.param() as Record<string, string>
      const form = Object.fromEntries(
        [...(await c.req.raw.clone().formData())].map(([k, v]) => [k, typeof v === 'string' ? v : '']),
      ) as Record<string, string>
      const ctx: ScreenContext = { basePath: base, params, csrfToken: csrfToken(c), values: form }
      if (csrfOn && !tokenMatches(readCookie(c.req.header('cookie'), CSRF_COOKIE), form[CSRF_FIELD])) {
        // Deliberately not a facet error: nothing reached the pipeline, and there is nothing about
        // the op to say. The person's own form works; a form posted from somewhere else does not.
        return page(
          c,
          renderScreen(manifest, op.id, {
            ...ctx,
            error: { title: 'Expired form', detail: 'Reload the page and try again.', code: 'forbidden' },
          }),
          403,
        )
      }
      try {
        const result = await invoke(c, op, inputFromForm(op, form, params))
        return c.redirect(landingUrl(manifest, op, base, result), 303)
      } catch (raw) {
        return errorPage(c, op, raw, ctx)
      }
    })
  }

  return hono
}
