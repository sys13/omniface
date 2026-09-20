import { toFacetError } from '../errors.ts'
import { definePlugin, type Invocation } from '../plugin.ts'

/**
 * OpenTelemetry: one span per invocation, plus RED metrics (rate, errors, duration) tagged by
 * facet — so "the MCP facet is slow" or "the CLI is the one getting rate limited" is a query
 * rather than a hunch.
 *
 * It sits in `wrap`, around the whole pipeline, which is why one plugin covers every facet: REST,
 * SDK, CLI and MCP all reach a handler through `app.invoke` and nothing else does.
 *
 * **On the dependency.** `@opentelemetry/api` is the standard, tiny, provider-agnostic surface, so
 * this plugin uses it rather than vendoring a tracer — but as an *optional* peer dependency. An app
 * that has not installed it gets a plugin that does nothing; an app that has gets real spans and
 * real instruments through whatever SDK it configured. The types below are structural for the same
 * reason: facet compiles and ships without the package present. Pass the module yourself
 * (`otel({ api })`) and nothing is imported dynamically at all.
 */

export type OtelAttributes = Record<string, string | number | boolean | undefined>

export type OtelSpan = {
  setAttribute(key: string, value: string | number | boolean): unknown
  setStatus(status: { code: number; message?: string }): unknown
  recordException(exception: never): unknown
  end(): unknown
}

export type OtelTracer = {
  startSpan(name: string, options?: { kind?: number; attributes?: OtelAttributes }): OtelSpan
}

export type OtelCounter = { add(value: number, attributes?: OtelAttributes): void }
export type OtelHistogram = { record(value: number, attributes?: OtelAttributes): void }

export type OtelMeter = {
  createCounter(name: string, options?: { description?: string; unit?: string }): OtelCounter
  createHistogram(name: string, options?: { description?: string; unit?: string }): OtelHistogram
}

/** The shape of `@opentelemetry/api` that this plugin uses. The real module satisfies it. */
export type OtelApi = {
  trace: {
    getTracer(name: string, version?: string): OtelTracer
    setSpan(context: never, span: never): unknown
  }
  metrics: { getMeter(name: string, version?: string): OtelMeter }
  context: { active(): unknown; with<T>(context: never, fn: () => T): T }
}

export type OtelOptions = {
  /** The `@opentelemetry/api` module. Omitted, it is imported if installed, else nothing runs. */
  api?: OtelApi
  /** Use these instead of asking the API for them. */
  tracer?: OtelTracer
  meter?: OtelMeter
  /** Instrumentation scope name and version. Default `facet` and the app's version at first call. */
  scope?: { name?: string; version?: string }
  /** Span name for an invocation. Default: the op id. */
  spanName?: (inv: Invocation) => string
  /** Extra attributes, on the span and on every metric this plugin records. */
  attributes?: (inv: Invocation) => OtelAttributes
  /** Record `facet.actor.id`. Off by default: an actor id is often a person. */
  actorId?: boolean
  /** Metric name prefix. Default `omniface`. */
  prefix?: string
}

// The two status codes this plugin uses, spelled out so the enum need not be imported.
const STATUS_ERROR = 2
const SPAN_KIND_SERVER = 1

type Instruments = {
  tracer?: OtelTracer
  api?: OtelApi
  calls?: OtelCounter
  errors?: OtelCounter
  duration?: OtelHistogram
}

async function loadApi(): Promise<OtelApi | undefined> {
  try {
    // A bare specifier, resolved at runtime: absent from the dependency graph when not installed.
    return (await import('@opentelemetry/api')) as unknown as OtelApi
  } catch {
    return undefined
  }
}

async function resolve(options: OtelOptions): Promise<Instruments> {
  const api = options.api ?? (options.tracer && options.meter ? undefined : await loadApi())
  const name = options.scope?.name ?? 'omniface'
  const version = options.scope?.version
  const tracer = options.tracer ?? api?.trace.getTracer(name, version)
  const meter = options.meter ?? api?.metrics.getMeter(name, version)
  const prefix = options.prefix ?? 'omniface'
  return {
    ...(tracer ? { tracer } : {}),
    ...(api ? { api } : {}),
    ...(meter
      ? {
          calls: meter.createCounter(`${prefix}.op.calls`, { description: 'Operations invoked, by facet and outcome' }),
          errors: meter.createCounter(`${prefix}.op.errors`, { description: 'Operations that failed, by error code' }),
          duration: meter.createHistogram(`${prefix}.op.duration`, {
            description: 'Time from invocation to answer',
            unit: 'ms',
          }),
        }
      : {}),
  }
}

/** What every span and metric this plugin emits is tagged with. */
function baseAttributes(inv: Invocation, options: OtelOptions): OtelAttributes {
  return {
    'omniface.facet': inv.facet,
    'omniface.op': inv.op.id,
    'omniface.request_id': inv.requestId,
    'omniface.actor.kind': inv.principal.kind,
    ...(options.actorId ? { 'omniface.actor.id': inv.principal.id } : {}),
    ...(inv.client?.name ? { 'omniface.client': [inv.client.name, inv.client.version].filter(Boolean).join('/') } : {}),
    ...(inv.op.op.traits.readonly ? { 'omniface.readonly': true } : {}),
    ...options.attributes?.(inv),
  }
}

/** Drop the keys with no value: an attribute that is `undefined` is noise in every backend. */
function defined(attributes: OtelAttributes): OtelAttributes {
  return Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined))
}

export function otel(options: OtelOptions = {}) {
  let instruments: Promise<Instruments> | undefined

  return definePlugin<{ span?: OtelSpan }>({
    name: 'otel',
    async wrap(inv, next) {
      const { tracer, api, calls, errors, duration } = await (instruments ??= resolve(options))
      const attributes = defined(baseAttributes(inv, options))
      const span = tracer?.startSpan(options.spanName?.(inv) ?? inv.op.id, {
        kind: SPAN_KIND_SERVER,
        attributes,
      })
      if (span) inv.ctx.span = span

      const finish = (outcome: string, code?: string) => {
        const metricAttributes = defined({ ...attributes, 'omniface.request_id': undefined, 'omniface.outcome': outcome })
        calls?.add(1, metricAttributes)
        duration?.record(Date.now() - inv.startedAt, metricAttributes)
        if (code) errors?.add(1, defined({ ...metricAttributes, 'omniface.error.code': code }))
        span?.end()
      }

      // The span is made active so anything instrumented downstream (a database driver, an HTTP
      // client in a handler) nests under the operation rather than floating beside it.
      const run = async () => {
        try {
          const output = await next()
          finish('ok')
          return output
        } catch (raw) {
          const err = toFacetError(raw)
          span?.setAttribute('omniface.error.code', err.code)
          // A client error is an outcome, not a broken server: only 5xx makes the span red.
          if (err.status >= 500) {
            span?.setStatus({ code: STATUS_ERROR, message: err.message })
            span?.recordException(err as never)
          }
          finish(err.code, err.code)
          throw err
        }
      }

      if (!span || !api) return run()
      return api.context.with(api.trace.setSpan(api.context.active() as never, span as never) as never, run)
    },
  })
}
