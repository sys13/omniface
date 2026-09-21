# omniface

**Define an app's operations once, in code. Get every interface — REST, SDK, CLI,
MCP, and more — as a *facet* of that one definition. Cross-cutting concerns
(auth, rate limiting, logging, audit…) are plugins, not per-interface rework.**

> Status: early MVP. Core, REST, MCP, the TypeScript SDK, the CLI engine, eight plugins and four
> auth adapters work end to end, with 347 tests — 80 of them generated from an app's definition and
> 50 more generated from the plugins installed in it. The packages build to ESM with type
> declarations and install from a tarball like any npm package; the names are claimed but nothing
> is published yet ([RELEASING.md](docs/RELEASING.md)). See [What's built](#whats-built).

## The problem

An app that wants to be reachable by people, scripts, services, and agents ends up
hand-building the same contract five times: a REST API, an SDK per language, a CLI,
an MCP server, maybe GraphQL or webhooks. Each copy re-implements auth, rate limits,
error shapes, pagination, and logging slightly differently, and they drift.

Existing tools cover slices:

- **Smithy / TypeSpec** — one spec, many emitters, but codegen-only and heavy.
- **Stainless / Speakeasy / Fern** — OpenAPI → SDK/CLI/MCP, but REST-shaped at the core.
- **tRPC / oRPC** — great runtime, one real interface.
- **Better Auth** — the right plugin model, for one concern.

Nobody combines a **protocol-neutral core**, a **runtime**, **per-interface
projections with overrides**, and **Better-Auth-style plugins**.

## The shape

```
Types        fields, once              Standard Schema (Zod, Valibot, ArkType…) + facet traits
Operations   verbs over types          protocol-neutral; not endpoints, not tools
Facets       per-interface views       opt-in; conventions first, typed overrides second
Plugins      cross-cutting concerns    schema + context + hooks + ops + per-facet adapters
```

```ts
import { facet } from 'omniface'
import { apiKeys, logging, rateLimit, scopes } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'

const Task = t.named('Task', z.object({ id: t.id(), title: z.string().min(1), ownerEmail: t(z.email(), { pii: true }) }))

const f = facet({ plugins: [logging(), apiKeys({ keys }), scopes(), rateLimit({ limit: '100/min' })] })

export default f.app({
  name: 'acme',
  ops: {
    tasks: {
      create: f
        .op({ input: Task.pick({ title: true, ownerEmail: true }), output: Task })
        .traits({ scope: 'tasks:write' })
        .handle(({ input, ctx }) => {
          ctx.log('creating task') // typed: contributed by logging()
          return db.tasks.insert(input)
        }),
    },
  },
  facets: {
    rest: true,
    sdk: true,
    cli: { ops: { 'tasks.create': { args: ['title'] } } }, // a typo in the op id fails tsc
    mcp: true,
  },
})
```

## Principles

1. **Everything is code.** No YAML, no separate IDL. The spec is a typed TS value;
   files like `openapi.json` are *outputs*.
2. **Operations, not endpoints.** If REST shapes the core, every other facet inherits REST's shape.
3. **Traits carry intent; facets interpret it.** `idempotent` becomes an HTTP header, an SDK retry key,
   a CLI flag, MCP tool-call `_meta` and an MCP hint — and one replay rule in the pipeline behind
   all of them, written once.
4. **Overrides are rare and typed.** Many overrides on one op is a smell that it wants to be two ops.
5. **Concerns run in the operation pipeline, not the facet.** A new facet can't bypass auth.
6. **Runtime-first.** The server interprets the definition; codegen only for things that run elsewhere
   (SDKs, CLI binary, docs, OpenAPI).
7. **Tiny input, large output** — and every output is proven by generated conformance tests.

## Quickstart

```sh
npm install facet zod @omniface/cli    # @omniface/cli is the engine a generated CLI runs on
```

Put the definition above in `app.ts`, then:

```sh
npx omniface dev app.ts                  # REST :3000, MCP at /mcp, inspector at /_omniface
npx omniface inspect app.ts tasks.create # one op, on every facet
npx omniface build app.ts                # .omniface/: manifest, openapi.json, llms.txt, sdk/, cli/
node .omniface/cli/bin.mjs tasks create "Hello"
npx omniface mcp app.ts                  # MCP over stdio
npx omniface lint app.ts [--fix]         # --fix inserts the t.named() the named-type rules ask for
npx omniface conformance app.ts          # prove every facet still agrees
npx omniface diff .omniface/manifest.json app.ts   # what changed, and which facets it breaks
```

A `.ts` entry needs a runtime that strips types — Node 22.18+, Node 24 or Bun. On Node 20, point the
same commands at compiled JavaScript. The full matrix is in [RUNTIMES.md](docs/RUNTIMES.md).

### From this repo

```sh
pnpm install
pnpm check        # build + typecheck + tests
pnpm smoke        # the quickstart above, from a fresh install of the packed packages

cd examples/tasks
pnpm dev          # omniface dev src/app.ts
TASKS_API_KEY=dev_admin_key node .omniface/cli/bin.mjs tasks create "Hello" --priority high
TASKS_API_KEY=dev_reader_key pnpm exec omniface mcp src/app.ts   # MCP over stdio
```

Example dev keys: `dev_admin_key` (all scopes) and `dev_reader_key` (`tasks:read`).

## Layout

| Path | What |
| --- | --- |
| `packages/omniface` | Core: ops, traits, pipeline, plugins, manifest, REST, OpenAPI, MCP, inspect, lint, build, and the `omniface` dev CLI. Subpaths `omniface/zod`, `omniface/plugins`, `omniface/mcp`. |
| `packages/client` | `@omniface/client`: the runtime the TS SDK and CLI share (auth, retries, idempotency keys, pagination, typed errors), plus `createClient<typeof app>()`. |
| `packages/cli` | `@omniface/cli`: the engine that runs any manifest as a CLI (flags from schema, help, tables or JSON, `--yes`, `--all`, `login`, exit codes). |
| `packages/testing` | `@omniface/testing`: drives one op through REST, SDK, CLI and MCP and checks they agree, and generates the conformance suite from the definition. |
| `examples/tasks` | The example app and the end-to-end tests. |
| `examples/plugin-template` | A plugin with every slot filled, and the conformance test that proves it behaves. |
| `examples/expressibility` | Six real tools — Linear, Stripe, GitHub, S3, Docker, Kubernetes — defined in facet to find where it bends ([EXPRESSIBILITY.md](docs/EXPRESSIBILITY.md)). |

## What's built

- **One definition, four facets.** REST (with OpenAPI 3.1 and `/.well-known/facet.json`), MCP (stdio and
  Streamable HTTP), an inferred TypeScript client, and a CLI shipped as engine + manifest.
- **Conventions first.** `tasks.complete` becomes `POST /tasks/{id}/complete`, `tasks complete <id>`,
  `tasks_complete` and `client.tasks.complete()`. Typed overrides for REST, CLI and MCP; MCP tool groups.
- **Traits.** Op traits set HTTP methods, MCP annotations, CLI confirmations, SDK retries and idempotency keys.
  Field traits (`pii`, `sensitive`, `internal`, `deprecated`) drive redaction, masking and stripping, and survive
  `.pick()`, `.extend()` and `.nullable()`.
- **Plugins in one pipeline.** `logging`, `apiKeys` (contributes `auth.whoami` and `apiKeys.*` ops), `agentTokens`
  (short-lived, scope-narrowed credentials for a browser agent), `auth`,
  `scopes`, `rateLimit` (cost-aware), `idempotency` (server-side replay for the `idempotent` trait), `audit`
  (records the agent behind MCP calls) and `otel` (spans plus RED metrics, tagged by facet). Startup refuses to
  run if ops declare scopes that no plugin enforces.
- **A plugin platform, not just a plugin list.** A plugin reaches a facet through one slot — `adapters` —
  which can find a credential, attribute a caller, add namespaced routes, commands, flags and options, and
  decorate an answer, but is never handed an invocation and so can never decide whether an op runs. The
  authoring guide is [PLUGINS.md](docs/PLUGINS.md), the starting point is
  [`examples/plugin-template`](examples/plugin-template), and `pluginCases()` from `@omniface/testing` runs any
  plugin against a sample app on all four facets.
- **A facet is a module.** A facet declares a projection (given an op, what it does with it), a diff
  contract (given two projections, whether the change breaks *this* facet), a presentation, a
  conformance contract check, and a `serve` hook only if it is served — `sdk` and `cli` have none.
  The five omniface ships are written against that contract, and nothing in the manifest builder,
  `inspect`, `diff`, `build`, the server or `@omniface/testing` names a facet. A test registers a
  throwaway facet and asserts it reaches the manifest, the inspector, `llms.txt`, `omniface diff`
  and the conformance contract check with none of those files edited. What does *not* grow with it
  yet is the conformance suite's live channels, which still drive each protocol from a hand-written
  list — [FACETS.md](docs/FACETS.md) says so in the same words.
- **Auth adapters.** One `AuthAdapter` contract over identity providers, filling the pipeline's `authenticate`
  stage for every facet at once: API keys, JWT (issuer + JWKS, verified with WebCrypto), Better Auth, Clerk and
  WorkOS — no provider SDK and no runtime dependency. Several can run side by side; each declines what is not
  its own. Keys live behind `ApiKeyStore`, with in-memory, file and SQL implementations and a conformance suite
  they all pass.
- **Safe by default over HTTP.** CORS, CSRF and security headers are on before anyone asks: nothing cross-origin
  until an origin is named, no state-changing request from an origin that was not, and `nosniff` / `DENY` /
  `no-referrer` / a closed CSP / HSTS on HTTPS. `facets: { rest: { security: false } }` opts out.
- **Proof.** Tests show all four facets agree on results and on `invalid_input`, `unauthenticated`,
  `forbidden`, `not_found` and `rate_limited`, and that adding `rateLimit()` changes all four at once.
- **Generated conformance.** `conformanceCases(...)` reads the definition and emits the suite: for every
  op, on every facet it reaches, a contract check (projection, bindings, advertised fields, name
  collisions, no internal fields) plus the call-based checks its traits imply — `invalid_input`,
  `anonymous`, `forbidden`, `not_found`, `idempotent`, and value agreement for reads. Adding an op adds
  its cases. `pluginCases(...)` does the same for a plugin, against a sample app on every facet.
  The web facet is included on the same terms: a `presentation` case opens the screen, reads the
  rendered fields out of it, asks the same `presentation.ts` table the renderer renders from what the
  op should show, and diffs both the field set and the values against what REST answered for the same
  call — `sensitive` masked rather than absent, `pii` in the clear as elsewhere, `deprecated` marked.
  Gutting the table and detail renderers fails those cases; it used to pass all of them.
- **Tooling.** `omniface dev | mcp | inspect | build | lint | conformance | diff`, installed as a real `omniface`
  bin, and an inspector web page. `omniface conformance` runs the generated suite from a terminal or
  CI: with no setup at all it runs the checks that read the manifest, and it runs the rest once a
  `conformance.fixtures.ts` beside the entry supplies the credential and the inputs the definition
  cannot know. `omniface diff <before> <after>` compares two manifests and answers "is this breaking?"
  once per facet — a renamed output type breaks the SDK and nothing else, a new `destructive` trait
  breaks CLI scripts and nothing else. `--strict` turns a breaking change into an exit code. The
  example app's CI is `omniface lint && omniface conformance --strict`. `omniface lint --fix` writes the
  `t.named()` the named-type rules ask for, and checks its own edit by re-linting in a fresh
  process — an edit that does not load, or does not resolve the finding it was for, is restored.
- **SDK distribution.** Two TypeScript clients from one runtime. Inside the repo,
  `createClient<typeof app>()` infers its types from the app module, so there is nothing to build
  and nothing to go stale. For everyone else, `omniface build` writes `.omniface/sdk/` — a publishable
  package whose types are generated from the manifest and whose methods are the same proxy over
  the same `@omniface/client`, so there is no generated request code for a hand edit to drift.
  `t.named('Task', …)` becomes one exported `Task`, traits become the JSDoc a consumer reads, and a
  paginated op gets `list()`, `list.iterate()` and `list.autoPaginate()`. The OpenAPI document
  hoists named types into `components.schemas` and carries `x-omniface-*` for outside generators —
  [SDKS.md](docs/SDKS.md).
- **Packaging.** Four published packages, ESM plus declarations, subpath exports, a fresh-install
  smoke run on Node 20/22/24 and Bun in CI, and a release pipeline (changesets → npm with
  provenance → tags). The smoke run installs the tarballs into an empty project, builds the SDK
  package and round-trips a call through it.

### Not yet

- A generated SDK in a second language, proven against the same conformance checks as the
  TypeScript one (backlog 5.4). The OpenAPI document carries what an outside generator needs and
  [`examples/tasks/sdks/`](examples/tasks/sdks/) has starting configurations for four of them, but
  none of them runs in CI, so the agreement is argued rather than demonstrated.
- Per-facet auth *presentation* (backlog 2.6), three surfaces of four. Discovery landed: name an
  authorization server with `oauth: { authorizationServers: [...] }` and the app serves RFC 9728
  protected-resource metadata, and every refusal a credential would have fixed points at it, so an
  agent can find out where to sign in instead of being handed a token out of band. The scopes in
  that document come from the ops' `scope` traits, not a second list. The CLI now keeps what
  `login` accepts in the OS keyring rather than a file (backlog 6.1). Still missing: the SDK
  constructor option, a CLI `login` device flow, and the web facet's sign-in screen.
- CLI shell completions; inspector try-it and live trace (backlog E11 — the playground).
- A web facet: declared ops rendered as screens, and offered to the browser's agent over WebMCP
  (backlog E12). New as of 2026-09-19, and it reverses two recorded decisions — the epic says why.
- Streaming and long-running ops, webhooks, events.
- Nothing is on npm yet: the `omniface` org owns the names, but the first release still has to run.

### Generated conformance

```ts
// examples/tasks/test/generated-conformance.test.ts — nothing here names an op
const cases = conformanceCases({
  app: () => createTasksApp(),
  apiKey: DEV_KEYS.admin,
  unprivileged: { apiKey: DEV_KEYS.reader, scopes: ['tasks:read'] },
  ops: { 'tasks.create': { input: { title: 'Conformance' } } }, // the one thing a schema can't know
})
for (const c of cases) it(c.name, async () => expect((await c.run()).problems).toEqual([]))
```

Ten ops become 42 cases and 136 cross-facet calls. The traits pick the checks: a `scope` means
the op must refuse an anonymous caller on every facet, `public` means it must answer one, a declared
`not_found` plus an id field means every facet renders the miss the same way, `idempotent` means the
same key replays rather than repeats, and `readonly` means the four facets must return the *same
value*, not merely the same shape. Only a valid write input and the data a read expects come from the
author, as `ops[id].input` and `ops[id].setup`.

### Idempotency

`idempotent: true` used to be advertised and never enforced. Now one plugin fills the pipeline's
`idempotency` stage and every facet inherits it:

```ts
const f = facet({ plugins: [/* … */ idempotency({ store: memoryIdempotencyStore() })] })
```

A key is scoped to its op and fingerprinted over the *validated* input, so the same logical call
hashes the same whichever facet it arrived on. Reusing a key with different input is a `conflict`, as
is a second call while the first is in flight. A call that failed leaves no record, so the caller may
retry with the same key — only successes replay. Each facet carries the key its own way: an
`Idempotency-Key` header over REST, one minted per logical call (and reused across retries) by the SDK
and CLI, `tasks --idempotency-key <key>` to pin one across separate CLI runs, and `facet/idempotency-key`
in tool-call `_meta` for MCP.

### Auth adapters

One contract, several providers, one `authenticate` stage that every facet runs:

```ts
import { facet } from 'omniface'
import { apiKeys, auth, scopes } from 'omniface/plugins'
import { betterAuthAdapter, clerkAdapter, jwtAdapter, workosAdapter } from 'omniface/auth'

const keys = apiKeys({ prefix: 'acme_', authenticate: false }) // one provider among several now
const f = facet({
  plugins: [
    auth({
      adapters: [
        keys.adapter,                                            // opaque API keys
        betterAuthAdapter({ auth: betterAuthServer }),           // a session cookie or bearer
        jwtAdapter({ issuer: 'https://issuer.acme.com', audience: 'acme-api' }),
      ],
    }),
    keys,
    scopes(),
  ],
})
```

Each adapter answers with a principal or `null`. `null` means "not mine" and the next adapter gets
a turn — that is how an API key, a browser session and a machine JWT live on one app. A credential
that *is* an adapter's shape and fails verification is rejected there and then, so a forged token
never falls through and lands as anonymous. A credential no adapter claims is `unauthenticated` by
default rather than a silent downgrade.

`clerkAdapter({ issuer })` and `workosAdapter({ clientId })` are the JWT adapter with those
providers' claim names filled in: WebCrypto verifies the signature against the published JWKS,
which is cached, and neither pulls in a provider SDK. Handlers see `ctx.auth` — which adapter
answered, the session it returned, when it expires — and `principal` as always.

### The plugin `adapters` slot

One concern, one plugin, four facets — including the parts of a concern that really are per-facet:

```ts
definePlugin({
  name: 'sessions',
  hooks: { authenticate: verifySession },          // the decision: every facet, once
  adapters: {                                       // the presentation: per facet, never a decision
    rest: {
      credential: (request) => cookieToken(request),
      routes: [{ method: 'POST', path: '/login', handler: login }],  // served at /_sessions/login
      securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'session' } },
    },
    mcp: { instructions: 'Log in first.' },
    cli: { flags: [{ name: 'session', summary: 'A session token', env: 'ACME_SESSION', credential: true }] },
    sdk: { options: [{ name: 'sessionToken', summary: 'A session token', credential: true }] },
  },
})
```

Nothing in `adapters` is handed an `Invocation`, so nothing in it can abort, skip or answer for an
operation — that stays in the pipeline, where it applies to all four facets at once and the
conformance suite can see it. Plugin routes live under `/_<plugin>`, so a plugin cannot shadow an
op's route; a contributed CLI command is an alias for an op, not a side door around one; and a flag
that would shadow a built-in one is a startup error. The CLI and the SDK run in another process, so
what a plugin declares for them travels in the manifest.

### OpenTelemetry

```ts
const f = facet({ plugins: [otel(), /* … */] })
```

One span per invocation and RED metrics — `omniface.op.calls`, `omniface.op.errors`,
`omniface.op.duration` — tagged with the facet, the op, the outcome and the caller, so "the MCP facet
is slow" is a query rather than a hunch. `@opentelemetry/api` is an *optional* peer dependency:
with it installed you get real spans through whatever SDK you configured, without it the plugin
does nothing, and `otel({ api })` skips the dynamic import entirely. A client error is an outcome,
not a broken server, so only a 5xx turns a span red.

### Security defaults

CORS, CSRF and security headers are mounted for every HTTP facet unless the app says otherwise:

```ts
facets: {
  rest: {
    security: { cors: { origin: ['https://app.acme.com'], credentials: true } },
  },
}
```

Out of the box that means: no cross-origin reads until an origin is named, no state-changing
request from an origin that was not named (a request with no `Origin` — curl, the SDK, the CLI —
carries no ambient cookie authority and is allowed), `nosniff`, `DENY`, `no-referrer`, a closed
CSP, and HSTS on HTTPS. An origin trusted by CORS is trusted by CSRF, but `origin: '*'` never is.
`security: false`, or `{ cors: false }` / `{ csrf: false }` / `{ headers: false }`, opts out.

## Docs

| File | What's in it |
| --- | --- |
| [CRITERIA.md](docs/CRITERIA.md) | The lightweight rubric for deciding whether a feature is in |
| [FEATURES.md](docs/FEATURES.md) | Feature backlog with first-pass verdicts (want / maybe / later / no) |
| [BACKLOG.md](docs/BACKLOG.md) | The work list: everything unbuilt, grouped into ten ordered epics |
| [DX.md](docs/DX.md) | Developer experience — what's common, what differs per facet |
| [SCHEMA.md](docs/SCHEMA.md) | Standard Schema as the base, facet's layer on top, all in code |
| [API.md](docs/API.md) | The public API surface, package by package, and what's deliberately internal |
| [SDKS.md](docs/SDKS.md) | The inferred client, the generated package, and the `x-omniface-*` an outside generator reads |
| [PLUGINS.md](docs/PLUGINS.md) | Writing a plugin: the slots, the per-facet `adapters` rules, the conformance kit |
| [RUNTIMES.md](docs/RUNTIMES.md) | Which Node versions and which other runtimes are supported, and what CI proves |
| [RELEASING.md](docs/RELEASING.md) | Changesets, the version PR, npm publishing with provenance, release tags |
| [EXPRESSIBILITY.md](docs/EXPRESSIBILITY.md) | Six real tools defined in facet — what fit, what bent, and where the boundary actually sits |

## Relationship to maxstack

Intentionally separate. maxstack is a whole-app platform; facet is the interface layer.
Ideas worth borrowing: bundle contracts (prerequisites, idempotent install, ownership
footprint), `OpActor.surface` attribution, and "a declaration means one thing everywhere".
facet could plausibly become a layer maxstack sits on — not a goal yet.

The boundary moved once, on 2026-09-19, and it is worth being precise about where it now sits.
facet is building a web facet (backlog E12): declared operations rendered as screens. That is a
projection of ops, the same as the REST routes and the CLI commands — not an application. facet
does not generate a data model, a page that is not an op, or anything you extend by writing
components inside it; the epic carries the fence, and the test is that there is no supported way
to add a screen facet did not derive. A console is the lightest possible read of what a web
interface to an app can be, and that is deliberate: everything past it is maxstack's.
