import type { App } from '../app.ts'
import { eventSchema } from '../event.ts'
import { defineFacet, projectionOf, registerFacet, settingsOf, type FacetChange } from '../facet.ts'
import { objectProperties, publicSchema, typeName, type JSONSchema } from '../jsonschema.ts'
import type { Manifest, ManifestOp } from '../manifest.ts'

/** One declared event, as it travels: the name a transport uses and the payload it carries. */
export type ManifestEvent = {
  name: string
  payload: JSONSchema
  description?: string
}

/** What the events facet does with one op: the events it declares. `null` if it declares none. */
export type EventsProjection = { events: ManifestEvent[] }

/**
 * The app's events, each with the ops that emit it. The catalog a transport reads: a webhook
 * sender subscribing to `task.created` asks this what `task.created` is, rather than being told
 * again in its own config.
 */
export type EventsSettings = { events: (ManifestEvent & { ops: string[] })[] }

/**
 * What an app may say about its events. One key, and it only takes things away.
 *
 * `ops` is an opt-out: `{ ops: { 'tasks.archive': false } }` stops that op advertising what it
 * emits. It is typed `false` rather than `boolean` because there is no opting *in* — an op that
 * declares an event is already in, and a key that could be written `true` to no effect is the
 * shape of config this project keeps filing issues about.
 *
 * There is nothing here about where events go. A webhook endpoint, a retry budget and a
 * subscription belong to the transports (docs/BACKLOG.md 9.2, 9.3, 9.6), and each of those reads
 * the catalog rather than being told again here.
 */
export type EventsConfig<Id extends string = string> = {
  /** Ops that keep their `.emits()` declaration to themselves. A key naming no op fails `app()`. */
  ops?: Partial<Record<Id, false>>
}

export const eventsOf = (op: ManifestOp): EventsProjection | null => projectionOf<EventsProjection>(op, 'events')
export const eventsSettings = (manifest: Manifest): EventsSettings | null =>
  settingsOf<EventsSettings>(manifest, 'events')

/** Every event in the catalog, or an empty list when the facet is off. */
export function declaredEvents(manifest: Manifest): (ManifestEvent & { ops: string[] })[] {
  return eventsSettings(manifest)?.events ?? []
}

function byName(events: ManifestEvent[]): Map<string, ManifestEvent> {
  return new Map(events.map((e) => [e.name, e]))
}

/**
 * The events facet: what an op says it emits, projected once so every asynchronous transport
 * reads the same thing.
 *
 * Not served. It is the declaration webhooks (9.2), streaming (9.3) and queue consumers (9.6)
 * each read from, and none of those exists yet — what this facet proves is that when they do,
 * they will not each be a second place to write down what an event is called and what is in it.
 */
export const eventsFacet = defineFacet<EventsConfig, EventsProjection, EventsSettings>({
  name: 'events',
  order: 5,
  // On unless an app says otherwise, because an op that declares an event has already said it
  // wants one. A facet that had to be turned on as well would make `.emits()` do nothing and say
  // nothing about it, which is the shape of default this project keeps filing issues about.
  defaultOn: true,
  normalize: (value) =>
    value === undefined || value === false ? null : value === true ? {} : (value as EventsConfig),
  references: (config) => [{ where: 'events.ops', ids: Object.keys(config.ops ?? {}) }],

  // An op that emits nothing has nothing to opt out of. The key is inert either way, so the only
  // thing it can mean is that the author expected an event there and is not getting one.
  check(config, ops) {
    for (const id of Object.keys(config.ops ?? {})) {
      // An id that is not an op at all is `references`' message to give, and it has not thrown yet.
      const found = ops.get(id)
      if (found && !found.op.emits.length) {
        throw new Error(`facet: facets.events.ops names "${id}", which declares no events`)
      }
    }
  },

  project({ op }, config) {
    if (config.ops?.[op.id] === false) return null
    if (!op.op.emits.length) return null
    return {
      events: op.op.emits.map((event) => ({
        name: event.name,
        payload: publicSchema(eventSchema(event)),
        ...(event.description ? { description: event.description } : {}),
      })),
    }
  },

  settings(_app: App, _config, ops) {
    const catalog = new Map<string, ManifestEvent & { ops: string[] }>()
    for (const op of ops) {
      for (const event of eventsOf(op)?.events ?? []) {
        const existing = catalog.get(event.name)
        if (existing) existing.ops.push(op.id)
        else catalog.set(event.name, { ...event, ops: [op.id] })
      }
    }
    return { events: [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name)) }
  },

  // A renamed `t.named()` type is breaking here for the same reason it is on the SDK: the catalog
  // advertises the payload under that name, and a consumer generating types from it sees the
  // change. It sees it further away than an SDK caller does — another process, often another
  // language, recompiling against nothing.
  observes: { typeNames: true },

  diff(before, after, { op }): FacetChange[] {
    const changes: FacetChange[] = []
    const was = byName(before.events)
    const now = byName(after.events)
    for (const name of was.keys()) {
      if (now.has(name)) continue
      changes.push({
        level: 'breaking',
        rule: 'event-removed',
        message: `${op}: no longer emits "${name}".`,
        detail: 'A consumer subscribed to it keeps waiting, and nothing tells it the event stopped.',
      })
    }
    for (const name of now.keys()) {
      if (was.has(name)) continue
      changes.push({ level: 'additive', rule: 'event-added', message: `${op}: emits "${name}".` })
    }
    for (const [name, before] of was) {
      const after = now.get(name)
      if (!after) continue
      const wasFields = Object.keys(objectProperties(before.payload))
      const nowFields = new Set(Object.keys(objectProperties(after.payload)))
      const gone = wasFields.filter((field) => !nowFields.has(field))
      if (gone.length) {
        changes.push({
          level: 'breaking',
          rule: 'event-payload-field-removed',
          message: `${op}: "${name}" no longer carries ${gone.join(', ')}.`,
          detail: 'A consumer reading those fields gets undefined, on every transport at once.',
        })
      }
      const wasType = typeName(before.payload)
      const isType = typeName(after.payload)
      if (wasType !== isType && (wasType || isType)) {
        changes.push({
          level: 'breaking',
          rule: 'event-payload-type-renamed',
          message: `${op}: "${name}" carries ${isType ?? '(unnamed)'}, was ${wasType ?? '(unnamed)'}.`,
          detail:
            'The catalog advertises the payload under that name. A consumer that generated types from it is holding the old one, and nothing it compiles against will tell it.',
        })
      }
      const added = [...nowFields].filter((field) => !wasFields.includes(field))
      if (added.length) {
        changes.push({
          level: 'additive',
          rule: 'event-payload-field-added',
          message: `${op}: "${name}" now carries ${added.join(', ')}.`,
        })
      }
    }
    return changes
  },

  present({ op }, projection) {
    const names = projection.events.map((event) => event.name)
    const snippet = `app.subscribe((event) => {\n  if (event.event === '${names[0]}') console.log(event.payload)\n})`
    return {
      label: 'Events',
      short: names.join(', '),
      snippet,
      line: `- Events: ${names.map((name) => `\`${name}\``).join(', ')}`,
      detail: { events: names, op: op.id },
    }
  },

  // No `summary`. The llms.txt intro says what the app is *reachable as*, and a declared event is
  // not reachable yet — the transports that would carry it are 9.2, 9.3 and 9.6. The per-op line
  // below says the event exists, which is the true claim available today.

  contract({ op, others }, projection) {
    const problems: string[] = []
    if (!projection) return problems
    // An op with no side effects has nothing to announce. Either the trait is wrong or the event
    // is, and both are worth being told about before a consumer builds on one of them.
    if (op.traits.readonly) {
      problems.push(`a readonly op emits ${projection.events.map((e) => e.name).join(', ')}`)
    }
    for (const event of projection.events) {
      if (event.payload.type !== 'object') {
        problems.push(`event "${event.name}" has a payload that is not an object`)
      }
      // The same name from two ops has to mean the same thing: a consumer subscribes to the name,
      // and which op emitted it is not something it gets to switch on.
      for (const other of others) {
        const theirs = eventsOf(other)?.events.find((e) => e.name === event.name)
        if (theirs && JSON.stringify(theirs.payload) !== JSON.stringify(event.payload)) {
          problems.push(`event "${event.name}" carries a different payload on ${other.id}`)
        }
      }
    }
    return problems
  },
})

registerFacet(eventsFacet)
