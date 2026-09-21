---
'omniface': minor
'@omniface/testing': minor
---

Operations declare the events they emit, and that declaration is the only place an event is
written down.

```ts
const TaskCreated = defineEvent({ name: 'task.created', payload: Task })

create: f
  .op({ input: NewTask, output: Task })
  .emits(TaskCreated)
  .handle(({ input, emit }) => {
    const task = save(input)
    emit(TaskCreated, task)
    return task
  })
```

The declaration is projected by a facet like every other projection: `manifest.facets.events` is
the app's catalog — each event's name, payload schema and the ops that emit it — and an op carries
its own events under `op.facets.events`. `omniface inspect` shows a card, `llms.txt` carries a line
per op, and `omniface diff` calls dropping an event or a payload field breaking and adding either
one additive. The generated conformance suite checks the declaration through the facet contract, so
a readonly op that emits, one name carrying two different payloads, or a payload that is not an
object is a failing case rather than a review comment.

At runtime a handler emits with `emit(Event, payload)`. An event the op did not declare is refused,
a payload that does not match the declared schema is refused, internal fields are stripped, and
`app.subscribe(sink)` receives what was emitted whichever facet the call arrived on. A plugin sees
the same list as `inv.emitted` in its `after` hook.

The events facet is on unless an app names its facets and leaves it out, which adds an `events` key
to `manifest.facets` and an `events` slot to each op. A manifest reader that walks facet names by
key is unaffected; one that expected exactly five is not.

What this is not: delivery. There is no webhook sender, no SSE stream and no queue producer, and
the in-process sink is not a network transport — a sink that throws fails the invocation, which is
a placeholder for a delivery policy rather than one.
