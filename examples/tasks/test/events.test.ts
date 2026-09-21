import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarness } from '@omniface/testing'
import { build, buildManifest, declaredEvents, eventsOf, type EmittedEvent } from 'omniface'
import { describe, expect, it } from 'vitest'
import { createTasksApp, DEV_KEYS } from '../src/app.ts'

// The gate for 9.1: one declared event reaches the transports with nothing re-declared per
// transport. Every channel here is a different way in — raw HTTP, the generated SDK, the CLI
// engine, an MCP client, a form on a screen — and the app declared `task.created` once, on the op.

describe('a declared event reaches its transports', () => {
  it('arrives the same whichever facet the call came in on', async () => {
    const app = createTasksApp()
    const seen: EmittedEvent[] = []
    app.subscribe((event) => void seen.push(event))
    const h = createHarness(app, { apiKey: DEV_KEYS.admin })

    const outcomes = await h.callAll('tasks.create', { title: 'Write the launch post', priority: 'high' })
    const channels = Object.keys(outcomes)
    for (const [channel, outcome] of Object.entries(outcomes)) expect(outcome.ok, channel).toBe(true)

    // Five ways in, five events, one declaration. Nothing under `facets` says the word
    // "task.created" — the op does, and everything carrying it reads it from there.
    expect(channels).toEqual(['rest', 'sdk', 'cli', 'mcp', 'web'])
    expect(seen.map((e) => e.event)).toEqual(channels.map(() => 'task.created'))
    for (const event of seen) {
      expect(event.op).toBe('tasks.create')
      expect(event.payload).toMatchObject({ title: 'Write the launch post', priority: 'high', done: false })
    }
  })

  it('carries the payload every facet carries, and nothing a facet strips', async () => {
    const app = createTasksApp()
    const seen: EmittedEvent[] = []
    app.subscribe((event) => void seen.push(event))
    const h = createHarness(app, { apiKey: DEV_KEYS.admin })
    await h.call('rest', 'tasks.create', { title: 'A' })

    const payload = seen[0]!.payload as Record<string, unknown>
    // `internalScore` is internal, so it is not in the event for the same reason it is not in a
    // REST response. `shareToken` is sensitive rather than internal: masked where a person reads
    // it, handed over where a machine does, and an event sink is a machine.
    expect(payload).not.toHaveProperty('internalScore')
    expect(payload).toHaveProperty('shareToken')
  })

  it('emits only what the op declared: completing a task is its own event', async () => {
    const app = createTasksApp()
    const seen: EmittedEvent[] = []
    app.subscribe((event) => void seen.push(event))
    const h = createHarness(app, { apiKey: DEV_KEYS.admin })
    await h.call('rest', 'tasks.create', { title: 'A' })
    await h.call('rest', 'tasks.complete', { id: 'task_1' })
    await h.call('rest', 'tasks.get', { id: 'task_1' })
    expect(seen.map((e) => e.event)).toEqual(['task.created', 'task.completed'])
  })

  it('publishes the catalog a transport subscribes against', () => {
    const manifest = buildManifest(createTasksApp())
    expect(declaredEvents(manifest).map((e) => ({ name: e.name, ops: e.ops }))).toEqual([
      { name: 'task.completed', ops: ['tasks.complete'] },
      { name: 'task.created', ops: ['tasks.create'] },
    ])
    const create = manifest.ops.find((o) => o.id === 'tasks.create')!
    expect(eventsOf(create)!.events[0]!.payload.properties).toHaveProperty('shareToken')
  })

  it('says so in llms.txt, because an agent reading the docs is a consumer', async () => {
    const out = mkdtempSync(join(tmpdir(), 'facet-events-'))
    await build(createTasksApp(), out)
    const llms = readFileSync(join(out, 'llms.txt'), 'utf8')
    expect(llms).toContain('- Events: `task.created`')
    // The intro says what the app is reachable as, and an event is not reachable yet. Saying it
    // there would be the kind of sentence that is true of the design and not of the code.
    expect(llms.split('## Operations')[0]).not.toContain('event')
  })
})
