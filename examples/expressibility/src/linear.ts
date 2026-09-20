/**
 * Study subject: a Linear-style issue tracker — the control.
 *
 * Why this one: the study needs a subject that facet was obviously designed for, so that the
 * friction the other five report can be read as something other than "modelling any real tool is
 * hard". This is a conventional SaaS API — flat ids, CRUD plus a few verbs, cursor pagination,
 * scoped tokens — and it should cost nothing.
 *
 * Result: eleven ops, zero per-op overrides on any facet, zero lint findings. The whole file is
 * types and handlers. That is the shape of the claim facet makes, and on this subject it holds.
 */
import { errors, facet, paginate } from 'omniface'
import { apiKeys, audit, idempotency, logging, rateLimit, scopes } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'

const User = t.named(
  'User',
  z.object({
    id: t.id({ example: 'usr_1' }),
    name: z.string(),
    email: t(z.email(), { pii: true }),
  }),
)
type User = z.infer<typeof User>

const Team = t.named(
  'Team',
  z.object({
    id: t.id({ example: 'team_1' }),
    key: t(z.string().min(1).max(5), { example: 'ENG' }),
    name: z.string().min(1),
  }),
)
type Team = z.infer<typeof Team>

const Issue = t.named(
  'Issue',
  z.object({
    id: t.id({ example: 'iss_1' }),
    teamId: t.id(),
    title: z.string().min(1).max(255),
    description: z.string().nullable(),
    state: z.enum(['backlog', 'todo', 'in_progress', 'done', 'canceled']),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
    assigneeId: t.id().nullable(),
    estimate: z.number().int().min(0).max(21).nullable(),
    createdAt: t.datetime(),
  }),
)
type Issue = z.infer<typeof Issue>

const IssueId = t.named('IssueId', z.object({ id: t.id() }))

const Comment = t.named(
  'Comment',
  z.object({
    id: t.id({ example: 'cmt_1' }),
    issueId: t.id(),
    authorId: t.id(),
    body: z.string().min(1),
    createdAt: t.datetime(),
  }),
)
type Comment = z.infer<typeof Comment>

export const DEV_KEYS = { admin: 'lin_admin_key', reader: 'lin_reader_key' } as const

export function createTrackerApp() {
  const f = facet({
    plugins: [
      logging(),
      apiKeys({
        prefix: 'lin_',
        keys: [
          { key: DEV_KEYS.admin, principalId: 'usr_admin', scopes: ['*'] },
          { key: DEV_KEYS.reader, principalId: 'usr_reader', scopes: ['issues:read'] },
        ],
      }),
      scopes(),
      rateLimit({ limit: '1000/min' }),
      idempotency(),
      audit({ sink: () => {} }),
    ],
  })

  const users = new Map<string, User>([['usr_admin', { id: 'usr_admin', name: 'Admin', email: 'admin@tracker.test' }]])
  const teams = new Map<string, Team>()
  const issues = new Map<string, Issue>()
  const comments = new Map<string, Comment>()
  let seq = 0
  const nextId = (prefix: string) => `${prefix}_${++seq}`

  const findIssue = (id: string) => {
    const found = issues.get(id)
    if (!found) throw errors.notFound(`No issue "${id}"`)
    return found
  }

  const ops = {
    teams: {
      create: f
        .op({ description: 'Create a team', input: Team.pick({ key: true, name: true }), output: Team })
        .traits({ scope: 'teams:write' })
        .handle(({ input }) => {
          const team: Team = { id: nextId('team'), key: input.key, name: input.name }
          teams.set(team.id, team)
          return team
        }),

      list: f
        .op({ description: 'List teams', input: t.pageInput(), output: t.page(Team) })
        .traits({ readonly: true, paginated: true, scope: 'teams:read' })
        .handle(({ input }) => paginate([...teams.values()], input)),
    },

    users: {
      list: f
        .op({ description: 'List users', input: t.pageInput(), output: t.page(User) })
        .traits({ readonly: true, paginated: true, scope: 'users:read' })
        .handle(({ input }) => paginate([...users.values()], input)),

      get: f
        .op({ description: 'Get a user', input: z.object({ id: t.id() }), output: User, errors: ['not_found'] })
        .traits({ readonly: true, scope: 'users:read' })
        .handle(({ input }) => {
          const user = users.get(input.id)
          if (!user) throw errors.notFound(`No user "${input.id}"`)
          return user
        }),
    },

    issues: {
      create: f
        .op({
          description: 'Create an issue',
          input: Issue.pick({ teamId: true, title: true, description: true, priority: true, assigneeId: true, estimate: true }).partial({
            description: true,
            priority: true,
            assigneeId: true,
            estimate: true,
          }),
          output: Issue,
          errors: ['not_found'],
        })
        .traits({ idempotent: true, scope: 'issues:write' })
        .handle(({ input, ctx }) => {
          if (!teams.has(input.teamId)) throw errors.notFound(`No team "${input.teamId}"`)
          const issue: Issue = {
            id: nextId('iss'),
            teamId: input.teamId,
            title: input.title,
            description: input.description ?? null,
            state: 'backlog',
            priority: input.priority ?? 'none',
            assigneeId: input.assigneeId ?? null,
            estimate: input.estimate ?? null,
            createdAt: new Date().toISOString(),
          }
          issues.set(issue.id, issue)
          ctx.log('issue created', { issueId: issue.id })
          return issue
        }),

      list: f
        .op({
          description: 'List issues, newest first',
          input: t.pageInput({
            teamId: t.id().optional(),
            state: z.enum(['backlog', 'todo', 'in_progress', 'done', 'canceled']).optional(),
            assigneeId: t.id().optional(),
          }),
          output: t.page(Issue),
        })
        .traits({ readonly: true, paginated: true, scope: 'issues:read' })
        .handle(({ input }) => {
          const all = [...issues.values()]
            .reverse()
            .filter((i) => (!input.teamId || i.teamId === input.teamId) && (!input.state || i.state === input.state) && (!input.assigneeId || i.assigneeId === input.assigneeId))
          return paginate(all, input)
        }),

      get: f
        .op({ description: 'Get one issue', input: IssueId, output: Issue, errors: ['not_found'] })
        .traits({ readonly: true, scope: 'issues:read' })
        .handle(({ input }) => findIssue(input.id)),

      update: f
        .op({
          description: 'Change an issue’s fields',
          input: IssueId.extend(Issue.pick({ title: true, description: true, state: true, priority: true, assigneeId: true, estimate: true }).partial().shape),
          output: Issue,
          errors: ['not_found'],
        })
        .traits({ idempotent: true, scope: 'issues:write' })
        .handle(({ input }) => {
          const { id, ...changes } = input
          const next = { ...findIssue(id), ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) }
          issues.set(id, next)
          return next
        }),

      assign: f
        .op({
          description: 'Assign an issue to someone',
          input: IssueId.extend({ assigneeId: t.id().nullable() }),
          output: Issue,
          errors: ['not_found'],
        })
        .traits({ idempotent: true, scope: 'issues:write' })
        .handle(({ input }) => {
          if (input.assigneeId && !users.has(input.assigneeId)) throw errors.notFound(`No user "${input.assigneeId}"`)
          const next: Issue = { ...findIssue(input.id), assigneeId: input.assigneeId }
          issues.set(next.id, next)
          return next
        }),

      comment: f
        .op({
          description: 'Comment on an issue',
          input: IssueId.extend({ body: z.string().min(1) }),
          output: Comment,
          errors: ['not_found'],
        })
        .traits({ scope: 'issues:write' })
        .handle(({ input, principal }) => {
          findIssue(input.id)
          const comment: Comment = {
            id: nextId('cmt'),
            issueId: input.id,
            authorId: String(principal.id ?? 'anonymous'),
            body: input.body,
            createdAt: new Date().toISOString(),
          }
          comments.set(comment.id, comment)
          return comment
        }),

      delete: f
        .op({
          description: 'Delete an issue permanently',
          input: IssueId,
          output: z.object({ id: z.string(), deleted: z.literal(true) }),
          errors: ['not_found'],
        })
        .traits({ destructive: true, scope: 'issues:write' })
        .handle(({ input }) => {
          findIssue(input.id)
          issues.delete(input.id)
          return { id: input.id, deleted: true as const }
        }),
    },
  }

  return f.app({
    name: 'tracker',
    version: '0.1.0',
    description: 'A Linear-style issue tracker — the control subject for the expressibility study',
    ops,
    // Nothing per-op anywhere. The conventions give `POST /issues`, `GET /issues/{id}`,
    // `POST /issues/{id}/assign`, `tracker issues assign <id>`, `issues_assign` and
    // `client.issues.assign()` without a line of configuration.
    facets: { rest: true, sdk: true, cli: { binName: 'tracker' }, mcp: true },
  })
}

const app = createTrackerApp()
export default app
