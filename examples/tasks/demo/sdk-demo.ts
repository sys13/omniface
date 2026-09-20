import { createClient, FacetClientError } from '@omniface/client'
import type { TasksApp } from '../src/app.ts'

const baseUrl = process.env.TASKS_BASE_URL ?? 'http://localhost:3000'

// One type parameter, no codegen. Every method, argument and return
// type below is inferred straight from the app definition.
const client = createClient<TasksApp>({ baseUrl, apiKey: 'dev_admin_key' })

const task = await client.tasks.create({ title: 'Ship it', priority: 'high' })
console.log(`created    ${task.id} · ${task.title} · ${task.priority}`)

const page = await client.tasks.list({ limit: 3 })
console.log(`listed     ${page.items.length} · next = ${page.nextCursor}`)

const done = await client.tasks.complete({ id: task.id })
console.log(`completed  ${done.id} · done = ${done.done}`)

// Errors arrive typed, carrying the code the server sent —
// the same code REST, the CLI and MCP all see.
const reader = createClient<TasksApp>({ baseUrl, apiKey: 'dev_reader_key' })
try {
  await reader.tasks.create({ title: 'readers may not write' })
} catch (err) {
  if (err instanceof FacetClientError) {
    console.log(`denied     ${err.code} ${err.status} · ${err.message}`)
  }
}
