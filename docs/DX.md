# DX

Two audiences, and they must not be confused:

- **Authors** — the developer writing the facet definition (ops, plugins, overrides).
- **Consumers** — whoever uses a generated facet: a frontend dev on the SDK, an ops person on
  the CLI, an agent on MCP, an integrator on REST, and — once [E12](BACKLOG.md#e12--web-facet)
  lands — a person clicking the generated console, plus the agent in their browser.

The bet: **author DX is almost entirely common across facets; consumer DX should feel
native to each facet.** The overrides exist to cover the gap between the two.

## Author DX

### Progressive disclosure — the ladder

Each step is only needed if the one before isn't enough:

| Step | What you write | Example |
| --- | --- | --- |
| 0. Convention | nothing | `tasks.create` → `POST /tasks`, `app tasks create`, `tasks_create` |
| 1. Trait | intent on the op or field | `.traits({ destructive: true })` |
| 2. Facet config | turn facets on/off, facet-wide options | `cli: { binName: 'acme' }` |
| 3. Override | one of four kinds, on one op in one facet | `mcp: { ops: { 'tasks.list': { description } } }` |
| 4. Raw handler | a facet-specific handler that still runs the pipeline | custom multipart upload route |

The override budget lint warns when an app keeps using step 3: `omniface lint` reports a facet where
more than a third of the projected ops carry a per-op override. Turning a projection off
(`ops: { 'tasks.get': false }`) is step 2 and is not counted — it is a decision, not a divergence.

### Common to all facets (author side)

- **One definition, all in TypeScript.** Types flow from schema → handler → overrides → generated clients.
- **Typos are type errors.** An override on an unknown op, or a CLI arg that isn't an input field,
  fails `tsc`, not a runtime check.
- **One dev loop.** `omniface dev` serves REST, MCP (stdio + HTTP), runs the CLI against the local
  server, and watches SDK codegen.
- **One inspector.** Choose an op → see its REST request, SDK call, CLI command, MCP tool JSON, and
  docs, plus which plugins ran and in what order.
- **One test story.** `omniface conformance` runs generated conformance tests: same op, same actor,
  every facet → same result, same error, same rate-limit behavior. With no setup it runs the checks
  that read the manifest; a `conformance.fixtures.ts` beside the entry supplies the credential and
  the per-op inputs the definition cannot know, and unlocks the rest.
- **One mental model for concerns.** Plugins go on the app; they never go on a facet.

### Differs by facet (what authors actually tweak)

| Facet | Usual overrides | Warning sign |
| --- | --- | --- |
| REST | path shape, status codes for success, a few query-vs-body choices | Rewriting many paths → rename ops instead |
| SDK | method grouping, sugar (`.autoPaginate()`), constructor options | Hand-writing SDK methods |
| CLI | command names, positional args, output columns, confirmations | Mirroring every op 1:1 as a command |
| MCP | tool descriptions, grouping ops into intent-level tools, result size, hiding fields | 50+ tools; descriptions that repeat the field list |
| Docs | examples, ordering, prose | — |
| Web *(built, not yet mounted — [E12](BACKLOG.md#e12--web-facet) 12.5)* | labels and ordering, which fields a screen shows, which op an action calls, confirmations, where a write lands | Wanting a screen that is not an op → that is an application; write it against the SDK |

## Consumer DX

### Common across facets (the promise)

- **Same nouns and verbs.** `tasks.create` is recognizably the same thing everywhere.
- **Same credential.** One API key works in the REST header, the SDK constructor, `acme login`, and MCP.
- **Same errors, same meaning.** A `RateLimited` has a retry-after in every facet.
- **Same pagination semantics.** Cursors, same page limits.
- **Same limits.** Validation rules and rate limits don't vary by facet unless an override says so.
- **Discoverable.** Every facet can describe itself: OpenAPI, SDK types, `--help`, MCP `tools/list`.

### Native to each facet

| | REST | SDK | CLI | MCP |
| --- | --- | --- | --- | --- |
| **Consumer** | integrator, any language | app developer | human in a terminal, CI script | LLM agent |
| **Discovery** | OpenAPI, docs | autocomplete, types | `--help`, completions | `tools/list`, descriptions |
| **Auth** | `Authorization` header | constructor / env var | `login` (device flow), keychain, env var | OAuth 2.1 or key in client config |
| **Input** | JSON body, query, path | typed object | flags, positional args, stdin, `--json` | JSON args from a schema |
| **Output** | JSON + status | typed object | table for TTY, JSON when piped, `--output` | text/structured content, sized for context |
| **Errors** | status + Problem Details | typed exceptions | exit code + clear stderr, suggested fix | `isError` with text a model can act on |
| **Pagination** | `cursor` / `next` | `for await` auto-iterate | `--limit`, `--all` | truncation + "call again with cursor" hint |
| **Destructive ops** | nothing special | nothing special | confirmation prompt, `--yes` | `destructiveHint`; client asks for confirmation |
| **Long-running** | 202 + job URL | `await job.wait()` | spinner, `--no-wait` | progress notifications |
| **What "good" feels like** | predictable, boring | invisible — feels hand-written | fast, pipeable, forgiving | few, well-described tools; small results |

### The facet adapter's job

Each facet adapter owns *exactly* the rows above and nothing else. If an adapter
starts deciding **whether** something is allowed (instead of **how** to show it), that's a
Gate 1 violation.

## Plugin author DX

- One `definePlugin` with typed slots: `schema`, `traits`, `context`, `hooks` (by named stage),
  `ops`, `adapters` (per facet), `config`.
- The per-facet `adapters` slot is **optional**; conventions cover most plugins
  (logging needs none; auth needs one per facet).
- Plugin conformance kit: run the plugin against a sample app across every facet.

## Decisions

- ~~CLI: generated binary or generic CLI?~~ **Decided: a generic engine plus an embedded manifest**
  (the AWS CLI approach). `@omniface/cli` handles parsing, output, auth, pagination and completions.
  `omniface build cli` outputs only a manifest snapshot, a bin wrapper with the app's own name (`acme`),
  and any custom commands written in code. Ship on npm first, then as a single binary via
  `bun build --compile`. A generic `facet` CLI that loads the manifest at runtime is for dev only.
  Generated per-command source code is rejected: hand edits make it drift from the definition.
- ~~MCP: automatic namespace grouping or explicit grouping?~~ **Decided: a mix.** One tool per op by
  default. Traits do most of the tidying: `internal`/`mcp: false` hides ops, `readonly`/`destructive`
  set the MCP hints, `paginated` caps result size. Intent-level tools are an explicit override
  (`mcp.tool('triage_inbox', [...])`). A grouped tool still runs each underlying op through the
  pipeline, so auth, limits and audit apply per op. Lint warns past ~15 tools and *suggests*
  namespace groups but never applies them. A "search for tools" mode for very large apps is later.
- ~~SDK: own generator or Stainless/Speakeasy?~~ **Decided: our own TypeScript SDK, outsource the rest.**
  `@omniface/client` is one runtime shared by the TS SDK and the CLI engine: auth, retries with
  automatic idempotency keys, pagination, typed errors, streaming. TypeScript can use it two ways:
  inferred (`createClient<typeof app>()`, no codegen, for the same repo) or a generated package
  (`@acme/sdk`, for outside users). Other languages get OpenAPI with `x-omniface-*` extensions plus a
  documented setup for Stainless / Speakeasy / Fern / open-source generators. A native SDK in another
  language only if outside generators can't carry facet's traits well enough.
  **Built** — both TypeScript halves and the extensions; [SDKS.md](SDKS.md) is the guide, and the
  one thing still open is proving a second language rather than describing it (backlog 5.4).
- ~~Inspector: web page or CLI table?~~ **Decided: both, from one data source, built in this order:**
  (1) an inspect data layer that returns every facet view of an op as JSON, also used by docs and the
  breaking-change diff; (2) `omniface inspect <op> [--json]` for terminals, agents and CI; (3) a web page
  served by `omniface dev` with facets side by side, "try it" per facet, and a live trace of each request
  through the pipeline stages. The web page is the MVP demo screen.
