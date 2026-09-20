/**
 * Study subject: GitHub's issues/pulls surface.
 *
 * Why this one: every resource is identified by a *composite* — `owner/repo`, then a number that
 * is only unique inside the repo. facet's conventions assume a single flat `id`. This is the test
 * of what happens when the resource model is nested.
 */
import { errors, facet, paginate } from 'omniface'
import { apiKeys, logging, rateLimit, scopes } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'

const User = t.named(
  'User',
  z.object({
    login: t.id({ example: 'octocat' }),
    name: z.string().nullable(),
    email: t(z.email(), { pii: true }).nullable(),
  }),
)
type User = z.infer<typeof User>

const Repo = t.named(
  'Repo',
  z.object({
    owner: t.id({ example: 'octocat' }),
    repo: t.id({ example: 'hello-world' }),
    description: z.string().nullable(),
    private: z.boolean(),
    stars: z.number().int(),
    createdAt: t.datetime(),
  }),
)
type Repo = z.infer<typeof Repo>

const Issue = t.named(
  'Issue',
  z.object({
    owner: t.id(),
    repo: t.id(),
    number: t(z.number().int().positive(), { example: 42 }),
    title: z.string().min(1),
    body: z.string().nullable(),
    state: z.enum(['open', 'closed']),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    authorLogin: t.id(),
    createdAt: t.datetime(),
  }),
)
type Issue = z.infer<typeof Issue>

const Comment = t.named(
  'Comment',
  z.object({
    id: t.id(),
    owner: t.id(),
    repo: t.id(),
    issueNumber: z.number().int().positive(),
    body: z.string().min(1),
    authorLogin: t.id(),
    createdAt: t.datetime(),
  }),
)
type Comment = z.infer<typeof Comment>

/**
 * FRICTION 1 — composite identity.
 *
 * `conventionalRest` puts `{id}` in the path only when the input has an `id` property, so every op
 * below needs an explicit `rest.path`. Nothing is unexpressible; it is the override budget that
 * suffers. With 12 ops and 12 path overrides, `omniface lint` will (correctly, by its own rule) call
 * this app out — see docs/EXPRESSIBILITY.md.
 */
const RepoRef = t.named('RepoRef', z.object({ owner: t.id(), repo: t.id() }))
const IssueRef = t.named('IssueRef', RepoRef.extend({ number: z.number().int().positive() }))

export function createGithubApp() {
  const f = facet({
    plugins: [
      logging(),
      apiKeys({
        prefix: 'ghp_',
        keys: [
          { key: 'ghp_admin', principalId: 'octocat', scopes: ['*'] },
          { key: 'ghp_reader', principalId: 'reader', scopes: ['repo:read'] },
        ],
      }),
      scopes(),
      // GitHub's real limit is 5000/hour per token, plus a separate, much lower search budget.
      // The `cost` trait below is how the second budget is expressed here.
      rateLimit({ limit: '5000/hour' }),
    ],
  })

  const users = new Map<string, User>([['octocat', { login: 'octocat', name: 'The Octocat', email: 'octo@github.test' }]])
  const repos = new Map<string, Repo>()
  const issues = new Map<string, Issue>()
  const comments = new Map<string, Comment>()
  let issueSeq = 0
  let commentSeq = 0

  const repoKey = (owner: string, repo: string) => `${owner}/${repo}`
  const issueKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`

  const findRepo = (owner: string, repo: string) => {
    const found = repos.get(repoKey(owner, repo))
    if (!found) throw errors.notFound(`No repository "${owner}/${repo}"`)
    return found
  }
  const findIssue = (owner: string, repo: string, number: number) => {
    const found = issues.get(issueKey(owner, repo, number))
    if (!found) throw errors.notFound(`No issue ${owner}/${repo}#${number}`)
    return found
  }

  const ops = {
    users: {
      get: f
        .op({ description: 'Get a user by login', input: z.object({ login: t.id() }), output: User, errors: ['not_found'] })
        .traits({ readonly: true, public: true })
        .handle(({ input }) => {
          const user = users.get(input.login)
          if (!user) throw errors.notFound(`No user "${input.login}"`)
          return user
        }),
    },

    repos: {
      create: f
        .op({
          description: 'Create a repository',
          input: Repo.pick({ owner: true, repo: true, description: true, private: true }).partial({ description: true, private: true }),
          output: Repo,
          errors: ['conflict'],
        })
        .traits({ scope: 'repo:write' })
        .handle(({ input }) => {
          if (repos.has(repoKey(input.owner, input.repo))) throw errors.conflict(`"${input.owner}/${input.repo}" already exists`)
          const created: Repo = {
            owner: input.owner,
            repo: input.repo,
            description: input.description ?? null,
            private: input.private ?? false,
            stars: 0,
            createdAt: new Date().toISOString(),
          }
          repos.set(repoKey(created.owner, created.repo), created)
          return created
        }),

      get: f
        .op({ description: 'Get a repository', input: RepoRef, output: Repo, errors: ['not_found'] })
        .traits({ readonly: true, scope: 'repo:read' })
        .handle(({ input }) => findRepo(input.owner, input.repo)),

      list: f
        .op({
          description: 'List an owner’s repositories',
          input: t.pageInput({ owner: t.id() }),
          output: t.page(Repo),
        })
        .traits({ readonly: true, paginated: true, scope: 'repo:read' })
        .handle(({ input }) => paginate([...repos.values()].filter((r) => r.owner === input.owner), input)),

      delete: f
        .op({
          description: 'Delete a repository permanently',
          input: RepoRef,
          output: z.object({ owner: z.string(), repo: z.string(), deleted: z.literal(true) }),
          errors: ['not_found'],
        })
        .traits({ destructive: true, scope: 'repo:admin' })
        .handle(({ input }) => {
          findRepo(input.owner, input.repo)
          repos.delete(repoKey(input.owner, input.repo))
          return { owner: input.owner, repo: input.repo, deleted: true as const }
        }),

      issues: {
        create: f
          .op({
            description: 'Open an issue',
            input: RepoRef.extend(Issue.pick({ title: true, body: true, labels: true, assignees: true }).partial({ body: true, labels: true, assignees: true }).shape),
            output: Issue,
            errors: ['not_found'],
          })
          .traits({ scope: 'issues:write' })
          .handle(({ input, principal }) => {
            findRepo(input.owner, input.repo)
            const issue: Issue = {
              owner: input.owner,
              repo: input.repo,
              number: ++issueSeq,
              title: input.title,
              body: input.body ?? null,
              state: 'open',
              labels: input.labels ?? [],
              assignees: input.assignees ?? [],
              authorLogin: String(principal.id ?? 'anonymous'),
              createdAt: new Date().toISOString(),
            }
            issues.set(issueKey(issue.owner, issue.repo, issue.number), issue)
            return issue
          }),

        list: f
          .op({
            description: 'List issues in a repository',
            input: t.pageInput({ owner: t.id(), repo: t.id(), state: z.enum(['open', 'closed', 'all']).optional() }),
            output: t.page(Issue),
          })
          .traits({ readonly: true, paginated: true, scope: 'issues:read' })
          .handle(({ input }) => {
            const state = input.state ?? 'open'
            const all = [...issues.values()].filter(
              (i) => i.owner === input.owner && i.repo === input.repo && (state === 'all' || i.state === state),
            )
            return paginate(all, input)
          }),

        get: f
          .op({ description: 'Get one issue', input: IssueRef, output: Issue, errors: ['not_found'] })
          .traits({ readonly: true, scope: 'issues:read' })
          .handle(({ input }) => findIssue(input.owner, input.repo, input.number)),

        update: f
          .op({
            description: 'Edit an issue',
            input: IssueRef.extend(Issue.pick({ title: true, body: true, state: true, labels: true }).partial().shape),
            output: Issue,
            errors: ['not_found'],
          })
          .traits({ idempotent: true, scope: 'issues:write' })
          .handle(({ input }) => {
            const { owner, repo, number, ...changes } = input
            const next = {
              ...findIssue(owner, repo, number),
              ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
            }
            issues.set(issueKey(owner, repo, number), next)
            return next
          }),

        close: f
          .op({ description: 'Close an issue', input: IssueRef, output: Issue, errors: ['not_found'] })
          .traits({ idempotent: true, scope: 'issues:write' })
          .handle(({ input }) => {
            const next: Issue = { ...findIssue(input.owner, input.repo, input.number), state: 'closed' }
            issues.set(issueKey(next.owner, next.repo, next.number), next)
            return next
          }),

        comment: f
          .op({
            description: 'Comment on an issue',
            input: IssueRef.extend({ body: z.string().min(1) }),
            output: Comment,
            errors: ['not_found'],
          })
          .traits({ scope: 'issues:write' })
          .handle(({ input, principal }) => {
            findIssue(input.owner, input.repo, input.number)
            const comment: Comment = {
              id: `comment_${++commentSeq}`,
              owner: input.owner,
              repo: input.repo,
              issueNumber: input.number,
              body: input.body,
              authorLogin: String(principal.id ?? 'anonymous'),
              createdAt: new Date().toISOString(),
            }
            comments.set(comment.id, comment)
            return comment
          }),
      },
    },

    /**
     * FRICTION 2 — a verb that is not a resource.
     *
     * `search.issues` reads as "the issues member of search", so the convention gives it
     * `GET /search/issues`, which is exactly GitHub's real route. The op-shaped core handles a
     * non-CRUD verb better than a REST-shaped one would; `cost` expresses the separate budget.
     */
    search: {
      issues: f
        .op({
          description: 'Search issues with a GitHub query string',
          input: t.pageInput({ q: t(z.string().min(1), { example: 'is:open label:bug' }) }),
          output: t.page(Issue),
        })
        .traits({ readonly: true, paginated: true, scope: 'issues:read', cost: 30 })
        .handle(({ input }) => {
          const needle = input.q.toLowerCase()
          return paginate([...issues.values()].filter((i) => i.title.toLowerCase().includes(needle)), input)
        }),
    },
  }

  return f.app({
    name: 'github',
    version: '0.1.0',
    description: 'A slice of GitHub — repositories, issues and search — defined once',
    ops,
    facets: {
      rest: {
        // Every one of these restates a path the convention cannot derive, because identity here
        // is a tuple rather than an `id`. This is the single largest source of friction found.
        ops: {
          'users.get': { path: '/users/{login}' },
          'repos.get': { path: '/repos/{owner}/{repo}' },
          'repos.list': { path: '/users/{owner}/repos' },
          'repos.delete': { path: '/repos/{owner}/{repo}' },
          'repos.issues.create': { path: '/repos/{owner}/{repo}/issues' },
          'repos.issues.list': { path: '/repos/{owner}/{repo}/issues' },
          'repos.issues.get': { path: '/repos/{owner}/{repo}/issues/{number}' },
          'repos.issues.update': { path: '/repos/{owner}/{repo}/issues/{number}' },
          'repos.issues.close': { path: '/repos/{owner}/{repo}/issues/{number}/close' },
          'repos.issues.comment': { path: '/repos/{owner}/{repo}/issues/{number}/comments' },
        },
      },
      sdk: true,
      cli: {
        binName: 'gh',
        ops: {
          'repos.issues.create': { args: ['owner', 'repo', 'title'] },
          'repos.issues.list': { columns: ['number', 'title', 'state', 'authorLogin'] },
          'repos.issues.get': { args: ['owner', 'repo', 'number'] },
        },
      },
      mcp: {
        // FRICTION 3 — tool budget. Twelve ops is already most of the 15-tool budget for one
        // service; grouping is the escape hatch and it works, but it is manual.
        tools: {
          repo_admin: { description: 'Create, inspect and delete repositories', ops: ['repos.create', 'repos.get', 'repos.list', 'repos.delete'] },
        },
      },
    },
  })
}

const app = createGithubApp()
export default app
