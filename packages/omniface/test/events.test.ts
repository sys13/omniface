import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { diffManifests } from '../src/diff.ts'
import { buildManifest, defineEvent, facet, type App, type EmittedEvent } from '../src/index.ts'
import { declaredEvents, eventsOf, eventsSettings } from '../src/facets/events.facet.ts'
import { inspectOp } from '../src/inspect.ts'
import { definePlugin } from '../src/plugin.ts'
import type { AnySchema } from '../src/standard.ts'
import { t } from '../src/zod/index.ts'

// Backlog 9.1: the declaration webhooks, SSE and queues all read from. The claim under test is
// narrow on purpose — that an event is written down once, on the op, and that everything which
// carries it reads it from there. Delivery is 9.2, 9.3 and 9.6; none of it is here.

const f = facet()

const Task = t.named(
  'Task',
  z.object({
    id: t.id(),
    title: z.string(),
    score: t(z.number(), { internal: true }),
  }),
)

const TaskCreated = defineEvent({ name: 'task.created', payload: Task, description: 'A task was created' })
const TaskArchived = defineEvent({ name: 'task.archived', payload: z.object({ id: z.string() }) })

const ops = {
  tasks: {
    create: f
      .op({ input: z.object({ title: z.string() }), output: Task })
      .emits(TaskCreated)
      .handle(({ input, emit }) => {
        const task = { id: 'task_1', title: input.title, score: 0.5 }
        emit(TaskCreated, task)
        return task
      }),
    list: f
      .op({ output: z.object({ items: z.array(Task) }) })
      .traits({ readonly: true })
      .handle(() => ({ items: [] })),
  },
}

const app = () => f.app({ name: 'acme', ops }) as unknown as App<any>
const opOf = (a: App<any>, id: string) => buildManifest(a).ops.find((o) => o.id === id)!

describe('declaring an event', () => {
  it('puts it on the op, where every transport reads it from', () => {
    expect(ops.tasks.create.emits.map((e) => e.name)).toEqual(['task.created'])
    expect(ops.tasks.list.emits).toEqual([])
  })

  it('refuses a name a transport cannot carry', () => {
    expect(() => defineEvent({ name: 'Task Created', payload: Task })).toThrow(/lowercase, dotted/)
  })

  it('refuses the same event twice on one op, which would deliver it twice', () => {
    expect(() => f.op({ output: Task }).emits(TaskCreated).emits(TaskCreated)).toThrow(/twice/)
  })

  it('keeps the declaration through .traits(), whichever order they are written in', () => {
    const before = f.op({ output: Task }).emits(TaskCreated).traits({ destructive: true }).handle(() => null as any)
    const after = f.op({ output: Task }).traits({ destructive: true }).emits(TaskCreated).handle(() => null as any)
    expect(before.emits.map((e) => e.name)).toEqual(['task.created'])
    expect(after.emits.map((e) => e.name)).toEqual(['task.created'])
  })
})

describe('the events projection', () => {
  it('carries the event under the facet’s own key, beside the other projections', () => {
    const manifest = buildManifest(app())
    expect(Object.keys(manifest.facets)).toContain('events')
    expect(eventsOf(opOf(app(), 'tasks.create'))).toMatchObject({ events: [{ name: 'task.created' }] })
    expect(eventsOf(opOf(app(), 'tasks.list'))).toBeNull()
  })

  it('advertises the payload schema, with internal fields stripped', () => {
    const projection = eventsOf(opOf(app(), 'tasks.create'))!
    expect(Object.keys(projection.events[0]!.payload.properties!)).toEqual(['id', 'title'])
    expect(JSON.stringify(projection.events[0]!.payload)).not.toContain('x-omniface-internal')
  })

  it('collects a catalog of the app’s events, with the ops that emit each one', () => {
    const manifest = buildManifest(app())
    expect(declaredEvents(manifest)).toMatchObject([{ name: 'task.created', ops: ['tasks.create'] }])
    expect(eventsSettings(manifest)!.events[0]!.description).toBe('A task was created')
  })

  it('is off when the app says so, and then advertises nothing', () => {
    const off = f.app({ name: 'acme', ops, facets: { rest: true } }) as unknown as App<any>
    const manifest = buildManifest(off)
    expect(Object.keys(manifest.facets)).not.toContain('events')
    expect(declaredEvents(manifest)).toEqual([])
  })

  it('reaches `omniface inspect` without inspect being taught about it', () => {
    const card = inspectOp(app(), 'tasks.create')!.facets['events']
    expect(card).toMatchObject({ label: 'Events', short: 'task.created' })
    expect(inspectOp(app(), 'tasks.list')!.facets['events']).toBeNull()
  })
})

describe('configuring the facet', () => {
  it('refuses a config that is not one, instead of accepting it and ignoring it', () => {
    f.app({
      name: 'acme',
      ops,
      // @ts-expect-error — 'yes' is not an events config, and `{}` used to accept it
      facets: { events: 'yes' },
    })
  })

  it('takes an op out of the catalog without touching what the op declares', () => {
    const a = f.app({ name: 'acme', ops, facets: { events: { ops: { 'tasks.create': false } } } }) as unknown as App<any>
    expect(declaredEvents(buildManifest(a))).toEqual([])
    expect(eventsOf(opOf(a, 'tasks.create'))).toBeNull()
    // The declaration is still on the op. What changed is what the app advertises.
    expect(ops.tasks.create.emits.map((e) => e.name)).toEqual(['task.created'])
  })

  it('still delivers to an in-process sink, because a projection is not a switch', () => {
    const a = f.app({ name: 'acme', ops, facets: { events: { ops: { 'tasks.create': false } } } }) as unknown as App<any>
    const seen: EmittedEvent[] = []
    a.subscribe?.((event: EmittedEvent) => void seen.push(event))
    return a.invoke('tasks.create', { title: 'A' }, { facet: 'rest' }).then(() => {
      expect(seen.map((e) => e.event)).toEqual(['task.created'])
    })
  })

  it('names the op id when the key is a typo', () => {
    expect(() =>
      f.app({
        name: 'acme',
        ops,
        // @ts-expect-error — 'tasks.nope' is not an op id
        facets: { events: { ops: { 'tasks.nope': false } } },
      }),
    ).toThrow(/unknown ops.*events\.ops: "tasks\.nope"/)
  })

  it('refuses an opt-out for an op that emits nothing, which would do nothing', () => {
    expect(() => f.app({ name: 'acme', ops, facets: { events: { ops: { 'tasks.list': false } } } })).toThrow(
      /facets\.events\.ops names "tasks\.list", which declares no events/,
    )
  })
})

describe('emitting', () => {
  it('delivers the declared event to a subscriber, whichever facet called', async () => {
    const a = app()
    const seen: EmittedEvent[] = []
    a.subscribe((event) => void seen.push(event))
    await a.invoke('tasks.create', { title: 'Write docs' }, { facet: 'rest' })
    await a.invoke('tasks.create', { title: 'Write docs' }, { facet: 'cli' })
    expect(seen.map((e) => e.event)).toEqual(['task.created', 'task.created'])
    expect(seen[0]).toMatchObject({ op: 'tasks.create', payload: { id: 'task_1', title: 'Write docs' } })
    expect(seen[0]!.requestId).toMatch(/^req_/)
  })

  // The shape is pinned, not just spot-checked. A field a sink is handed and nothing reads is a
  // field nothing can keep honest — `at` was one, and it went. This fails when one comes back
  // without a reader, which is the moment to give it a test rather than three releases later.
  it('hands a sink these fields and no others', async () => {
    const a = app()
    const seen: EmittedEvent[] = []
    a.subscribe((event) => void seen.push(event))
    await a.invoke('tasks.create', { title: 'A' }, { facet: 'rest' })
    expect(Object.keys(seen[0]!).sort()).toEqual(['event', 'op', 'payload', 'requestId'])
  })

  it('strips internal fields from the payload, as every other surface does', async () => {
    const a = app()
    const seen: EmittedEvent[] = []
    a.subscribe((event) => void seen.push(event))
    await a.invoke('tasks.create', { title: 'A' }, { facet: 'rest' })
    expect(seen[0]!.payload).toEqual({ id: 'task_1', title: 'A' })
  })

  it('stops delivering once unsubscribed', async () => {
    const a = app()
    const sink = vi.fn()
    a.subscribe(sink)()
    await a.invoke('tasks.create', { title: 'A' }, { facet: 'rest' })
    expect(sink).not.toHaveBeenCalled()
  })

  it('refuses an event the op did not declare', async () => {
    const rogue = facet().app({
      name: 'acme',
      ops: {
        create: f
          .op({ output: Task })
          .emits(TaskCreated)
          .handle(({ emit }) => {
            emit(TaskArchived, { id: 'task_1' })
            return { id: 'task_1', title: 'A', score: 0 }
          }),
      },
    }) as unknown as App<any>
    await expect(rogue.invoke('create', {}, { facet: 'rest' })).rejects.toThrow(/does not declare/)
  })

  it('refuses a payload that does not match the declared schema', async () => {
    const wrong = facet().app({
      name: 'acme',
      ops: {
        create: f
          .op({ output: Task })
          .emits(TaskCreated)
          .handle(({ emit }) => {
            emit(TaskCreated, { id: 'task_1', title: 42 as unknown as string, score: 0 })
            return { id: 'task_1', title: 'A', score: 0 }
          }),
      },
    }) as unknown as App<any>
    await expect(wrong.invoke('create', {}, { facet: 'rest' })).rejects.toThrow(/does not match its schema/)
  })

  it('emits nothing when the handler throws: the work did not happen', async () => {
    const failing = facet().app({
      name: 'acme',
      ops: {
        create: f
          .op({ output: Task })
          .emits(TaskCreated)
          .handle(({ emit }) => {
            emit(TaskCreated, { id: 'task_1', title: 'A', score: 0 })
            throw new Error('the store was down')
          }),
      },
    }) as unknown as App<any>
    const sink = vi.fn()
    failing.subscribe(sink)
    await expect(failing.invoke('create', {}, { facet: 'rest' })).rejects.toThrow()
    expect(sink).not.toHaveBeenCalled()
  })

  it('shows a plugin what was emitted, without telling it the app’s events', async () => {
    const seen: string[] = []
    const recorder = definePlugin({
      name: 'recorder',
      hooks: { after: (inv) => void seen.push(...inv.emitted.map((e) => e.event)) },
    })
    const a = facet({ plugins: [recorder] }).app({ name: 'acme', ops }) as unknown as App<any>
    await a.invoke('tasks.create', { title: 'A' }, { facet: 'rest' })
    expect(seen).toEqual(['task.created'])
  })

  it('delivers only after the hooks have run, so a delivered event is one that happened', async () => {
    const order: string[] = []
    const late = definePlugin({
      name: 'late',
      // A hook can still answer, refuse or change the output at this stage. Delivering before it
      // would mean a sink had already been told about an invocation that was not finished.
      hooks: { after: () => void order.push('after') },
    })
    const a = facet({ plugins: [late] }).app({ name: 'acme', ops }) as unknown as App<any>
    a.subscribe(() => void order.push('sink'))
    await a.invoke('tasks.create', { title: 'A' }, { facet: 'rest' })
    expect(order).toEqual(['after', 'sink'])
  })

  it('fails the invocation when a sink throws, rather than losing the event quietly', async () => {
    const a = app()
    a.subscribe(() => {
      throw new Error('the sink is down')
    })
    // Not a delivery policy. Retries, replay and a dead-letter are 9.2's to decide; until then the
    // choice is between a loud failure and a silent hole, and this is the loud one.
    await expect(a.invoke('tasks.create', { title: 'A' }, { facet: 'rest' })).rejects.toMatchObject({
      code: 'internal',
    })
  })
})

describe('what a change to an event costs a consumer', () => {
  const withEvents = (events: { name: string; payload?: AnySchema }[]) =>
    buildManifest(
      facet().app({
        name: 'acme',
        ops: {
          create: events
            .reduce(
              (builder, e) => builder.emits(defineEvent({ name: e.name, payload: e.payload ?? Task })),
              f.op({ output: Task }),
            )
            .handle(() => null as any),
        },
      }) as unknown as App<any>,
    )

  const both = [{ name: 'task.created' }, { name: 'task.archived' }]
  const one = [{ name: 'task.created' }]

  it('calls dropping an event breaking, and adding one additive', () => {
    const removed = diffManifests(withEvents(both), withEvents(one)).changes.find((c) => c.rule === 'event-removed')
    expect(removed).toMatchObject({ level: 'breaking', facets: ['events'], op: 'create' })
    const added = diffManifests(withEvents(one), withEvents(both)).changes.find((c) => c.rule === 'event-added')
    expect(added).toMatchObject({ level: 'additive' })
  })

  it('calls a field leaving the payload breaking, and one arriving additive', () => {
    const narrower = t.named('Task', z.object({ id: t.id() }))
    const changes = diffManifests(withEvents(one), withEvents([{ name: 'task.created', payload: narrower }])).changes
    expect(changes.find((c) => c.rule === 'event-payload-field-removed')).toMatchObject({ level: 'breaking' })
    const back = diffManifests(withEvents([{ name: 'task.created', payload: narrower }]), withEvents(one)).changes
    expect(back.find((c) => c.rule === 'event-payload-field-added')).toMatchObject({ level: 'additive' })
  })

  // The consumer this catches is the furthest away of any: a webhook or queue reader in another
  // process, often another language, that generated types from the catalog and recompiles against
  // nothing. Before this the rename was silent here, and loud on the SDK.
  it('calls a renamed payload type breaking for events, and exits `--strict` non-zero', () => {
    const renamed = t.named('TaskRow', z.object({ id: t.id(), title: z.string() }))
    const d = diffManifests(withEvents(one), withEvents([{ name: 'task.created', payload: renamed }]))
    const change = d.changes.find((c) => c.rule === 'event-payload-type-renamed')
    expect(change).toMatchObject({ level: 'breaking', facets: ['events'], op: 'create' })
    expect(change!.message).toContain('carries TaskRow, was Task')
    expect(d.breakingFacets).toContain('events')
    // `omniface diff --strict` exits 1 on any breaking count, which is what it reads.
    expect(d.counts.breaking).toBeGreaterThan(0)
  })

  // The generic rule compares the op's input and output. The events facet reads neither, so it is
  // never named there: a rename it can see is its own rule's, and one it cannot see leaves it out.
  // The SDK's reading does not move — same rule, same level, same message, same facets.
  describe('which rename rule names events', () => {
    const shape = { id: t.id(), title: z.string() }
    const Payload = t.named('Task', z.object(shape))
    const build = (input: AnySchema, output: AnySchema, payload: AnySchema) =>
      buildManifest(
        facet().app({
          name: 'acme',
          ops: {
            create: f
              .op({ input: input as never, output: output as never })
              .emits(defineEvent({ name: 'task.created', payload }))
              .handle(() => null as any),
          },
        }) as unknown as App<any>,
      )

    it('leaves events out when the op’s input type is renamed and the payload is not', () => {
      const d = diffManifests(
        build(t.named('NewTask', z.object({ title: z.string() })), Payload, Payload),
        build(t.named('TaskDraft', z.object({ title: z.string() })), Payload, Payload),
      )
      const generic = d.changes.find((c) => c.rule === 'type-renamed')!
      expect(generic).toMatchObject({ level: 'breaking', message: 'create input type NewTask → TaskDraft.' })
      expect(generic.facets).toEqual(['rest', 'sdk'])
      expect(d.changes.some((c) => c.rule.startsWith('event-'))).toBe(false)
      expect(d.breakingFacets).not.toContain('events')
    })

    it('leaves events out when the op’s output type is renamed and the payload is not', () => {
      const d = diffManifests(
        build(z.object({}), t.named('TaskList', z.object(shape)), Payload),
        build(z.object({}), t.named('TaskPage', z.object(shape)), Payload),
      )
      expect(d.changes.find((c) => c.rule === 'type-renamed')!.facets).toEqual(['rest', 'sdk'])
      expect(d.breakingFacets).not.toContain('events')
    })

    it('names events through its own rule when the payload is the renamed type', () => {
      const renamed = t.named('TaskRow', z.object(shape))
      const d = diffManifests(build(z.object({}), Payload, Payload), build(z.object({}), renamed, renamed))
      const generic = d.changes.find((c) => c.rule === 'type-renamed')!
      expect(generic).toMatchObject({ level: 'breaking', message: 'create output type Task → TaskRow.' })
      expect(generic.facets).toEqual(['rest', 'sdk'])
      expect(d.changes.find((c) => c.rule === 'event-payload-type-renamed')).toMatchObject({ facets: ['events'] })
      expect(d.breakingFacets).toContain('events')
    })
  })

  describe('the catalog: which ops stand behind a name', () => {
    const Created = defineEvent({ name: 'task.created', payload: Task })
    const withEmitters = (emitters: string[], config?: unknown) =>
      buildManifest(
        facet().app({
          name: 'acme',
          ops: Object.fromEntries(
            ['create', 'import'].map((id) => {
              const op = f.op({ output: Task })
              return [id, (emitters.includes(id) ? op.emits(Created) : op).handle(() => null as any)]
            }),
          ),
          ...(config ? { facets: { events: config } } : {}),
        }) as unknown as App<any>,
      )

    it('calls one of two emitters dropping an event breaking, naming the one that still emits it', () => {
      const changes = diffManifests(withEmitters(['create', 'import']), withEmitters(['create'])).changes
      expect(changes.find((c) => c.rule === 'event-emitter-removed')).toMatchObject({
        level: 'breaking',
        facets: ['events'],
        message: '"task.created" is no longer emitted by import; create still emits it.',
      })
      expect(changes.some((c) => c.rule === 'event-left-catalog')).toBe(false)
    })

    it('calls a second emitter joining a name additive', () => {
      const changes = diffManifests(withEmitters(['create']), withEmitters(['create', 'import'])).changes
      expect(changes.find((c) => c.rule === 'event-emitter-added')).toMatchObject({
        level: 'additive',
        facets: ['events'],
        message: '"task.created" is now emitted by import as well.',
      })
    })

    it('calls the last emitter going breaking for the name, whatever took it away', () => {
      const dropped = diffManifests(withEmitters(['create']), withEmitters([])).changes
      expect(dropped.find((c) => c.rule === 'event-left-catalog')).toMatchObject({ level: 'breaking', facets: ['events'] })
      // An opt-out keeps the declaration and the in-process sink, and still takes the name out of
      // what the app advertises. The catalog is what a consumer reads, so it is the same change.
      const optedOut = diffManifests(withEmitters(['create']), withEmitters(['create'], { ops: { create: false } })).changes
      expect(optedOut.find((c) => c.rule === 'event-left-catalog')!.message).toBe(
        'No op advertises "task.created" any more; it was emitted by create.',
      )
    })

    it('says nothing when the catalog did not move', () => {
      const changes = diffManifests(withEmitters(['create', 'import']), withEmitters(['create', 'import'])).changes
      expect(changes).toEqual([])
    })
  })

  it('calls an op that stops emitting altogether no longer exposed on the facet', () => {
    const none = buildManifest(
      facet().app({ name: 'acme', ops: { create: f.op({ output: Task }).handle(() => null as any) } }) as unknown as App<any>,
    )
    const changes = diffManifests(withEvents(one), none).changes
    expect(changes.find((c) => c.rule === 'op-unprojected')).toMatchObject({ level: 'breaking', facets: ['events'] })
  })
})
