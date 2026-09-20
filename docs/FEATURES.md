# Features

First-pass verdicts using [CRITERIA.md](CRITERIA.md). Scores are `L C D T B E`
(Leverage, Core-thesis, Drift, Tax⁻¹, Build-cost⁻¹, Escape-hatch), each 0–2.

**★ = MVP.** The MVP proves both halves of the thesis: one definition → REST + TS SDK +
CLI + MCP, and adding a plugin changes all four at once.

Build status is noted in bold at the start of **Why** (see the README for what's built).

Your pass: change the **Verdict** column where you disagree and leave a note in **Why**.

## Core definition

| Feature | L C D T B E | Score | Verdict | Why |
| --- | --- | --- | --- | --- |
| ★ Operations: `op({ input, output }).handle()` with Standard Schema | 2 2 2 1 2 2 | 11 | want | **Built.** The unit everything else hangs off. |
| ★ Naming conventions per facet (camel / snake / kebab, path & command derivation) | 2 2 1 2 2 2 | 11 | want | **Built.** Where "tiny input, huge output" actually comes from. |
| ★ Conformance test generation (every op × every facet) | 2 2 2 2 1 2 | 11 | want | **Built: `conformanceCases()` derives contract, `invalid_input`, `anonymous`, `forbidden`, `not_found` and read-agreement cases for every op from its traits and schema; only write inputs and read fixtures are hand-supplied. No CLI command yet.** The proof that facets behave identically. |
| ★ Op traits: `readonly`, `destructive`, `idempotent`, `paginated`, `scope`, `cost` | 2 2 2 1 1 2 | 10 | want | **Built (plus `public`, `internal`).** Intent declared once, interpreted per facet. |
| ★ Field traits: `pii`, `internal`, `sensitive`, `deprecated` | 2 1 2 1 2 2 | 10 | want | **Built.** Drives redaction, visibility, docs, MCP hiding. Storage decided in SCHEMA.md. |
| ★ `omniface/zod` adapter (scalars, JSON Schema, wrapper lookup, metadata copying) | 2 2 1 2 1 2 | 10 | want | **Built.** The first per-library adapter; everything schema-related goes through it. |
| `omniface/valibot`, `omniface/arktype` adapters | 1 0 1 2 1 2 | 7 | maybe | When a user asks; each is about one small file. |
| Named-type lint (warn on shared unnamed, error on recursive unnamed, `--fix`) | 2 1 2 2 2 2 | 11 | want | **Built.** `omniface lint --fix` inserts `t.named()`, preferring the `const`'s own name, and restores the file if its edit does not check out. |
| Unused-trait lint (trait set on a schema the definition never uses) | 1 0 2 2 2 2 | 9 | want | **Built** (opt-in; `omniface lint` turns it on). Catches a `pii` or `internal` declaration that outlived the field it protected. Schema methods turned out *not* to drop traits — see BACKLOG E4. |
| ★ Namespaces / op groups (`tasks.create`) | 2 1 1 2 2 2 | 10 | want | **Built.** Maps to REST paths, SDK objects, CLI subcommands, MCP prefixes. |
| Breaking-change diff reported per facet | 2 1 2 2 1 2 | 10 | want | **Built.** `omniface diff <before> <after>`: every change tagged with the facets it breaks. |
| ★ Typed per-facet overrides (naming, shape, binding, behavior) | 1 2 1 1 2 2 | 9 | want | **Built; unknown op ids fail `tsc` and startup.** Required by the thesis; kept to four kinds. |
| ★ Unified typed error model (`NotFound`, `Forbidden`, `RateLimited`…) | 2 2 2 1 1 1 | 9 | want | **Built.** Each facet renders errors its own way from one source. |
| ★ Pagination primitive | 2 1 2 1 1 2 | 9 | want | **Built (`t.pageInput`, `t.page`, `paginate`).** The most common thing facets get subtly different. |
| Declared events (`op.emits(TaskCreated)`) | 2 1 2 1 1 2 | 9 | want | One source for webhooks, SSE, and queues later. |
| Streaming ops (`stream: Event`) | 2 1 1 1 0 2 | 7 | maybe | Needed for LLM-ish apps; semantics differ a lot per facet. |
| Long-running ops (`async: true` → job handle) | 2 1 1 1 0 2 | 7 | maybe | Pull in once there's a real slow op. |
| ★ MCP tool composition (several ops → one intent-level tool) | 1 2 0 1 1 2 | 7 | want | **Built.** Promoted by decision (DX.md): explicit override; grouped tools still run the pipeline per op. |
| MCP tool-count lint (warn past ~15, suggest namespace groups) | 1 1 1 2 2 2 | 9 | want | **Built.** Nudges without hiding the op model. |
| MCP tool search mode (deferred tool loading for huge apps) | 1 0 0 1 0 2 | 4 | later | Only matters for very large apps. |
| Resource shorthand (`resource(Task)` → CRUD ops) | 2 1 1 1 1 1 | 7 | maybe | Big leverage, but hides the op model; add after ops feel right. |
| Raw per-facet handler escape hatch | 0 1 0 1 2 2 | 6 | maybe | Needed for adoption; must still run the pipeline (Gate 1). |
| File upload / download type | 2 0 1 1 0 1 | 5 | later | Multipart vs presigned vs base64 per facet; hard to get right. |
| API versioning (per-op or global versions) | 2 0 2 0 0 1 | 5 | later | Diff tool first; versioning when a real consumer needs it. |

## Facets (interfaces)

| Feature | L C D T B E | Score | Verdict | Why |
| --- | --- | --- | --- | --- |
| ★ MCP server | 1 2 1 2 2 2 | 10 | want | **Built (stdio + Streamable HTTP).** Cheapest facet, and the most "why now". |
| ★ REST + OpenAPI output | 1 2 1 2 1 2 | 9 | want | **Built.** Baseline everyone expects; OpenAPI unlocks other tools. |
| ★ TypeScript SDK | 1 2 1 2 1 2 | 9 | want | **Built.** Both halves: `createClient<typeof app>()` infers from the app module, and `omniface build` writes a publishable package whose types are generated from the manifest. Both are the same proxy over `@omniface/client` — types are generated, request code never is (see [SDKS.md](SDKS.md)). |
| ★ `@omniface/client` shared runtime (TS SDK + CLI engine) | 2 2 2 2 1 1 | 10 | want | **Built.** Retries, idempotency, pagination, errors written once for both. |
| ★ Inferred TS client (`createClient<typeof app>()`, no codegen) | 1 1 1 2 2 2 | 9 | want | **Built.** Nearly free given the shared runtime; great in monorepos. |
| OpenAPI `x-omniface-*` extensions + outside generator configs | 2 1 1 2 1 2 | 9 | want | **Built.** Named types hoist into `components.schemas` (which also fixed a dangling `$ref` for recursive types), every op carries its id, errors, pagination and its CLI/SDK/MCP names, and `examples/tasks/sdks/` has starting configs for four generators — none run in CI. |
| ★ CLI | 1 2 1 2 1 2 | 9 | want | **Built.** Proves facets aren't all HTTP-shaped. Decided: generic engine + embedded manifest, shipped under the app's own name (see DX.md). |
| Docs site generation (all facets, one page per op) | 2 1 1 2 1 2 | 9 | want | Show one op in every facet side by side. |
| `llms.txt` / agent-readable docs | 2 0 1 2 2 2 | 9 | want | **Built.** Nearly free once docs exist. |
| Python SDK | 1 1 1 2 0 2 | 7 | maybe | Via outside generators first; native only if they can't carry facet's traits. The document is ready; what is missing is a conformance runner that can drive an SDK in another process (backlog 5.4). |
| Webhooks (outbound; signing, retries, replay) | 2 1 1 1 0 2 | 7 | maybe | Built on declared events. |
| Terraform provider | 1 0 1 2 0 2 | 6 | maybe | Useful for infra-ish apps only. |
| Zapier / n8n / Make connector | 1 0 1 2 0 2 | 6 | maybe | Easy win for SaaS apps. |
| Go / Rust / Java SDKs | 1 0 0 2 0 2 | 5 | later | High maintenance per language; maybe use Stainless-style tools. |
| gRPC / Connect | 1 0 1 1 0 2 | 5 | later | Service-to-service; not the first audience. |
| SSE / WebSocket live facet | 1 0 1 1 0 2 | 5 | later | Promote together with streaming ops. |
| Queue consumers (Kafka, SQS, NATS) | 1 0 1 1 0 2 | 5 | later | Ops triggered by messages; after events. |
| GraphQL | 1 0 0 1 0 2 | 4 | later | Graph traversal fights the op model; N+1 problems. |
| TUI | 1 0 0 1 0 2 | 4 | later | Niche; the CLI covers most of it. |
| A2A (agent-to-agent) | 1 0 0 1 0 2 | 4 | later | Spec still settling; MCP first. |
| SOAP / XML-RPC | 0 0 0 0 0 2 | 2 | no | Legacy; nobody picks facet for this. |
| Generated web console (declared ops as screens) | 2 1 2 0 0 2 | 7 | want | **Owner call over the score, 2026-09-19 — [E12](BACKLOG.md#e12--web-facet).** The score is honest: `T0 B0`, it is the most expensive row on this page. Promoted anyway because the hand-written admin panel it replaces is the purest case of the drift facet exists to stop. Gate 5 re-read as interfaces-not-applications; the epic's scope fence is the thing to hold it to. |
| WebMCP: the browser's agent calls the same ops | 1 1 1 1 1 2 | 7 | want | **Was `maybe`, "build later" ([proposal](proposals/webmcp.md)); promoted 2026-09-19 into [E12](BACKLOG.md#e12--web-facet).** The score did not change — the architecture did. The proposal's objection was that registration lives in a bundle facet does not control; a generated web facet is that bundle. Ships behind the attenuated credential, not before it. |

## Plugins (cross-cutting concerns)

| Feature | L C D T B E | Score | Verdict | Why |
| --- | --- | --- | --- | --- |
| ★ Structured logging with `facet`, `op`, `actor`, request id | 2 2 2 2 2 2 | 12 | want | **Built.** Cheapest, highest-signal plugin. |
| ★ Rate limiting (per key / user / tenant / op, cost-aware) | 2 2 2 2 1 2 | 11 | want | **Built.** The "add one line, all facets change" demo. |
| ★ Scopes + `authorize` hook | 2 2 2 1 2 2 | 11 | want | **Built.** Authorization without building a policy engine. |
| ★ Auth (adapters over Better Auth / Clerk / WorkOS / JWT) | 2 2 2 1 1 2 | 10 | want | **Partly built: API-key auth only; Better Auth / Clerk / WorkOS / JWT adapters not yet.** Integrate identity (Gate 4); own how it appears per facet. |
| ★ API keys | 2 2 2 1 1 2 | 10 | want | **Built (in-memory store behind an interface).** Shows a plugin adding ops, schema, and CLI commands. |
| Idempotency keys | 2 1 2 2 1 2 | 10 | want | **Built: `idempotency()` fills the pipeline stage; store behind an interface; REST header, SDK/CLI keys, MCP `_meta`; conflict on key reuse and on in-flight; failures leave no record.** Pairs with the `idempotent` trait. |
| OpenTelemetry tracing + metrics | 2 1 2 2 1 2 | 10 | want | Standard; RED metrics tagged by facet. |
| Audit log (actor incl. agent-on-behalf-of-user) | 2 1 2 2 1 2 | 10 | want | **Built.** Agents need their own actor type. |
| ★ Pipeline with named stages (`authenticate → … → encode`) | 2 2 2 1 1 1 | 9 | want | **Built.** The thing that makes Gate 1 enforceable. |
| ★ Plugin API: schema, traits, context, hooks, ops, per-facet adapters | 2 2 2 1 0 2 | 9 | want | **Partly built: schema, traits, context, hooks, wrap, ops; per-facet `adapters` slot not yet.** The Better Auth-style core. |
| ★ Typed context contribution (`ctx.user`, `ctx.tenant`) | 2 1 1 2 1 2 | 9 | want | **Built.** Plugins must be type-safe to feel good. |
| Plugin prerequisites + ordering checks | 1 1 1 2 2 2 | 9 | want | **Built.** Borrowed from maxstack bundles. |
| CORS / CSRF / security headers | — | — | want | Table stakes for REST; default-on. |
| Quotas / usage metering | 2 1 1 1 0 2 | 7 | maybe | Emit usage events; leave billing to someone else. |
| Multi-tenancy (tenant resolution + scoping) | 2 1 2 1 0 1 | 7 | maybe | Real SaaS needs it; design it into ctx early. |
| Caching / ETags | 1 0 1 2 1 2 | 7 | maybe | Mostly REST and SDK. |
| Feature flags | 2 0 1 1 1 2 | 7 | maybe | Adapter over existing flag services. |
| Full RBAC / ReBAC policy engine | — | — | no | Gate 4: adapters for OpenFGA / Cedar / OPA instead. |
| Billing | — | — | no | Gate 4: Stripe via hooks + metering events. |
| Hosting our own identity provider | — | — | no | Gate 4. |

## DX and tooling

| Feature | L C D T B E | Score | Verdict | Why |
| --- | --- | --- | --- | --- |
| ★ Inspect data layer (every facet view of an op as JSON) | 2 2 2 2 2 2 | 12 | want | **Built.** Shared by the CLI, web page, docs and breaking-change diff. |
| ★ `omniface inspect <op> [--json]` | 1 1 1 2 2 2 | 9 | want | **Built.** Cheap; agent- and CI-friendly. |
| ★ Inspector web page (side by side, try it, live pipeline trace) | 2 2 2 2 1 2 | 11 | want | **Partly built: side-by-side view and pipeline; no try-it or live trace yet.** Makes the thesis visible in one screen; the MVP demo. Try-it and the trace are now [E11](BACKLOG.md#e11--playground) — running an op from the page is a product, not a feature of the page. |
| ★ `omniface dev` serves every facet + playground | 2 2 1 2 1 2 | 10 | want | **Partly built: serves REST, MCP and the inspector; no playground or watch mode yet.** One command, every facet live. The playground half is [E11](BACKLOG.md#e11--playground); the watch loop stays in E7. |
| Override budget lint | 1 1 2 1 2 2 | 9 | want | **Built.** Warns once more than a third of a facet's ops carry a per-op override. Stops overrides from taking over the definition. |
| Plugin authoring kit + plugin conformance tests | 2 1 2 1 1 2 | 9 | want | Needed before third-party plugins. |
| `omniface init` templates | 1 1 0 2 2 2 | 8 | maybe | Nice to have; one example app is enough at first. |
| Build-time tooling split out of the runtime package (`omniface/build`) | 1 0 1 2 1 2 | 7 | maybe | **Undecided, 2026-09-20.** Raised as "turn each output into a plugin to keep the core smaller". The plugin half is a no: `Plugin` is a per-invocation contract (every slot takes an `Invocation`), so a build-time emitter would bolt a second lifecycle onto it and make Gate 1 vacuous for half the list — and `plugins: []` would then decide what `omniface build` writes, next to the `facets: {}` knob that already implies it. The packaging half stands on its own and is what is open: `diff` (819 lines), `sdk` (392), `fix` (332), `lint` (213), `openapi` (144) and `build` (99) only ever run under `npx omniface`, yet ship in the package every app imports at runtime. The seam already exists — those emitters take a `Manifest`, not an `App`; the snag is `llms.txt`, which goes through `inspectAll(app)`. A registered `Emitter` (`Manifest → files`, held by the CLI, not by the app) is a separate question, and only earns its keep once a third-party output asks for it — a Python SDK, GraphQL SDL. |
| Agent authoring (skills + MCP for editing a facet app) | 1 0 0 2 1 2 | 6 | maybe | Borrow maxstack's approach once the API is stable. |
| Non-TS server runtime (Python, Go) | 1 0 0 0 0 2 | 3 | later | Server stays TS; clients can be any language. |
