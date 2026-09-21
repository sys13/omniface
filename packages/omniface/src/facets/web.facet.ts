import type { WebConfig } from '../app.ts'
import { agentMayCall, MINT_OP } from '../agent.ts'
import { defineFacet, registerFacet, projectionOf, settingsOf, type FacetChange } from '../facet.ts'
import { objectProperties } from '../jsonschema.ts'
import type { Manifest, ManifestOp } from '../manifest.ts'
import { conventionalScreen, pathParamsOf, type ScreenKind } from '../naming.ts'
import { createWebApp } from './web-server.ts'

/**
 * The web facet's view of one op: the screen it becomes. Derived from what the op already
 * declares — `readonly` and `paginated` pick the kind, `destructive` asks before it runs, the
 * schemas name the fields — so the renderer reads this and invents nothing of its own.
 */
export type ManifestScreen = {
  kind: ScreenKind
  /** Route under the web facet's mount path, with `{param}` placeholders. */
  path: string
  pathParams: string[]
  title: string
  /** Ask before running. `destructive` by default; an app may add or remove the question. */
  confirm: boolean
  /** The question, when the app wrote one. */
  confirmMessage?: string
  /**
   * The fields the screen shows, in schema order: a table's columns and a detail's rows come from
   * the output, a form's controls from the input minus whatever the route already carries.
   * `internal` fields are absent because the manifest's schemas are already public ones.
   */
  fields: string[]
  /** Labels the app chose, by field name. Anything absent is derived from the field name. */
  labels?: Record<string, string>
  /** Op ids offered as actions on this screen, in order. Absent means the derived list. */
  actions?: string[]
  /** Op id to land on after a successful write, or `back`. */
  then?: string
  /** Nav position. Lower first; unset sorts last. */
  order?: number
  /** Reachable by URL, absent from the nav. */
  hidden?: boolean
  /**
   * Offered to the agent in the visitor's browser. The page registers exactly these, and the
   * pipeline refuses a `webmcp` call to anything else — one declaration, both readers.
   */
  agent: boolean
}

export type WebSettings = { path: string; agent: boolean; agentCredential: 'attenuated' | 'session' }

export const webOf = (op: ManifestOp): ManifestScreen | null => projectionOf<ManifestScreen>(op, 'web')
export const webSettings = (manifest: Manifest): WebSettings | null => settingsOf<WebSettings>(manifest, 'web')

export const webFacet = defineFacet<WebConfig, ManifestScreen, WebSettings>({
  name: 'web',
  order: 4,
  // Opt-in, unlike the four MVP facets: a screen is something a person lands on, and that should
  // be a decision rather than a default.
  defaultOn: false,
  normalize: (value) => (value === undefined || value === false ? null : value === true ? {} : (value as WebConfig)),

  references(config) {
    const out = [{ where: 'web.ops', ids: Object.keys(config.ops ?? {}) }]
    const agent = config.agent
    if (agent && agent !== true) out.push({ where: 'web.agent.ops', ids: Object.keys(agent.ops ?? {}) })
    // A screen may name other ops — as actions, or as where a write lands. Those are op ids too,
    // and a typo in one is the same drift as a typo in an override key.
    for (const [id, override] of Object.entries(config.ops ?? {})) {
      if (!override) continue
      out.push({ where: `web.ops["${id}"].actions`, ids: override.actions ?? [] })
      if (override.then && override.then !== 'back') out.push({ where: `web.ops["${id}"].then`, ids: [override.then] })
    }
    return out
  },

  check(config, ops) {
    const agent = config.agent
    // Asking for an attenuated credential without the plugin that mints one would silently fall
    // back to the ambient session — the exact thing the setting exists to avoid.
    if (agent && agent !== true && agent.credential === 'attenuated' && !ops.has(MINT_OP)) {
      throw new Error(
        `facet: facets.web.agent.credential 'attenuated' needs the agentTokens() plugin, which contributes "${MINT_OP}"`,
      )
    }
  },

  project({ op, input, output, row }, config) {
    const override = config.ops?.[op.id]
    if (override === false) return null
    const conv = conventionalScreen(op.path, op.op.traits, Object.keys(objectProperties(input)), Boolean(row))
    const path = override?.path ?? conv.path
    const pathParams = override?.path ? pathParamsOf(path) : conv.pathParams
    const derived =
      conv.screen === 'form'
        ? Object.keys(objectProperties(input)).filter((f) => !pathParams.includes(f))
        : Object.keys(objectProperties(conv.screen === 'table' ? (row ?? output) : output, output))
    return {
      kind: conv.screen,
      path,
      pathParams,
      title: override?.title ?? conv.title,
      confirm: override?.confirm !== undefined ? Boolean(override.confirm) : conv.confirm,
      ...(typeof override?.confirm === 'string' ? { confirmMessage: override.confirm } : {}),
      fields: override?.fields ?? derived,
      ...(override?.labels ? { labels: override.labels } : {}),
      ...(override?.actions ? { actions: override.actions } : {}),
      ...(override?.then ? { then: override.then } : {}),
      ...(override?.order !== undefined ? { order: override.order } : {}),
      ...(override?.hidden ? { hidden: true } : {}),
      agent: agentMayCall(config, op.id, op.op.traits),
    }
  },

  settings(app, config): WebSettings {
    return {
      path: config.path ?? '/app',
      agent: Boolean(config.agent),
      // Attenuated whenever the app can attenuate: the weaker credential is the default, and
      // leaning on the session is the thing you have to ask for.
      agentCredential:
        (typeof config.agent === 'object' ? config.agent.credential : undefined) ??
        (app.ops.has(MINT_OP) ? 'attenuated' : 'session'),
    }
  },

  // The screen asks before it runs when the op is destructive, the same way the CLI prompts.
  observes: { traits: ['destructive'] },

  diff(before, after, { op }): FacetChange[] {
    const changes: FacetChange[] = []
    if (before.path !== after.path) {
      changes.push({
        level: 'breaking',
        rule: 'web-route-changed',
        message: `${op}: screen ${after.path} — was ${before.path}.`,
        detail: 'The old URL 404s. A bookmark, a link in an email, a browser agent holding the route all land on nothing.',
      })
    }
    if (before.kind !== after.kind) {
      changes.push({
        level: 'breaking',
        rule: 'web-screen-kind-changed',
        message: `${op}: screen kind ${before.kind} → ${after.kind}.`,
        detail: 'A table that became a form is a different page. The trait behind it (`readonly`, `paginated`) changed too.',
      })
    }
    if (!before.confirm && after.confirm) {
      changes.push({
        level: 'breaking',
        rule: 'web-confirm-added',
        message: `${op}: the screen now asks before it runs.`,
        detail: 'Same reason the CLI starts prompting: the op became `destructive`, and an unattended caller now stops.',
      })
    } else if (before.confirm && !after.confirm) {
      changes.push({ level: 'additive', rule: 'web-confirm-removed', message: `${op}: the screen no longer asks before it runs.` })
    }
    if (before.fields.join(',') !== after.fields.join(',')) {
      changes.push({
        level: 'neutral',
        rule: 'web-fields-changed',
        message: `${op}: fields on screen [${before.fields.join(' ')}] → [${after.fields.join(' ')}].`,
        detail: 'Presentation only — the schema change behind it, if there was one, is reported on its own.',
      })
    }
    if (before.title !== after.title) {
      changes.push({ level: 'neutral', rule: 'web-title-changed', message: `${op}: screen title "${before.title}" → "${after.title}".` })
    }
    return changes
  },

  diffSettings(before, after): FacetChange[] {
    if (before.path === after.path) return []
    return [
      {
        level: 'breaking',
        rule: 'web-mount-moved',
        message: `The web facet moved ${before.path} → ${after.path}.`,
        detail: 'Every screen URL changes at once: bookmarks, links and any WebMCP registration tied to the page.',
      },
    ]
  },

  present({ manifest, op, example }, screen) {
    let path = screen.path
    for (const p of screen.pathParams) path = path.replace(`{${p}}`, encodeURIComponent(String(example[p] ?? p)))
    const mount = webSettings(manifest)?.path ?? ''
    const url = `http://localhost:3000${`${mount}${path === '/' ? '' : path}` || '/'}`
    return {
      label: 'Web',
      short: `${screen.kind} ${mount}${screen.path}`,
      snippet: `${screen.kind} · ${url}${screen.confirm ? ' · confirms' : ''}\n${screen.fields.join(', ') || '(no fields)'}`,
      line: `- Web: ${screen.kind} at \`${mount}${screen.path}\``,
      detail: { screen, url },
    }
  },

  summary: (settings) => `a web console (${settings.path})`,

  contract({ app, op }, screen) {
    const problems: string[] = []
    const config = app.facets['web'] as WebConfig | null
    if (!screen) {
      if (config?.ops?.[op.id] !== false) problems.push('no web screen')
      return problems
    }
    const props = Object.keys(objectProperties(op.input))
    for (const p of screen.pathParams) if (!props.includes(p)) problems.push(`web route param "${p}" is not an input field`)
    // A screen may only show fields the op declares. The projection derives them, so this can only
    // fail on an override — which is exactly the drift a typo in a column list causes elsewhere.
    const items = objectProperties(op.output)['items']
    const row = items?.items ?? items
    const source =
      screen.kind === 'form'
        ? objectProperties(op.input)
        : screen.kind === 'table' && row
          ? objectProperties(row, op.output)
          : objectProperties(op.output)
    if (Object.keys(source).length) {
      for (const f of screen.fields) {
        if (!(f in source)) problems.push(`web field "${f}" is not ${screen.kind === 'form' ? 'an input' : 'an output'} field`)
      }
    }
    for (const f of Object.keys(screen.labels ?? {})) {
      if (!screen.fields.includes(f)) problems.push(`web label "${f}" names a field the screen does not show`)
    }
    return problems
  },

  serve: {
    // Before REST: a screen route and a REST route can be the same route, and the screen wins.
    // Its own CSP is set per response, inside the web app.
    order: 1,
    create: (app, manifest) => createWebApp(app, manifest),
  },
})

// Registered here rather than in a list elsewhere: a facet module that is imported is a facet the
// app has. It also keeps the import cycle with this facet's server module harmless.
registerFacet(webFacet)
