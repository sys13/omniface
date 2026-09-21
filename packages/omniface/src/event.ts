import { toJSONSchema, type JSONSchema } from './jsonschema.ts'
import type { AnySchema, InferIn } from './standard.ts'

/**
 * An event an operation declares it emits.
 *
 * It is a declaration, not a transport. Webhooks, SSE and queue consumers are each a separate
 * story, and what makes them possible to write is that none of them gets to ask the app what its
 * events are — they read this. An event declared once is the same event on every one of them,
 * with the same name and the same payload schema, because there is nowhere else to say it.
 *
 * ```ts
 * const TaskCreated = defineEvent({ name: 'task.created', payload: Task })
 *
 * f.op({ input: NewTask, output: Task })
 *   .emits(TaskCreated)
 *   .handle(({ input, emit }) => {
 *     const task = save(input)
 *     emit(TaskCreated, task)
 *     return task
 *   })
 * ```
 */
export interface EventDefinition<S extends AnySchema = AnySchema> {
  readonly kind: 'omniface.event'
  /** Dotted, lowercase: `task.created`. What every transport calls this event. */
  readonly name: string
  /** What the payload has to be. Validated on emit, the way an op's output is. */
  readonly payload: S
  readonly description?: string
}

/** What a sink is handed. The op and the request are on it, so a sink never has to be told them. */
export type EmittedEvent = {
  /** The declared event name. */
  readonly event: string
  /** The op that emitted it. */
  readonly op: string
  /** The invocation it came out of, so a sink can correlate it with a log line or a trace. */
  readonly requestId: string
  /** When the handler emitted it, as epoch milliseconds. */
  readonly at: number
  /** Validated against the event's declared schema, with internal fields stripped. */
  readonly payload: unknown
}

/**
 * Something that receives emitted events. In-process: `app.subscribe(sink)`.
 *
 * A sink that throws fails the invocation. That is a placeholder, not a delivery policy — see
 * `docs/BACKLOG.md` 9.2, which is where durable delivery, retries and replay are decided. The
 * alternative available today is to swallow the error, and a lost event nobody is told about is
 * the failure this project would rather be loud about.
 */
export type EventSink = (event: EmittedEvent) => void | Promise<void>

/** What a handler is handed to emit with. Only an event the op declared is accepted. */
export type Emit = <S extends AnySchema>(event: EventDefinition<S>, payload: InferIn<S>) => void

const NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/

export function defineEvent<S extends AnySchema>(config: {
  name: string
  payload: S
  description?: string
}): EventDefinition<S> {
  if (!NAME.test(config.name)) {
    throw new Error(`facet: event name "${config.name}" must be lowercase, dotted: "task.created"`)
  }
  return Object.freeze({
    kind: 'omniface.event',
    name: config.name,
    payload: config.payload,
    ...(config.description ? { description: config.description } : {}),
  }) as EventDefinition<S>
}

export function isEvent(value: unknown): value is EventDefinition {
  return typeof value === 'object' && value !== null && (value as EventDefinition).kind === 'omniface.event'
}

// A payload schema is converted once per definition. An event is usually declared at module scope
// and emitted on every call, and converting on every call would be the kind of cost nobody sees.
const schemas = new WeakMap<object, JSONSchema>()

/** The event's payload as JSON Schema. What the projection advertises and what emit validates. */
export function eventSchema(event: EventDefinition): JSONSchema {
  let schema = schemas.get(event)
  if (!schema) {
    schema = toJSONSchema(event.payload, 'output')
    schemas.set(event, schema)
  }
  return schema
}
