import { objectProperties, type JSONSchema } from '../jsonschema.ts'
import { MINT_OP } from '../agent.ts'
import { isUntrusted, type Manifest, type ManifestOp } from '../manifest.ts'
import { mcpOf, mcpTools } from './mcp.facet.ts'
import { restOf } from './rest.facet.ts'
import { webOf, webSettings, type ManifestScreen } from './web.facet.ts'
import { conventionalToolName } from '../naming.ts'
import { humanLabel, presentFields, presentValue, tableColumns, type FieldPresentation } from '../presentation.ts'

/**
 * The web facet's renderer (docs/BACKLOG.md 12.2): a screen, as HTML, from the manifest's web
 * projection and an op's answer. Nothing here decides *what* a screen is — that is 12.1's
 * projection — and nothing here can render a screen the projection does not name, which is the
 * fence the epic is held to: no client framework, no build step, no component API, no dependency
 * added to the app. One stylesheet and one island script, both inlined, both replaceable whole.
 *
 * Mounting the screens, signing in and CSRF are 12.5. This module is pure — manifest plus data in,
 * a string out — which is also what lets it be tested without a browser.
 */

export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

export type ScreenContext = {
  /** Where the facet is mounted. `webSettings(manifest).path` unless a host app says otherwise. */
  basePath?: string
  /** Route params already resolved: `{ id: 'task_1' }`. */
  params?: Record<string, string>
  /** What the op returned, for a table or a detail. */
  data?: unknown
  /** What the person typed, for re-rendering a form that failed validation. */
  values?: Record<string, unknown>
  /**
   * A problem to show above the screen, rendered from the one error model every facet uses. `code`
   * is the model's own code, and it goes into a `<meta>` as well as the prose — a page is still an
   * answer, and conformance has to be able to read which answer it was.
   */
  error?: { title: string; detail?: string; code?: string; fields?: Record<string, string> }
  /** A CSRF token, rendered into every form. 12.5 mints it; the renderer only carries it. */
  csrfToken?: string
}

const STYLES = `
:root { --bg:#fbfbfa; --panel:#fff; --ink:#1c1c1a; --muted:#6b6b66; --line:#e6e5e1; --accent:#3b5bdb; --code:#f4f3f0; --danger:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --panel:#1c1c1a; --ink:#ecebe7; --muted:#9a9993; --line:#2e2d2a; --accent:#8da2fb; --code:#23221f; --danger:#f97066; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif, system-ui, sans-serif; }
a { color:var(--accent); }
header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
header h1 { font-size:16px; margin:0; }
header h1 a { color:inherit; text-decoration:none; }
header span { color:var(--muted); font-size:13px; }
main { display:grid; grid-template-columns:230px 1fr; min-height:calc(100vh - 53px); }
nav { border-right:1px solid var(--line); padding:12px 8px; }
nav h2 { font:600 11px ui-sans-serif, system-ui; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin:14px 10px 4px; }
nav a { display:block; padding:5px 10px; border-radius:6px; text-decoration:none; color:var(--ink); font-size:14px; }
nav a[aria-current=page] { background:var(--code); color:var(--accent); }
section { padding:24px; overflow:auto; }
h2.screen { margin:0 0 2px; font-size:22px; }
p.desc { color:var(--muted); margin:0 0 20px; }
table { border-collapse:collapse; width:100%; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); font-size:14px; }
th { font:600 11px ui-sans-serif, system-ui; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
tr:last-child td { border-bottom:0; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:8px 20px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; margin:0; }
dt { color:var(--muted); font-size:13px; }
dl dd { margin:0; }
form { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; max-width:560px; display:grid; gap:14px; }
label { display:grid; gap:4px; font-size:13px; color:var(--muted); }
input, select, textarea { font:inherit; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); width:100%; }
button { font:inherit; padding:7px 14px; border:1px solid var(--line); border-radius:6px; background:var(--accent); color:#fff; cursor:pointer; }
button.danger { background:var(--danger); border-color:var(--danger); }
.actions { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 18px; }
.actions a { display:inline-block; padding:6px 12px; border:1px solid var(--line); border-radius:6px; text-decoration:none; color:var(--ink); }
.actions a.danger { color:var(--danger); border-color:var(--danger); }
.hint { color:var(--muted); font-size:12px; }
.dep { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
.err { border:1px solid var(--danger); background:var(--panel); border-radius:8px; padding:12px 14px; margin:0 0 18px; }
.err strong { color:var(--danger); }
.err p { margin:4px 0 0; }
.empty { color:var(--muted); font-style:italic; }
.mask { font-family:ui-monospace, monospace; }
.reveal { background:none; border:0; color:var(--accent); cursor:pointer; padding:0 0 0 8px; font-size:12px; }
footer { grid-column:1/-1; border-top:1px solid var(--line); padding:10px 20px; color:var(--muted); font-size:12px; }
@media (max-width:720px) { main { grid-template-columns:1fr; } nav { border-right:0; border-bottom:1px solid var(--line); } }
`

/**
 * The island. Three jobs, and all three are things HTML alone cannot do: confirm a destructive
 * action before it runs, reveal a masked value to the person already entitled to it, and say how
 * long ago a timestamp was. Every screen still works with it turned off — the forms are forms,
 * the links are links, and a masked value stays masked.
 */
const SCRIPT = `
document.addEventListener('submit', (e) => {
  const message = e.target.dataset.confirm;
  if (message && !confirm(message)) e.preventDefault();
});
document.addEventListener('click', (e) => {
  const button = e.target.closest('.reveal');
  if (!button) return;
  const field = button.parentElement.querySelector('[data-masked]');
  const shown = field.dataset.shown === 'true';
  field.textContent = shown ? field.dataset.mask : field.dataset.value;
  field.dataset.shown = String(!shown);
  button.textContent = shown ? 'Reveal' : 'Hide';
});
for (const el of document.querySelectorAll('time[datetime]')) {
  const then = new Date(el.getAttribute('datetime'));
  if (isNaN(+then)) continue;
  const seconds = (Date.now() - +then) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const unit = units.find(([, size]) => Math.abs(seconds) >= size);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  el.title = el.textContent;
  el.textContent = unit ? rtf.format(-Math.round(seconds / unit[1]), unit[0]) : rtf.format(0, 'second');
}
`

/**
 * What the page registers with the browser's agent (docs/BACKLOG.md 12.6, the proposal's W1–W3).
 *
 * The descriptor is the MCP one wherever the MCP facet already computed it, so every override an
 * author wrote there — tool name, description, `maxItems`, hidden fields — carries across without
 * being written twice. The call is the op's REST route, which is why registration needs the REST
 * facet: a tool body in a browser reaches the pipeline the only way a browser can, over HTTP.
 */
export type WebTool = {
  name: string
  description: string
  inputSchema: JSONSchema
  annotations: { readOnlyHint: boolean; consequentialHint: boolean; idempotentHint: boolean; untrustedContentHint?: boolean }
  op: string
  request: { method: string; path: string; pathParams: string[] }
}

/**
 * Exactly the ops the app's agent declaration allows (12.7). This list is what the page
 * advertises; it is never what enforces anything — `app.invoke` refuses the rest whether they were
 * registered or not, which is the property 12.10 tests.
 */
export function webTools(manifest: Manifest): WebTool[] {
  if (!webSettings(manifest)?.agent) return []
  const out: WebTool[] = []
  for (const op of manifest.ops) {
    const rest = restOf(op)
    if (!webOf(op)?.agent || !rest) continue
    const tool = (() => { const m = mcpOf(op); return m && 'tool' in m ? mcpTools(manifest).find((t) => t.name === m.tool) : undefined })()
    const untrusted = isUntrusted(op.traits, op.output)
    out.push({
      name: tool?.name ?? conventionalToolName(op.path),
      description: tool?.description ?? op.description ?? op.id,
      inputSchema: tool?.inputSchema ?? (op.input.type === 'object' ? op.input : { type: 'object', properties: {} }),
      annotations: {
        readOnlyHint: Boolean(op.traits.readonly),
        // WebMCP's name for it: "this one has consequences, ask first".
        consequentialHint: Boolean(op.traits.destructive),
        idempotentHint: Boolean(op.traits.idempotent || op.traits.readonly),
        ...(untrusted ? { untrustedContentHint: true } : {}),
      },
      op: op.id,
      request: { method: rest.method, path: rest.path, pathParams: rest.pathParams },
    })
  }
  return out
}

/**
 * Where the page asks for its attenuated token, or `null` when the app said `session` — in which
 * case the tools lean on the cookie, and the page says so in `window.facetAgent.attenuated`.
 */
function mintPath(manifest: Manifest): string | null {
  if (webSettings(manifest)?.agentCredential !== 'attenuated') return null
  const mint = manifest.ops.find((o) => o.id === MINT_OP)
  return (mint && restOf(mint)?.path) ?? null
}

/**
 * The registration half of the island. It calls the op's own REST route, same-origin, saying
 * `X-Facet-Via: webmcp` so logs and audit record what it was — a claim, which narrows what the
 * pipeline allows and widens nothing — and threads the agent's `AbortSignal` into the fetch so a
 * cancelled task actually stops. `window.facetAgent.unregister()` takes the tools back down.
 */
function registrationScript(tools: WebTool[], client: string, mint: string | null): string {
  // `<` escaped, so a description or a field name containing `</script>` cannot end the block.
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
  return `
const facetTools = ${json(tools)};
const facetClient = ${json(client)};
const facetMintPath = ${json(mint)};
let facetToken = null;
// The agent gets a credential of its own, weaker than the person's, or it gets nothing (12.8).
// Falling back to the ambient cookie here would hand it the whole session, which is the failure
// this is here to prevent — so a page that cannot mint registers no tools at all.
async function facetMintToken() {
  if (!facetMintPath) return null;
  const res = await fetch(facetMintPath, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-omniface-via': 'webmcp', 'x-omniface-client': facetClient },
    body: JSON.stringify({ note: 'browser agent' }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body && body.token ? body.token : null;
}
async function facetCall(tool, input, signal) {
  const body = { ...input };
  let path = tool.request.path;
  for (const p of tool.request.pathParams) {
    path = path.replace('{' + p + '}', encodeURIComponent(String(body[p] ?? '')));
    delete body[p];
  }
  const headers = { 'x-omniface-via': 'webmcp', 'x-omniface-client': facetClient };
  if (facetToken) headers.authorization = 'Bearer ' + facetToken;
  let url = path;
  const init = { method: tool.request.method, headers, signal, credentials: 'same-origin' };
  if (tool.request.method === 'GET' || tool.request.method === 'DELETE') {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) query.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    if ([...query].length) url += '?' + query;
  } else {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res = await fetch(url, init);
  // A short-lived token expires mid-task by design; one silent re-mint is the difference between
  // that being a design and being an annoyance. Only once, and only for this call.
  if (res.status === 401 && facetMintPath && facetToken) {
    facetToken = await facetMintToken();
    if (!facetToken) throw new Error('This page can no longer act for you. Reload it.');
    headers.authorization = 'Bearer ' + facetToken;
    res = await fetch(url, init);
  }
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  // The one error model, as the agent sees it: the problem document's own words.
  if (!res.ok) throw new Error((parsed && (parsed.detail || parsed.title)) || res.statusText);
  return parsed;
}
async function facetRegister() {
  if (!globalThis.document || !document.modelContext || !facetTools.length) return;
  if (facetMintPath) {
    facetToken = await facetMintToken();
    if (!facetToken) return;
  }
  const handles = [];
  for (const tool of facetTools) {
    const handle = document.modelContext.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      execute: (input, context) => facetCall(tool, input ?? {}, context && context.signal),
    });
    handles.push(handle);
  }
  const settled = await Promise.allSettled(handles);
  window.facetAgent = {
    tools: facetTools.map((t) => t.name),
    attenuated: Boolean(facetMintPath),
    unregister() {
      for (const s of settled) {
        const handle = s.value;
        if (handle && typeof handle.unregister === 'function') handle.unregister();
      }
      facetToken = null;
      window.facetAgent = undefined;
    },
  };
}
facetRegister();
`
}

// ---------------------------------------------------------------------------------------------
// Pieces

function screenUrl(base: string, screen: ManifestScreen, params: Record<string, string> = {}): string {
  let path = screen.path
  for (const p of screen.pathParams) path = path.replace(`{${p}}`, encodeURIComponent(params[p] ?? `{${p}}`))
  return `${base}${path === '/' ? '' : path}` || '/'
}

/** Every op with a screen, in manifest order, grouped by the resource it belongs to. */
function screens(manifest: Manifest): { group: string; ops: ManifestOp[] }[] {
  const groups = new Map<string, ManifestOp[]>()
  for (const op of manifest.ops) {
    if (!webOf(op)) continue
    const group = op.path.length > 1 ? op.path[0]! : ''
    groups.set(group, [...(groups.get(group) ?? []), op])
  }
  return [...groups].map(([group, ops]) => ({ group, ops }))
}

/**
 * Only a screen with no route params can be linked from the nav — the rest need an id first — and
 * an app may take one out of the nav without taking away its route (`hidden`).
 */
function navigable(op: ManifestOp): boolean {
  const screen = webOf(op)
  return screen !== null && screen.pathParams.length === 0 && !screen.hidden
}

/** `order` first, lowest to highest; everything without one keeps manifest order, after those. */
function inNavOrder(ops: ManifestOp[]): ManifestOp[] {
  return ops
    .map((op, i) => ({ op, i }))
    .sort((a, b) => {
      const ao = webOf(a.op)!.order
      const bo = webOf(b.op)!.order
      if (ao !== undefined && bo !== undefined) return ao - bo || a.i - b.i
      if (ao !== undefined) return -1
      if (bo !== undefined) return 1
      return a.i - b.i
    })
    .map((x) => x.op)
}

/** What a field is called on screen: the app's label if it wrote one, else the derived one. */
function labelOf(screen: ManifestScreen, field: FieldPresentation | undefined, name: string): string {
  return screen.labels?.[name] ?? field?.label ?? humanLabel(name)
}

/**
 * One value, by the rules in `presentation.ts`. A `sensitive` value ships masked with a reveal:
 * the viewer is already authorised for it — it is their own screen, answered by the same pipeline
 * as every other facet — so what the mask buys is that it is not on screen by accident, in a
 * screenshot or over a shoulder. Authorisation is the pipeline's job and stays there.
 */
function fieldValue(value: unknown, field: FieldPresentation | undefined): string {
  if (field?.display === 'datetime' && value) {
    return `<time datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>`
  }
  if (field?.sensitive) {
    const masked = presentValue(value, field)
    return (
      `<span class="mask" data-masked data-shown="false" data-mask="${escapeHtml(masked)}" data-value="${escapeHtml(presentValue(value))}">${escapeHtml(masked)}</span>` +
      `<button type="button" class="reveal">Reveal</button>`
    )
  }
  const text = presentValue(value, field)
  return text ? escapeHtml(text) : '<span class="empty">—</span>'
}

function control(field: FieldPresentation, schema: JSONSchema | undefined, value: unknown): string {
  const name = escapeHtml(field.name)
  const attrs = `id="f-${name}" name="${name}"${field.required ? ' required' : ''}`
  const current = value === undefined || value === null ? '' : String(value)
  if (field.enum) {
    const options = field.enum
      .map((o) => `<option value="${escapeHtml(o)}"${o === current ? ' selected' : ''}>${escapeHtml(o)}</option>`)
      .join('')
    return `<select ${attrs}>${field.required ? '' : '<option value=""></option>'}${options}</select>`
  }
  if (field.display === 'boolean') {
    return `<input ${attrs} type="checkbox" value="true"${current === 'true' ? ' checked' : ''}>`
  }
  if (field.display === 'json') {
    return `<textarea ${attrs} rows="4">${escapeHtml(current)}</textarea>`
  }
  const type = field.sensitive
    ? 'password'
    : field.display === 'number'
      ? 'number'
      : field.display === 'datetime'
        ? 'datetime-local'
        : schema?.format === 'email'
          ? 'email'
          : 'text'
  return `<input ${attrs} type="${type}" value="${escapeHtml(current)}">`
}

/**
 * The deprecated marker, on every screen kind rather than only on forms. A person reading a table
 * or a detail has the same right to know a field is on its way out as one filling in a form, and
 * the generated web case asserts the mark is there — so it has to be somewhere to assert about.
 */
function deprecatedMark(field: FieldPresentation | undefined): string {
  if (field?.deprecated === undefined) return ''
  return ` <span class="dep">deprecated${field.deprecated ? `: ${escapeHtml(field.deprecated)}` : ''}</span>`
}

function labelFor(field: FieldPresentation, error?: string): string {
  const deprecated = deprecatedMark(field)
  const hint = error
    ? `<span class="hint" style="color:var(--danger)">${escapeHtml(error)}</span>`
    : field.description
      ? `<span class="hint">${escapeHtml(field.description)}</span>`
      : ''
  return `${escapeHtml(field.label)}${field.required ? ' *' : ''}${deprecated}${hint ? `<br>${hint}` : ''}`
}

// ---------------------------------------------------------------------------------------------
// The three screen kinds

function renderTable(manifest: Manifest, op: ManifestOp, base: string, data: unknown): string {
  const row = (objectProperties(op.output)['items']?.items ?? {}) as JSONSchema
  const fields = new Map(presentFields(row, op.output).map((f) => [f.name, f]))
  const columns = tableColumns(row, op.output, webOf(op)!.fields)
  const page = (data ?? {}) as { items?: Record<string, unknown>[]; nextCursor?: string | null }
  const items = page.items ?? []
  if (!items.length) return `<p class="empty">Nothing here yet.</p>`
  const detail = manifest.ops.find(
    (o) => webOf(o)?.kind === 'detail' && o.path[0] === op.path[0] && webOf(o)!.pathParams.includes('id'),
  )
  const head = columns
    .map((c) => `<th scope="col" data-field="${escapeHtml(c)}">${escapeHtml(labelOf(webOf(op)!, fields.get(c), c))}${deprecatedMark(fields.get(c))}</th>`)
    .join('')
  const body = items
    .map((item) => {
      const cells = columns.map((c, i) => {
        const rendered = fieldValue(item[c], fields.get(c))
        const linked =
          i === 0 && detail && item['id'] !== undefined
            ? `<a href="${escapeHtml(screenUrl(base, webOf(detail)!, { id: String(item['id']) }))}">${rendered}</a>`
            : rendered
        return `<td data-field="${escapeHtml(c)}">${linked}</td>`
      })
      return `<tr>${cells.join('')}</tr>`
    })
    .join('')
  const more = page.nextCursor
    ? `<p><a href="${escapeHtml(screenUrl(base, webOf(op)!))}?cursor=${encodeURIComponent(page.nextCursor)}">Next page</a></p>`
    : ''
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`
}

function renderDetail(op: ManifestOp, data: unknown): string {
  const screen = webOf(op)!
  const known = new Map(presentFields(op.output).map((f) => [f.name, f]))
  const shown = screen.fields.filter((name) => known.has(name))
  const value = (data ?? {}) as Record<string, unknown>
  if (!shown.length) return `<p class="empty">This operation returns nothing to show.</p>`
  const rows = shown
    .map((name) => {
      const field = known.get(name)
      return (
        `<dt data-field="${escapeHtml(name)}">${escapeHtml(labelOf(screen, field, name))}${deprecatedMark(field)}</dt>` +
        `<dd data-field="${escapeHtml(name)}">${fieldValue(value[name], field)}</dd>`
      )
    })
    .join('')
  return `<dl>${rows}</dl>`
}

function renderForm(op: ManifestOp, base: string, ctx: ScreenContext): string {
  const screen = webOf(op)!
  const props = objectProperties(op.input)
  const known = new Map(presentFields(op.input).map((f) => [f.name, f]))
  const values = ctx.values ?? {}
  const controls = screen.fields
    .filter((name) => known.has(name) && !screen.pathParams.includes(name))
    .map((name) => {
      const field = { ...known.get(name)!, label: labelOf(screen, known.get(name), name) }
      return `<label for="f-${escapeHtml(name)}">${labelFor(field, ctx.error?.fields?.[name])}${control(field, props[name], values[name])}</label>`
    })
    .join('')
  const csrf = ctx.csrfToken ? `<input type="hidden" name="_csrf" value="${escapeHtml(ctx.csrfToken)}">` : ''
  const question = screen.confirmMessage ?? `${screen.title}? This cannot be undone.`
  const confirm = screen.confirm ? ` data-confirm="${escapeHtml(question)}"` : ''
  const warning = screen.confirm ? `<p class="hint">${escapeHtml(question)}</p>` : ''
  const submit = `<div><button type="submit"${screen.confirm ? ' class="danger"' : ''}>${escapeHtml(screen.title)}</button></div>`
  const body = controls || '<p class="hint">This operation takes no input.</p>'
  return `<form method="post" action="${escapeHtml(screenUrl(base, screen, ctx.params))}"${confirm}>${csrf}${body}${warning}${submit}</form>`
}

// ---------------------------------------------------------------------------------------------
// The page

function shell(
  manifest: Manifest,
  base: string,
  title: string,
  current: string | null,
  body: string,
  errorCode?: string,
): string {
  const tools = webTools(manifest)
  const registration = tools.length
    ? registrationScript(tools, `facet-web/${manifest.version}`, mintPath(manifest))
    : ''
  const nav = screens(manifest)
    .map(({ group, ops }) => {
      const links = inNavOrder(ops.filter(navigable))
        .map(
          (o) =>
            `<a href="${escapeHtml(screenUrl(base, webOf(o)!))}"${o.id === current ? ' aria-current="page"' : ''}>${escapeHtml(webOf(o)!.title)}</a>`,
        )
        .join('')
      return links ? `${group ? `<h2>${escapeHtml(humanLabel(group))}</h2>` : ''}${links}` : ''
    })
    .join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(manifest.name)}</title>
${errorCode ? `<meta name="facet-error" content="${escapeHtml(errorCode)}">` : ''}
<style>${STYLES}</style>
</head>
<body>
<header><h1><a href="${escapeHtml(base || '/')}">${escapeHtml(manifest.name)}</a></h1><span>v${escapeHtml(manifest.version)}</span></header>
<main>
<nav aria-label="Screens">${nav}</nav>
<section>${body}</section>
<footer>Every screen here is a declared operation. Generated by facet.</footer>
</main>
<script>${SCRIPT}${registration}</script>
</body>
</html>`
}

function errorBlock(error: ScreenContext['error']): string {
  if (!error) return ''
  return `<div class="err"><strong>${escapeHtml(error.title)}</strong>${error.detail ? `<p>${escapeHtml(error.detail)}</p>` : ''}</div>`
}

/** The resource's other screens, as links — a table's "New task", a detail's "Edit" and "Delete". */
function relatedActions(manifest: Manifest, op: ManifestOp, base: string, params: Record<string, string>): string {
  const chosen = webOf(op)!.actions
  const candidates = chosen
    ? chosen.map((id) => manifest.ops.find((o) => o.id === id)).filter((o): o is ManifestOp => Boolean(o && webOf(o)))
    : manifest.ops.filter((o) => o.id !== op.id && webOf(o) && o.path[0] === op.path[0])
  const links = candidates
    .filter((o) => webOf(o)!.pathParams.every((p) => p in params))
    .map(
      (o) =>
        `<a href="${escapeHtml(screenUrl(base, webOf(o)!, params))}"${webOf(o)!.confirm ? ' class="danger"' : ''}>${escapeHtml(webOf(o)!.title)}</a>`,
    )
  return links.length ? `<div class="actions">${links.join('')}</div>` : ''
}

/**
 * One screen, as a complete HTML document. `opId` has to name an op the manifest projects onto the
 * web facet: there is no way to render anything else, which is the point (docs/BACKLOG.md, E12,
 * "Where this stops").
 */
export function renderScreen(manifest: Manifest, opId: string, ctx: ScreenContext = {}): string {
  const op = manifest.ops.find((o) => o.id === opId)
  const screen = op && webOf(op)
  if (!op || !screen) {
    throw new Error(`facet web: "${opId}" has no screen. Declare the op, or write your own app against the SDK.`)
  }
  const base = ctx.basePath ?? webSettings(manifest)?.path ?? ''
  const params = ctx.params ?? {}
  const body =
    screen.kind === 'table'
      ? renderTable(manifest, op, base, ctx.data)
      : screen.kind === 'detail'
        ? renderDetail(op, ctx.data)
        : renderForm(op, base, ctx)
  const heading = `<h2 class="screen">${escapeHtml(screen.title)}</h2><p class="desc">${escapeHtml(op.description ?? op.id)}</p>`
  return shell(
    manifest,
    base,
    screen.title,
    op.id,
    heading + errorBlock(ctx.error) + relatedActions(manifest, op, base, params) + body,
    ctx.error?.code,
  )
}

/** The front page: every screen reachable without an id, and nothing invented to fill it out. */
export function renderIndex(manifest: Manifest, ctx: ScreenContext = {}): string {
  const base = ctx.basePath ?? webSettings(manifest)?.path ?? ''
  const entries = screens(manifest)
    .flatMap(({ ops }) => inNavOrder(ops.filter(navigable)))
    .map(
      (o) =>
        `<dt><a href="${escapeHtml(screenUrl(base, webOf(o)!))}">${escapeHtml(webOf(o)!.title)}</a></dt><dd>${escapeHtml(o.description ?? o.id)}</dd>`,
    )
    .join('')
  const body = entries ? `<dl>${entries}</dl>` : `<p class="empty">No screens without an id.</p>`
  const heading = `<h2 class="screen">${escapeHtml(manifest.name)}</h2><p class="desc">${escapeHtml(manifest.description ?? 'Every declared operation, as a screen.')}</p>`
  return shell(manifest, base, manifest.name, null, heading + body)
}
