import {
  buildManifest,
  facetModules,
  restOf,
  webOf,
  webSettings,
  exampleValue,
  objectProperties,
  requiredProperties,
  validate,
  type App,
  type Manifest,
  type ManifestOp,
} from 'omniface'
import { hasScope } from 'omniface/plugins'
import { BASE_URL, CHANNELS, createHarness, outcomesAgree, type Channel, type Harness, type Outcome } from './harness.ts'
import { screenProblems } from './screen.ts'

/**
 * Generated conformance: the cases nobody should have to write by hand.
 *
 * Principle 7 — "tiny input, large output, and every output is proven by generated conformance
 * tests". The definition already says what each op is (traits, schema, declared errors), so the
 * suite is derived from it: add an op to the app and its cases appear, on every facet it is
 * projected to, with no test edited.
 *
 * What is *not* generated is anything needing app knowledge: a valid input for a write, or the
 * data a read expects to find. Supply those per op with `ops[id].input` / `ops[id].setup`.
 */

export const CHECKS = [
  'contract',
  'invalid_input',
  'anonymous',
  'forbidden',
  'not_found',
  'idempotent',
  'agree',
  'agent',
  'csrf',
  'presentation',
  'discovery',
] as const
export type Check = (typeof CHECKS)[number]

export type OpConformanceOptions = {
  /** `true` skips the op entirely; a list skips those checks. */
  skip?: boolean | Check[]
  /** A valid input for this op. Enables the `agree` case, and replaces the synthesized sample. */
  input?: Record<string, unknown>
  /** An id that does not exist, for the `not_found` case. Defaults to a sentinel. */
  missingId?: string
  /** Seed state before each case for this op. Runs against a fresh app. */
  setup?: (harness: Harness) => void | Promise<void>
}

export type ConformanceOptions = {
  /** A fresh app per case, so one case's writes can never change another's. */
  app: () => App
  /** A credential holding every scope the app declares. */
  apiKey: string
  /** A credential holding only these scopes. Enables the `forbidden` cases. */
  unprivileged?: { apiKey: string; scopes: string[] }
  ops?: Record<string, OpConformanceOptions>
}

export type CaseResult = {
  /** Empty means the facets agreed. Each entry is one human-readable disagreement. */
  problems: string[]
  outcomes?: Partial<Record<Channel, Outcome>>
}

export type ConformanceCase = {
  /** `tasks.create · unauthenticated` — use it as the test name. */
  name: string
  op: string
  check: Check
  /** The facets this case exercises. Empty for `contract`, which reads the manifest only. */
  channels: Channel[]
  run: () => Promise<CaseResult>
}

// ---------------------------------------------------------------------------------------------
// Deriving inputs from the definition

const MISSING_ID = 'facet_conformance_missing_id'

/** The smallest input the schema accepts: an example for each required property, nothing else. */
function sampleInput(op: ManifestOp): Record<string, unknown> {
  const props = objectProperties(op.input)
  const out: Record<string, unknown> = {}
  for (const key of requiredProperties(op.input)) {
    const schema = props[key]
    if (schema) out[key] = exampleValue(schema, op.input)
  }
  return out
}

function isIdLike(key: string, schema: { type?: string; 'x-omniface-scalar'?: string } | undefined): boolean {
  if (schema?.['x-omniface-scalar'] === 'id') return true
  return schema?.type === 'string' && (key === 'id' || key.endsWith('Id'))
}

/** Which required properties are ids, so `not_found` can point them at nothing. */
function idProperties(op: ManifestOp): string[] {
  const props = objectProperties(op.input)
  return requiredProperties(op.input).filter((key) => isIdLike(key, props[key]))
}

/** Does this input actually satisfy the op's schema? If not, the author has to supply one. */
async function inputIsValid(app: App, id: string, input: Record<string, unknown>): Promise<boolean> {
  const registered = app.ops.get(id)
  if (!registered) return false
  return (await validate(registered.op.input, input)).ok
}

// ---------------------------------------------------------------------------------------------
// The contract check: what each facet advertises, without calling anything

/**
 * The contract check: what each facet advertises about an op, without calling anything.
 *
 * Nothing here knows the facets. Each facet module answers for its own projection — is the op
 * missing from it, do the bindings name fields the op actually has, does a name collide — so a
 * facet added as a module is checked by the generated suite the moment it is registered, which is
 * the whole point of the contract.
 */
function contractProblems(app: App, manifest: Manifest, op: ManifestOp): string[] {
  const problems: string[] = []
  const others = manifest.ops.filter((o) => o.id !== op.id)
  for (const module of facetModules()) {
    if (!(module.name in op.facets)) continue
    problems.push(...(module.contract?.({ app, manifest, op, others }, op.facets[module.name]) ?? []))
  }
  // Internal fields are stripped from what runs; they must not leak into what is advertised
  // either. True of every facet, so it is asked once rather than per facet.
  if (JSON.stringify([op.input, op.output]).includes('"x-omniface-internal":true')) {
    problems.push('an internal field is advertised in a schema')
  }
  return problems
}

// ---------------------------------------------------------------------------------------------
// Case generation

function expectCode(outcomes: Record<Channel, Outcome>, code: string): string[] {
  const problems = outcomesAgree(outcomes, { compareValues: false })
  for (const [channel, outcome] of Object.entries(outcomes)) {
    if (outcome.ok) problems.push(`${channel}: succeeded, expected ${code}`)
    else if (outcome.code !== code) problems.push(`${channel}: ${outcome.code}, expected ${code}`)
  }
  return problems
}

/**
 * Every generated case for an app, ready to hand to any test runner:
 *
 * ```ts
 * for (const c of conformanceCases({ app: createTasksApp, apiKey: KEY })) {
 *   it(c.name, async () => expect((await c.run()).problems).toEqual([]))
 * }
 * ```
 */
export function conformanceCases(options: ConformanceOptions): ConformanceCase[] {
  const template = options.app()
  const manifest = buildManifest(template)
  const cases: ConformanceCase[] = []

  for (const op of manifest.ops) {
    const perOp = options.ops?.[op.id] ?? {}
    if (perOp.skip === true) continue
    const skipped = new Set(Array.isArray(perOp.skip) ? perOp.skip : [])

    const traits = op.traits
    const required = requiredProperties(op.input)
    const sample = perOp.input ?? sampleInput(op)

    /** A fresh app, seeded, for one case. */
    const fresh = async (): Promise<Harness> => {
      const harness = createHarness(options.app(), { apiKey: options.apiKey })
      await perOp.setup?.(harness)
      return harness
    }

    const add = (
      check: Check,
      channels: Channel[],
      run: (harness: Harness) => Promise<CaseResult>,
    ) => {
      if (skipped.has(check) || (check !== 'contract' && channels.length === 0)) return
      cases.push({
        name: `${op.id} · ${check}`,
        op: op.id,
        check,
        channels,
        // One case that cannot even be driven is a finding, not a crashed suite: the rest still run.
        run: async () => {
          try {
            return await run(await fresh())
          } catch (err) {
            return { problems: [`could not run: ${err instanceof Error ? err.message : String(err)}`] }
          }
        },
      })
    }

    const channels = CHANNELS.filter((c) => op.facets[c] != null)

    add('contract', [], async () => ({ problems: contractProblems(template, manifest, op) }))

    // Missing required input is invalid on every facet, whatever the app does. A field bound to a
    // REST path param is the exception: over HTTP there is no request that omits it, so the check
    // drops those fields, and the op entirely when they are all it requires.
    const omittable = required.filter((key) => !restOf(op)?.pathParams.includes(key))
    if (required.length && omittable.length) {
      const input = Object.fromEntries(Object.entries(sample).filter(([key]) => !omittable.includes(key)))
      add('invalid_input', channels, async (h) => {
        const outcomes = await h.callAll(op.id, input, { apiKey: options.apiKey }, channels)
        return { problems: expectCode(outcomes, 'invalid_input'), outcomes }
      })
    }

    // What an anonymous caller gets, on every facet at once. Only the two traits that actually
    // decide it are used, so an app with no auth plugin is not accused of anything: an op that
    // declares a scope is closed (Gate 1 guarantees a plugin enforces it), and one marked public
    // is open. Anything else is the app's business.
    const anonymousDenied = typeof traits.scope === 'string'
    const safeToCallAnonymously = traits.public && (traits.readonly === true || perOp.input !== undefined)
    if (anonymousDenied || safeToCallAnonymously) {
      add('anonymous', channels, async (h) => {
        if (!(await inputIsValid(template, op.id, sample))) {
          return { problems: [`no valid input could be synthesized; set ops['${op.id}'].input`] }
        }
        const outcomes = await h.callAll(op.id, sample, { apiKey: undefined }, channels)
        const problems = outcomesAgree(outcomes, { compareValues: false })
        for (const [channel, outcome] of Object.entries(outcomes)) {
          if (anonymousDenied && outcome.ok) problems.push(`${channel}: succeeded, expected a scoped op to refuse an anonymous caller`)
          if (!anonymousDenied && !outcome.ok) problems.push(`${channel}: ${outcome.code}, expected a public op to answer anonymously`)
        }
        return { problems, outcomes }
      })
    }

    // A scope the caller does not hold is forbidden everywhere.
    const unprivileged = options.unprivileged
    if (unprivileged && typeof traits.scope === 'string' && !hasScope(unprivileged.scopes, traits.scope)) {
      add('forbidden', channels, async (h) => {
        if (!(await inputIsValid(template, op.id, sample))) {
          return { problems: [`no valid input could be synthesized; set ops['${op.id}'].input`] }
        }
        const outcomes = await h.callAll(op.id, sample, { apiKey: unprivileged.apiKey }, channels)
        if (Object.values(outcomes).every((o) => !o.ok && o.code === 'unauthenticated')) {
          return { problems: ['the unprivileged credential does not authenticate; check `unprivileged.apiKey`'], outcomes }
        }
        return { problems: expectCode(outcomes, 'forbidden'), outcomes }
      })
    }

    // An op that declares not_found and takes an id must render it the same way everywhere.
    const ids = idProperties(op)
    if (op.errors.includes('not_found') && ids.length) {
      const missing = Object.fromEntries(ids.map((key) => [key, perOp.missingId ?? MISSING_ID]))
      add('not_found', channels, async (h) => {
        const input = { ...sample, ...missing }
        if (!(await inputIsValid(template, op.id, input))) {
          return { problems: [`no valid input could be synthesized; set ops['${op.id}'].input`] }
        }
        const outcomes = await h.callAll(op.id, input, { apiKey: options.apiKey }, channels)
        return { problems: expectCode(outcomes, 'not_found'), outcomes }
      })
    }

    // A key replays rather than repeats — on every facet that can carry one, which since the MCP
    // facet reads it from tool-call _meta is all four. Only runs where a valid write input exists,
    // because the whole point is that the second call must not do the work twice.
    if (traits.idempotent && !traits.readonly && perOp.input !== undefined) {
      add('idempotent', channels, async (h) => {
        const problems: string[] = []
        const outcomes = {} as Record<Channel, Outcome>
        for (const channel of channels) {
          const key = `conformance_${op.id}_${channel}`
          const first = await h.call(channel, op.id, sample, { apiKey: options.apiKey, idempotencyKey: key })
          const second = await h.call(channel, op.id, sample, { apiKey: options.apiKey, idempotencyKey: key })
          outcomes[channel] = second
          if (!first.ok) problems.push(`${channel}: first call failed with ${first.code} (${first.message})`)
          else if (!second.ok) problems.push(`${channel}: replay failed with ${second.code} (${second.message})`)
          else if (JSON.stringify(first.value) !== JSON.stringify(second.value)) {
            problems.push(`${channel}: the same key ran the op again instead of replaying the first result`)
          }
        }
        return { problems, outcomes }
      })
    }

    // The browser agent, both halves (docs/BACKLOG.md 12.10). The page's tool list is not the
    // enforcement, so the case that matters is the call the page never advertised: it arrives with
    // the same claim a real tool makes, and it has to be refused anyway.
    if (webSettings(manifest)?.agent && restOf(op)) {
      add('agent', ['rest'], async (h) => {
        if (!(await inputIsValid(template, op.id, sample))) {
          return { problems: [`no valid input could be synthesized; set ops['${op.id}'].input`] }
        }
        const outcome = await h.callAsAgent(op.id, sample, { apiKey: options.apiKey })
        const advertised = webOf(op)?.agent === true
        const problems: string[] = []
        if (!advertised && outcome.ok) problems.push('an op the page does not advertise answered a browser-agent call')
        if (!advertised && !outcome.ok && outcome.code !== 'forbidden') {
          problems.push(`browser-agent call refused with ${outcome.code}, expected forbidden`)
        }
        if (advertised && !outcome.ok && outcome.code === 'forbidden') {
          problems.push('an advertised op refused the browser agent it was advertised to')
        }
        return { problems, outcomes: { rest: outcome } as Record<Channel, Outcome> }
      })
    }

    // A write on a screen carries a CSRF token, because a console is the one facet with ambient
    // authority. A form that arrives without one is a form from somewhere else.
    if (webOf(op)?.kind === 'form') {
      add('csrf', ['web'], async (h) => {
        const outcome = await h.postWithoutToken(op.id, sample, { apiKey: options.apiKey })
        const problems: string[] = []
        if (outcome.ok) problems.push('a write with no CSRF token was accepted')
        else if (outcome.code !== 'forbidden') problems.push(`a write with no CSRF token failed with ${outcome.code}, expected forbidden`)
        return { problems, outcomes: { web: outcome } as Record<Channel, Outcome> }
      })
    }

    // The happy path, when it can run without app knowledge: an author-supplied input, or a read
    // that needs none. Reads must agree on the value; writes create their own row per facet.
    //
    // An op that destroys something and is not idempotent is the exception: four facets calling it
    // against one app means the first consumes the thing and the other three answer not_found, so
    // they would be compared on a state only the first one ever saw. Those get a fresh app each,
    // which is the same isolation every case already has, one level further down.
    const perFacetState = traits.destructive === true && !traits.idempotent
    const canRunHappyPath = perOp.input !== undefined || (traits.readonly === true && required.length === 0)
    if (canRunHappyPath) {
      add('agree', channels, async (h) => {
        const outcomes = perFacetState
          ? ((Object.fromEntries(
              await Promise.all(channels.map(async (c) => [c, await (await fresh()).call(c, op.id, sample, { apiKey: options.apiKey })] as const)),
            ) as Record<Channel, Outcome>))
          : await h.callAll(op.id, sample, { apiKey: options.apiKey }, channels)
        const problems = outcomesAgree(outcomes, { compareValues: traits.readonly === true })
        for (const [channel, outcome] of Object.entries(outcomes)) {
          if (!outcome.ok) problems.push(`${channel}: ${outcome.code} (${outcome.message})`)
        }
        return { problems, outcomes }
      })
    }

    // Where a caller with no credential goes to get one. An app that declares an authorization
    // server is making a promise to a stranger — that being refused tells them where to go — and a
    // promise nothing checks is the kind this repo has been bitten by. Only ops that actually
    // refuse an anonymous caller are asked; a public op has nothing to point at.
    if (manifest.oauth && restOf(op) && typeof traits.scope === 'string') {
      add('discovery', ['rest'], async (h) => {
        const problems: string[] = []
        // The same request the `anonymous` check makes, minus the credential: a refusal for the
        // wrong reason (an empty body is `invalid_input`, not `unauthenticated`) would prove
        // nothing about where to get a credential.
        let path = restOf(op)!.path
        const rest = { ...sample }
        for (const p of restOf(op)!.pathParams) {
          path = path.replace(`{${p}}`, encodeURIComponent(String(rest[p] ?? MISSING_ID)))
          delete rest[p]
        }
        const url = new URL(BASE_URL + path)
        const init: RequestInit = { method: restOf(op)!.method }
        if (restOf(op)!.method === 'GET' || restOf(op)!.method === 'DELETE') {
          for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
        } else {
          init.body = JSON.stringify(rest)
          init.headers = { 'content-type': 'application/json' }
        }
        const refused = await h.fetch(url, init)
        if (refused.status !== 401) {
          problems.push(`a scoped op answered an anonymous caller with ${refused.status}, expected 401`)
          return { problems }
        }
        const header = refused.headers.get('www-authenticate')
        if (!header) {
          problems.push('refused an anonymous caller without saying where to get a credential')
          return { problems }
        }
        const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1]
        if (!metadataUrl) {
          problems.push(`WWW-Authenticate names no resource metadata: ${header}`)
          return { problems }
        }
        const doc = await h.fetch(new URL(metadataUrl))
        if (!doc.ok) {
          problems.push(`the metadata the refusal points at answered ${doc.status}`)
          return { problems }
        }
        const body = (await doc.json()) as { authorization_servers?: unknown; scopes_supported?: unknown; resource?: unknown }
        if (!body.resource) problems.push('the metadata names no resource')
        if (!Array.isArray(body.authorization_servers) || !body.authorization_servers.length) {
          problems.push('the metadata names no authorization server, so a caller still cannot get a credential')
        }
        // The scopes are the ops' own. A document that omits the scope this op enforces would send
        // a caller to ask for a token that cannot open the door it was refused at.
        if (!Array.isArray(body.scopes_supported) || !body.scopes_supported.includes(traits.scope)) {
          problems.push(`the metadata does not advertise "${traits.scope}", the scope this op enforces`)
        }
        return { problems }
      })
    }

    // What reached the page. `outcomesAgree` skips a screen's value on purpose — a rendering is not
    // a record — so without this the web facet's only generated assertion is that the screen was
    // not a 500, and a console that renders nothing at all passes. This reads the HTML and asks
    // `presentation.ts`, the table the renderer itself renders from, what should be on it.
    const screen = webOf(op)
    if (screen && (screen.kind === 'table' || screen.kind === 'detail') && restOf(op) && canRunHappyPath) {
      add('presentation', ['rest', 'web'], async (h) => {
        if (!(await inputIsValid(template, op.id, sample))) {
          return { problems: [`no valid input could be synthesized; set ops['${op.id}'].input`] }
        }
        const outcomes = await h.callAll(op.id, sample, { apiKey: options.apiKey }, ['rest', 'web'])
        const problems = outcomesAgree(outcomes, { compareValues: false })
        for (const [channel, outcome] of Object.entries(outcomes)) {
          if (!outcome.ok) problems.push(`${channel}: ${outcome.code} (${outcome.message})`)
        }
        if (problems.length) return { problems, outcomes }
        const { html } = (outcomes.web as { ok: true; value: { html: string } }).value
        return { problems: screenProblems(op, html, (outcomes.rest as { ok: true; value: unknown }).value), outcomes }
      })
    }
  }

  return cases
}

/** Run every case and return only the failures. For a one-shot check outside a test runner. */
export async function runConformance(options: ConformanceOptions): Promise<{ name: string; problems: string[] }[]> {
  const failures: { name: string; problems: string[] }[] = []
  for (const c of conformanceCases(options)) {
    const { problems } = await c.run()
    if (problems.length) failures.push({ name: c.name, problems })
  }
  return failures
}
