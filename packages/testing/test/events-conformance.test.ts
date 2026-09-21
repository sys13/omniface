import { defineEvent, facet, type App } from 'omniface'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { conformanceCases } from '../src/index.ts'

/**
 * Backlog 9.1's gate, second half: the generated suite sees the event projection the way it sees
 * the others. Nothing was added to `conformance.ts` for events — the facet's own `contract` is
 * asked for every op, so a declaration that cannot hold up is a failing case rather than a
 * comment in a review.
 */

const Note = z.object({ id: z.string(), body: z.string() })
const NoteCreated = defineEvent({ name: 'note.created', payload: Note })

function contractProblems(app: () => App, id: string) {
  const c = conformanceCases({ app, apiKey: 'k' }).find((x) => x.op === id && x.check === 'contract')!
  return c.run().then((r) => r.problems)
}

describe('the generated suite sees declared events', () => {
  it('passes an op whose declaration holds up', async () => {
    const f = facet()
    const app = () =>
      f.app({
        name: 'notes',
        ops: {
          create: f
            .op({ input: z.object({ body: z.string() }), output: Note })
            .emits(NoteCreated)
            .handle(({ emit, input }) => {
              const note = { id: 'n1', body: input.body }
              emit(NoteCreated, note)
              return note
            }),
        },
      }) as unknown as App
    expect(await contractProblems(app, 'create')).toEqual([])
  })

  it('reports an op that says it has no side effects and then announces one', async () => {
    const f = facet()
    const app = () =>
      f.app({
        name: 'notes',
        ops: {
          list: f
            .op({ output: z.object({ items: z.array(Note) }) })
            .traits({ readonly: true })
            .emits(NoteCreated)
            .handle(() => ({ items: [] })),
        },
      }) as unknown as App
    expect(await contractProblems(app, 'list')).toContain('a readonly op emits note.created')
  })

  it('reports one event name meaning two different things', async () => {
    const f = facet()
    // A consumer subscribes to the name. Which op emitted it is not something it gets to switch on,
    // so two payloads under one name is a promise the app cannot keep to both of them.
    const Other = defineEvent({ name: 'note.created', payload: z.object({ id: z.string() }) })
    const app = () =>
      f.app({
        name: 'notes',
        ops: {
          create: f.op({ output: Note }).emits(NoteCreated).handle(() => ({ id: 'n1', body: 'b' })),
          importNote: f.op({ output: Note }).emits(Other).handle(() => ({ id: 'n1', body: 'b' })),
        },
      }) as unknown as App
    expect(await contractProblems(app, 'create')).toContain('event "note.created" carries a different payload on importNote')
  })

  it('reports a payload a transport cannot carry as an object', async () => {
    const f = facet()
    const Scalar = defineEvent({ name: 'note.counted', payload: z.number() })
    const app = () =>
      f.app({
        name: 'notes',
        ops: { count: f.op({ output: Note }).emits(Scalar).handle(() => ({ id: 'n1', body: 'b' })) },
      }) as unknown as App
    expect(await contractProblems(app, 'count')).toContain('event "note.counted" has a payload that is not an object')
  })

  it('says nothing about an op that declares no events', async () => {
    const f = facet()
    const app = () =>
      f.app({
        name: 'notes',
        ops: { get: f.op({ output: Note }).traits({ readonly: true }).handle(() => ({ id: 'n1', body: 'b' })) },
      }) as unknown as App
    expect(await contractProblems(app, 'get')).toEqual([])
  })
})
