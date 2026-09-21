import { defineEvent, errors, facet, paginate, type AuthAdapter } from 'omniface'
import {
  agentTokens,
  apiKeys,
  audit,
  auth,
  idempotency,
  logging,
  rateLimit,
  scopes,
  type AuditEntry,
  type LogLine,
  type RateSpec,
} from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'

// ---------------------------------------------------------------------------------------------
// Types, once

const Task = t.named(
  'Task',
  z.object({
    id: t.id({ example: 'task_1' }),
    title: t(z.string().min(1).max(200), { example: 'Write the launch post' }),
    done: z.boolean(),
    priority: z.enum(['low', 'normal', 'high']),
    assigneeEmail: t(z.email(), { pii: true, description: 'Who the task is assigned to' }).nullable(),
    internalScore: t(z.number(), { internal: true }),
    // A secret: anyone holding the link can open the task. Person-facing facets mask it — the CLI
    // in its tables, the web console behind a deliberate reveal — and the machine-facing ones hand
    // it over, because a caller that asked for the task asked for its link.
    shareToken: t(z.string(), { sensitive: true, description: 'Secret share link token' }),
    createdAt: t.datetime(),
  }),
)
type Task = z.infer<typeof Task>

const TaskId = t.named('TaskId', z.object({ id: t.id({ example: 'task_1' }) }))

// ---------------------------------------------------------------------------------------------
// Events, once
//
// Declared here and nowhere else. A webhook sender, an SSE stream and a queue producer each read
// this; none of them is told again what the event is called or what it carries. `internalScore` is
// stripped from the payload for the same reason it is stripped from every facet's output.

export const TaskCreated = defineEvent({
  name: 'task.created',
  payload: Task,
  description: 'A task was created',
})

export const TaskCompleted = defineEvent({
  name: 'task.completed',
  payload: Task,
  description: 'A task was marked done',
})

// ---------------------------------------------------------------------------------------------
// The app

export type TasksAppOptions = {
  limit?: RateSpec
  logSink?: (line: LogLine) => void
  auditSink?: (entry: AuditEntry) => void
  /**
   * Identity providers alongside the dev API keys. With any of these installed the API keys stop
   * authenticating on their own and join the list as one adapter among several, so an unknown
   * token can fall through to the next provider instead of being rejected by the first.
   */
  authAdapters?: readonly AuthAdapter[]
}

export const DEV_KEYS = { admin: 'dev_admin_key', reader: 'dev_reader_key' } as const

export function createTasksApp(options: TasksAppOptions = {}) {
  const adapters = options.authAdapters ?? []
  const keys = apiKeys({
    prefix: 'tasks_',
    keys: [
      { key: DEV_KEYS.admin, principalId: 'user_admin', scopes: ['*'] },
      { key: DEV_KEYS.reader, principalId: 'user_reader', scopes: ['tasks:read'] },
    ],
    // Two providers now — keys and the browser agent's short-lived tokens — so neither
    // authenticates on its own: `auth()` tries them in order, which is what lets an unrecognised
    // bearer fall through to the next one instead of being rejected by the first.
    authenticate: false,
  })
  // The browser agent's credential: five minutes, and never more than the reads. The page mints
  // one and carries it, so the agent holds strictly less than the person whose tab it is in
  // (docs/BACKLOG.md 12.8) rather than inheriting the whole session.
  const agent = agentTokens({ ttlSeconds: 300, ceiling: ['tasks:read'], authenticate: false })
  const f = facet({
    plugins: [
      logging({ sink: options.logSink }),
      auth({ adapters: [keys.adapter, agent.adapter, ...adapters] }),
      keys,
      agent,
      scopes(),
      rateLimit({ limit: options.limit ?? '100/min' }),
      idempotency(),
      audit({ sink: options.auditSink ?? (() => {}) }),
    ],
  })

  const tasks = new Map<string, Task>()
  let seq = 0
  let shareSeq = 0
  const find = (id: string) => {
    const task = tasks.get(id)
    if (!task) throw errors.notFound(`No task "${id}"`)
    return task
  }

  const ops = {
    tasks: {
      create: f
        .op({
          description: 'Create a task',
          input: Task.pick({ title: true, priority: true, assigneeEmail: true }).partial({ priority: true, assigneeEmail: true }),
          output: Task,
        })
        .traits({ scope: 'tasks:write' })
        .emits(TaskCreated)
        .handle(({ input, ctx, emit }) => {
          const task: Task = {
            id: `task_${++seq}`,
            title: input.title,
            done: false,
            priority: input.priority ?? 'normal',
            assigneeEmail: input.assigneeEmail ?? null,
            internalScore: Math.random(),
            shareToken: `share_${(++shareSeq).toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
          }
          tasks.set(task.id, task)
          ctx.log('task created', { taskId: task.id })
          emit(TaskCreated, task)
          return task
        }),

      list: f
        .op({
          description: 'List tasks, newest first',
          input: t.pageInput({ done: z.boolean().optional() }),
          output: t.page(Task),
        })
        .traits({ readonly: true, paginated: true, scope: 'tasks:read' })
        .handle(({ input }) => {
          const all = [...tasks.values()].reverse().filter((task) => input.done === undefined || task.done === input.done)
          return paginate(all, input)
        }),

      get: f
        .op({ description: 'Get one task', input: TaskId, output: Task, errors: ['not_found'] })
        .traits({ readonly: true, scope: 'tasks:read' })
        .handle(({ input }) => find(input.id)),

      update: f
        .op({
          description: 'Change a task’s title, priority or assignee',
          input: TaskId.extend(Task.pick({ title: true, priority: true, assigneeEmail: true }).partial().shape),
          output: Task,
          errors: ['not_found'],
        })
        .traits({ idempotent: true, scope: 'tasks:write' })
        .handle(({ input }) => {
          const { id, ...changes } = input
          const task = { ...find(id), ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) }
          tasks.set(id, task)
          return task
        }),

      complete: f
        .op({ description: 'Mark a task done', input: TaskId, output: Task, errors: ['not_found'] })
        .traits({ idempotent: true, scope: 'tasks:write' })
        .emits(TaskCompleted)
        .handle(({ input, emit }) => {
          const task = { ...find(input.id), done: true }
          tasks.set(task.id, task)
          emit(TaskCompleted, task)
          return task
        }),

      delete: f
        .op({
          description: 'Delete a task permanently',
          input: TaskId,
          output: z.object({ id: z.string(), deleted: z.literal(true) }),
          errors: ['not_found'],
        })
        .traits({ destructive: true, scope: 'tasks:write' })
        .handle(({ input }) => {
          find(input.id)
          tasks.delete(input.id)
          return { id: input.id, deleted: true as const }
        }),
    },
  }

  return f.app({
    name: 'tasks',
    version: '0.1.0',
    description: 'A tiny task tracker, defined once and served on every facet',
    ops,
    facets: {
      rest: true,
      sdk: true,
      events: true,
      cli: {
        binName: 'tasks',
        ops: {
          'tasks.create': { args: ['title'] },
          'tasks.list': { columns: ['id', 'title', 'done', 'priority'] },
        },
      },
      mcp: {
        ops: {
          'tasks.list': { maxItems: 10, description: 'Find tasks, newest first. Filter with done. Returns 10 per call.' },
        },
      },
      web: {
        path: '/app',
        // The agent in the visitor's browser gets the reads, and nothing else: the credential it
        // carries today is the person's own session, so a write is the part worth refusing until
        // the attenuated token of BACKLOG 12.8 exists. The same declaration is what the page
        // registers and what the pipeline enforces.
        agent: { allow: 'readonly', credential: 'attenuated' },
        ops: {
          'tasks.list': { fields: ['title', 'done', 'priority', 'assigneeEmail'], labels: { assigneeEmail: 'Assignee' }, order: 1 },
          'tasks.create': { title: 'New task', order: 2, then: 'tasks.get' },
          'tasks.delete': { confirm: 'Delete this task? It does not come back.' },
        },
      },
    },
    // Where a caller with no credential goes to get one. The app names somebody else's
    // authorization server; omniface never becomes one. The scopes are not repeated here — they
    // are derived from the `scope` traits the ops already declare, so the document cannot drift
    // from what is actually enforced.
    oauth: { authorizationServers: ['https://auth.example.com'] },
  })
}

const app = createTasksApp()
export default app
export type TasksApp = typeof app
