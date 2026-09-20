import * as api from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { errors, facet, type App, type FacetName } from '../src/index.ts'
import { otel, type OtelApi, type OtelAttributes, type OtelSpan } from '../src/plugins/otel.ts'

// Backlog 3.4: tracing plus RED metrics, tagged by facet, from one plugin in `wrap`.

type Recorded = {
  spans: { name: string; attributes: OtelAttributes; status?: { code: number; message?: string }; ended: boolean }[]
  metrics: { instrument: string; value: number; attributes: OtelAttributes }[]
}

/** A tracer and a meter that only remember what they were told. */
function recorder() {
  const recorded: Recorded = { spans: [], metrics: [] }
  const instrument = (instrumentName: string) => ({
    add: (value: number, attributes: OtelAttributes = {}) => recorded.metrics.push({ instrument: instrumentName, value, attributes }),
    record: (value: number, attributes: OtelAttributes = {}) => recorded.metrics.push({ instrument: instrumentName, value, attributes }),
  })
  const tracer = {
    startSpan(name: string, options?: { attributes?: OtelAttributes }): OtelSpan {
      const span = { name, attributes: { ...options?.attributes }, ended: false } as Recorded['spans'][number]
      recorded.spans.push(span)
      return {
        setAttribute: (key: string, value: string | number | boolean) => (span.attributes[key] = value),
        setStatus: (status: { code: number; message?: string }) => (span.status = status),
        recordException: () => undefined,
        end: () => (span.ended = true),
      }
    },
  }
  const meter = { createCounter: instrument, createHistogram: instrument }
  return { recorded, tracer, meter }
}

function tracedApp(options: Parameters<typeof otel>[0]) {
  const f = facet({ plugins: [otel(options)] })
  return f.app({
    name: 'notes',
    ops: {
      notes: {
        get: f
          .op({ input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) })
          .traits({ readonly: true, public: true })
          .handle(({ input }) => ({ id: input.id })),
        boom: f
          .op({ output: z.object({ ok: z.boolean() }) })
          .traits({ public: true })
          .handle(() => {
            throw errors.internal('handler exploded')
          }),
        nope: f
          .op({ output: z.object({ ok: z.boolean() }) })
          .traits({ public: true })
          .handle(() => {
            throw errors.notFound('no such note')
          }),
      },
    },
  })
}

const call = (app: App<any>, id: string, input: unknown = {}, facetName: FacetName = 'rest') =>
  app.invoke(id, input, { facet: facetName }).catch(() => undefined)

describe('the otel plugin', () => {
  it('opens one span per invocation, tagged by facet and op', async () => {
    const { recorded, tracer, meter } = recorder()
    const app = tracedApp({ tracer, meter })
    await call(app, 'notes.get', { id: 'n1' }, 'mcp')
    expect(recorded.spans.length).toBe(1)
    const [span] = recorded.spans
    expect(span!.name).toBe('notes.get')
    expect(span!.ended).toBe(true)
    expect(span!.attributes).toMatchObject({
      'omniface.facet': 'mcp',
      'omniface.op': 'notes.get',
      'omniface.actor.kind': 'anonymous',
      'omniface.readonly': true,
    })
    expect(span!.attributes['omniface.request_id']).toEqual(expect.any(String))
    expect(span!.attributes['omniface.actor.id']).toBeUndefined()
  })

  it('records RED metrics, with the facet as a dimension and no request id', async () => {
    const { recorded, tracer, meter } = recorder()
    const app = tracedApp({ tracer, meter })
    await call(app, 'notes.get', { id: 'n1' }, 'cli')
    const byInstrument = Object.fromEntries(recorded.metrics.map((m) => [m.instrument, m]))
    expect(Object.keys(byInstrument).sort()).toEqual(['omniface.op.calls', 'omniface.op.duration'])
    expect(byInstrument['omniface.op.calls']!.value).toBe(1)
    expect(byInstrument['omniface.op.calls']!.attributes).toMatchObject({ 'omniface.facet': 'cli', 'omniface.outcome': 'ok' })
    expect(byInstrument['omniface.op.calls']!.attributes['omniface.request_id']).toBeUndefined()
    expect(byInstrument['omniface.op.duration']!.value).toBeGreaterThanOrEqual(0)
  })

  it('counts an error once, under its facet error code', async () => {
    const { recorded, tracer, meter } = recorder()
    const app = tracedApp({ tracer, meter })
    await call(app, 'notes.nope')
    const errorMetrics = recorded.metrics.filter((m) => m.instrument === 'omniface.op.errors')
    expect(errorMetrics.length).toBe(1)
    expect(errorMetrics[0]!.attributes).toMatchObject({ 'omniface.outcome': 'not_found', 'omniface.error.code': 'not_found' })
  })

  it('reddens the span for a server error, not for a caller error', async () => {
    const { recorded, tracer, meter } = recorder()
    const app = tracedApp({ tracer, meter })
    await call(app, 'notes.nope')
    await call(app, 'notes.boom')
    const [notFound, boom] = recorded.spans
    expect(notFound!.status).toBeUndefined()
    expect(notFound!.attributes['omniface.error.code']).toBe('not_found')
    expect(boom!.status).toEqual({ code: 2, message: expect.any(String) })
    expect(boom!.attributes['omniface.error.code']).toBe('internal')
  })

  it('records the actor id only when asked, and whatever else the app adds', async () => {
    const { recorded, tracer, meter } = recorder()
    const app = tracedApp({ tracer, meter, actorId: true, attributes: (inv) => ({ 'acme.tenant': `t_${inv.facet}` }) })
    await call(app, 'notes.get', { id: 'n1' })
    expect(recorded.spans[0]!.attributes).toMatchObject({ 'omniface.actor.id': 'anonymous', 'acme.tenant': 't_rest' })
  })

  it('hands the handler its span, so an app can annotate its own work', async () => {
    const { recorded, tracer, meter } = recorder()
    const f = facet({ plugins: [otel({ tracer, meter })] })
    const app = f.app({
      name: 'notes',
      ops: {
        notes: {
          get: f
            .op({ output: z.object({ ok: z.boolean() }) })
            .traits({ public: true })
            .handle(({ ctx }) => {
              ctx.span?.setAttribute('acme.rows', 7)
              return { ok: true }
            }),
        },
      },
    })
    await call(app, 'notes.get')
    expect(recorded.spans[0]!.attributes['acme.rows']).toBe(7)
  })

  it('does nothing at all when no API and no instruments are available', async () => {
    // `api: undefined` with explicit no-op instruments is the installed-but-unconfigured case;
    // this is the not-installed one, faked by handing it an API that provides nothing.
    const empty = {
      trace: { getTracer: () => undefined, setSpan: () => undefined },
      metrics: { getMeter: () => undefined },
      context: { active: () => undefined, with: (_ctx: never, fn: () => unknown) => fn() },
    } as unknown as OtelApi
    const app = tracedApp({ api: empty })
    await expect(app.invoke('notes.get', { id: 'n1' }, { facet: 'rest' })).resolves.toEqual({ id: 'n1' })
  })

  it('accepts the real @opentelemetry/api module', async () => {
    const seen: string[] = []
    const app = tracedApp({ api, attributes: () => ({ 'acme.seen': seen.push('x') }) })
    // With no SDK registered the API hands out no-op implementations; the point is that the real
    // module type-checks and runs through this plugin end to end.
    await expect(app.invoke('notes.get', { id: 'n1' }, { facet: 'rest' })).resolves.toEqual({ id: 'n1' })
    expect(seen).toEqual(['x'])
    expect(api.trace.getActiveSpan()).toBeUndefined()
  })
})
