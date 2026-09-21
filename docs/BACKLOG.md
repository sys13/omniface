# Backlog

Everything that isn't built yet, grouped into epics. [FEATURES.md](FEATURES.md) is the
*triage* list — one row per idea with a score and a verdict. This is the *work* list: the
`want` and promoted `maybe` rows, ordered, cut into deliverable pieces, with the reason
each epic exists.

Sizes are rough: **S** ≈ hours, **M** ≈ days, **L** ≈ a week or more.
Verdicts carry over from FEATURES.md; `—` means the story is new here (decomposition or
plumbing that no feature row names on its own).

Status legend: **open** · **partial** (some of it exists, see README "What's built") · **done**.

---

## Ordering

The first five epics were what stood between the current MVP and something a stranger can
use on real traffic, and they are built: **E4 is complete and closed**, E3 is down to three
`maybe` rows, E2 to 2.6, E1 to the npm name alone (#11),
which is a registry dispute rather than work, and E5 to 5.4, which waits on someone wanting an
SDK in a second language. **E6 is next in the ordering.** E6–E8 widen the
audience. E9–E10 grow the model itself and were not to start before the plugin API and the
conformance story were settled, because both change the shape of every facet — that condition
is now met, so 9.1 (declared events, and the thing 3.7 waits on) can be pulled forward if a
user asks for it.

**E11 and E12 are new (2026-09-19) and they move the boundary.** E11 pulls the playground out of
E7, because running an op four ways from one page turned out to be the demo rather than a row in
someone else's epic. E12 adds a fifth facet — the app's operations as screens, and those same
operations offered to the browser's agent over WebMCP. E12 reverses two recorded decisions: the
Gate 5 "no" on a generated web UI, and the "build later" on [WebMCP](proposals/webmcp.md). Both
reversals are argued in the epic, and E12 carries a scope fence, because the failure mode of this
epic is not that it goes badly — it is that it succeeds and keeps going until facet is maxstack.

| | Epic | Issue | Why now |
| --- | --- | --- | --- |
| 1 | [Release readiness](#e1--release-readiness) | #1 | Built — waiting only on the npm name (#11) |
| 2 | [Auth and security table stakes](#e2--auth-and-security-table-stakes) | #2 | Built — 2.6 (per-facet auth presentation) is all that is left |
| 3 | [Plugin platform](#e3--plugin-platform) | #3 | Built — 3.6–3.8 held back on purpose (`maybe`) |
| 4 | [Contract safety](#e4--contract-safety) | #4 | **Complete and closed** |
| 5 | [SDK distribution](#e5--sdk-distribution) | #5 | Built — 5.4 (a second language, proven) is all that is left |
| 6 | [CLI as a product](#e6--cli-as-a-product) | #6 | The facet a human touches most |
| 7 | [Inspector and dev loop](#e7--inspector-and-dev-loop) | #7 | The demo screen, and the daily author loop |
| 8 | [Docs](#e8--docs) | #8 | One op in every facet, side by side |
| 9 | [Async surface](#e9--async-surface) | #9 | Events, streaming, long-running, webhooks |
| 10 | [Model breadth](#e10--model-breadth) | #10 | More schema libraries, more op shapes |
| 11 | [Playground](#e11--playground) | #24 | The demo: one op, four facets, one page |
| 12 | [Web facet](#e12--web-facet) | #25 | A fifth facet — screens, and the browser's agent |

---

## E1 — Release readiness

**Goal:** `npm i facet` works, and a version number means something.
**Why:** packages are consumed as TypeScript source with no build step, so facet is
currently usable only from inside this repo. Every other epic ships through this one.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 1.1 | Build step for `facet`, `@omniface/client`, `@omniface/cli`, `@omniface/testing` — ESM + type declarations, subpath exports (`omniface/zod`, `omniface/plugins`, `omniface/mcp`) preserved | M | — | done |
| 1.2 | Publish pipeline: versioning, changelog, release tags, provenance | M | — | done (blocked on the npm name) |
| 1.3 | Supported-runtime matrix and CI (Node 24 built-in TS today; decide on Node 20/22 and Bun) | S | — | done |
| 1.4 | `facet` as a real installed bin, replacing `node …/devcli.ts` in the quickstart | S | — | done |
| 1.5 | Public API surface review — what's exported, what's internal, before the names are load-bearing | S | — | done |

Where each landed: `tsc` emits ESM + declarations per package (`packages/*/tsconfig.build.json`),
the published surface and its tiers are [API.md](API.md), the matrix is [RUNTIMES.md](RUNTIMES.md),
and the release loop is [RELEASING.md](RELEASING.md). `pnpm smoke` installs the packed tarballs into
an empty directory and drives every facet; CI runs it on Node 20/22/24 and Bun.

One thing E1 cannot finish on its own: **the npm name.** `facet` on the registry belongs to an
unrelated package, and the `@facet` scope is unclaimed, so the first real publish needs either the
scope plus a rename or npm's name-dispute process. Everything else is wired.

**Done when:** the quickstart in the README runs from a fresh directory with no clone.

---

## E2 — Auth and security table stakes

**Goal:** a facet app can be pointed at the internet.
**Why:** API keys with an in-memory store is a demo, not an auth story, and REST without
CORS is unusable from a browser. FEATURES marks both `want`; CORS is a table-stakes
exception that skips scoring entirely.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 2.1 | Auth adapter interface — one contract over identity providers, feeding `ctx.user` and the pipeline's `authenticate` stage | M | want | done |
| 2.2 | Better Auth adapter | M | want | done |
| 2.3 | JWT adapter (issuer/JWKS verification) | M | want | done |
| 2.4 | Clerk and WorkOS adapters | M | want | done |
| 2.5 | CORS, CSRF and security headers, default-on for the REST facet | S | want | done |
| 2.6 | Per-facet auth presentation: `Authorization` header, SDK constructor, CLI `login`, MCP OAuth 2.1 / client config — one credential, four surfaces (needs 3.1) | L | want | **partial** — discovery (RFC 9728) landed; SDK constructor, CLI `login` and the keychain still open |
| 2.7 | Persistent API-key store adapter (the built-in store is in-memory behind an interface) | S | want | done |

Where each landed: the contract is `AuthAdapter` in the core (`facet`), the adapters and the
`auth()` plugin are [`omniface/auth`](API.md#other-facet-entry-points), and the middleware is
`securityMiddleware`, mounted by `createServer` and `createRestApp` unless `facets.rest.security`
says otherwise. The durable key stores are `fileKeyStore` and `sqlKeyStore` in `omniface/plugins`,
and `@omniface/testing`'s `apiKeyStoreCases()` is the suite every `ApiKeyStore` has to pass.

Three things worth knowing about how they were built:

- **No provider SDKs.** Clerk and WorkOS session tokens are JWTs signed by a published JWKS, so
  both adapters are the JWT one with their claim names filled in — WebCrypto verifies, nothing is
  imported, and there is no token-introspection round trip. Better Auth is taken structurally
  through the one method the adapter needs (`api.getSession({ headers })`), so the real instance
  fits with no import and no version pin; `baseUrl` reads the same contract over HTTP when the
  auth server is a separate process.
- **Declining vs. rejecting.** An adapter returns `null` for a credential that is not its shape,
  which is how several providers coexist; a credential that *is* its shape and fails verification
  throws, so a forged token can never fall through to the next adapter and land as anonymous.
- **`apiKeys()` is both.** It still authenticates on its own by default. Pass `authenticate: false`
  and its `.adapter` to `auth({ adapters: [...] })` to make it one provider among several.

**2.6 is partial, and it is being done one surface at a time.** The per-facet `adapters` slot from
[3.1](#e3--plugin-platform) exists, and `apiKeys()` already uses it to advertise its security scheme
in OpenAPI and add a `whoami` command to the CLI.

**What landed: discovery.** An app names its authorization server —
`oauth: { authorizationServers: ['https://auth.example.com'] }` — and omniface serves RFC 9728
protected-resource metadata at `/.well-known/oauth-protected-resource`, puts a `WWW-Authenticate`
pointing at it on every REST refusal a credential would have fixed, and sets the same header on an
MCP-over-HTTP response from a caller that presented none. The scopes in the document are derived
from the ops' `scope` traits rather than listed again, so the document cannot advertise
authorization the app does not enforce. Nothing about this issues or verifies a token: Gate 4 holds,
and omniface does not become an authorization server. It is the half of the handshake that was
missing — an agent reaching a server it has no credential for had no way to find out where to get
one, so one had to be handed to it out of band.

The declaration sits on the app rather than under a facet, because it is not one facet's answer:
REST serves the document and MCP points at it, and a copy under each would be two places for the
same answer to be given differently. A plugin cannot serve it — plugin REST routes are namespaced
under `/_<plugin>` on purpose — so this is core, not an adapter.

**What is still open:** the SDK constructor option, the CLI `login` device flow and the keychain it
writes to (6.1/6.3, cheapest as one slice), and the web facet's sign-in screen (12.5). Until those
land a credential still reaches those facets as a bearer token (`Authorization`, the SDK
constructor, `--api-key`, the MCP server's env), and a browser cookie reaches REST and
MCP-over-HTTP only.

**One policy question was deliberately not answered:** MCP-over-HTTP sets the challenge header but
does not turn a credential-less call into a 401. An app may project public ops to MCP, and refusing
every anonymous call would decide that on the app's behalf from inside the facet.

**Done when:** the example app authenticates a real Better Auth session and a raw API key,
on all four facets, with conformance cases covering both. — done:
`examples/tasks/test/auth-adapters.test.ts` runs the whole generated suite twice over, once with
an API key and once with a Better Auth session as the credential.

---

## E3 — Plugin platform

**Goal:** someone outside this repo can write a plugin and trust it.
**Why:** the plugin API is the Better-Auth-shaped bet. Its last missing slot (`adapters`)
is what E2's per-facet auth needs, and nothing third-party should be encouraged before
there's a conformance kit for it.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 3.1 | Per-facet `adapters` slot in `definePlugin` — the only place a plugin may touch a facet, still barred from deciding *whether* (Gate 1) | M | want | done |
| 3.2 | Plugin authoring kit: docs, template, typed slot reference | M | want | done |
| 3.3 | Plugin conformance tests — run a plugin against a sample app on every facet | M | want | done |
| 3.4 | OpenTelemetry plugin: tracing plus RED metrics tagged by facet | M | want | done |
| 3.5 | Actor attribution over MCP Streamable HTTP — stateless transport loses the client name, so logs and audit differ from stdio (a Gate-1-adjacent drift bug) | M | — | done |
| 3.6 | Multi-tenancy: tenant resolution into `ctx`, scoping enforced in the pipeline | L | maybe | open |
| 3.7 | Quotas / usage metering as events, billing left to an integration | M | maybe | open |
| 3.8 | Caching / ETags (REST and SDK mostly) | M | maybe | open |

Where each landed: the slot is `FacetAdapters` in the core, collected onto `App.adapters` and
validated at app creation; the facets read it (`facets/rest.ts`, `facets/mcp.ts`, `facets/openapi.ts`)
and the serializable half travels to the out-of-process facets as `manifest.adapters`, which the CLI
engine renders as flags and command aliases. The guide is [PLUGINS.md](PLUGINS.md), the template is
`examples/plugin-template`, and `pluginCases()` in `@omniface/testing` is the kit, run in CI against
every built-in plugin and against plugins written to fail.

Three things worth knowing about how they were built:

- **The slot enforces Gate 1 by its shape, not by a rule in a doc.** No adapter member is handed an
  `Invocation`, so none of them *can* abort, skip or answer for an op; plugin routes are mounted
  under `/_<plugin>`, so they cannot shadow an op's route; and a contributed CLI command names an op,
  so it runs the same pipeline. What is left is finding credentials, attributing callers, adding
  endpoints beside the ops and decorating answers.
- **CLI and SDK adapters are declarations.** Those facets run in another process, so behaviour
  cannot travel; what a plugin declares for them is carried in the manifest and rendered where the
  facet runs. REST and MCP adapters are real functions, because those facets run here.
- **3.5 without making the transport stateful.** Streamable HTTP handles `initialize` and
  `tools/call` in separate requests, so the call never saw the client's name. The HTTP handler now
  remembers what an `initialize` announced, keyed by the credential plus the HTTP client presenting
  it, and hands it to the server for the calls that follow. It is attribution only — an entry can
  name a caller, never widen what that caller may do — and the fallback is the same
  `mcp:unknown-client` stdio would produce.

**Done when:** an out-of-tree plugin passes the conformance kit, and `3.5` makes stdio and
HTTP MCP produce identical audit records. — done: `examples/plugin-template` is a plugin built the
way an outside one would be and passes `pluginCases()`, and
`packages/omniface/test/mcp-attribution.test.ts` drives a real MCP client over both transports and
compares the audit records field by field.

**Still open, deliberately:** 3.6, 3.7 and 3.8 are `maybe` verdicts and were not built. Multi-tenancy
(3.6) has a pipeline stage waiting for it (`resolveTenant`) but no user yet; quotas (3.7) want
declared events from E9 to hang metering on; caching (3.8) needs a per-facet answer for what an ETag
means on MCP and the CLI before it is worth the surface.

---

## E4 — Contract safety

**Goal:** the drift proof is a command, not a convention.
**Why:** principle 7 — every output proven by generated conformance tests. Today those run
from a hand-written test file, and four `want` lints are unbuilt or half-built, so the
guardrails that keep overrides and traits honest aren't guarding anything yet.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 4.1 | `omniface conformance` command — run the generated suite from the CLI and CI, not only from vitest | M | want | done |
| 4.2 | Breaking-change diff, reported per facet ("breaks the Python SDK and a CLI flag, not MCP") | L | want | done |
| 4.3 | Unused-trait lint — a trait set on a schema the definition never reaches | S | want | done |
| 4.4 | Named-type lint: finish the recursive-schema error and add `lint --fix` to insert `t.named()` | M | want | done |
| 4.5 | Override budget lint — warn when an app lives at ladder steps 3–4 | S | want | done |
| 4.6 | Conformance fixtures ergonomics: `ops[id].input` / `.setup` are the only hand-written inputs; make supplying them obvious and checkable | S | — | done |

Where each landed: the command is `omniface conformance <entry>`, wired in `conformance-run.ts`; the
coverage report is `conformanceCoverage()` in `@omniface/testing`; both lints are rules in
`packages/omniface/src/lint.ts`, with `OVERRIDE_BUDGET` beside `MCP_TOOL_BUDGET`; the diff is
`diffManifests()` in `packages/omniface/src/diff.ts`, behind `omniface diff <before> <after>`; and the
fixer is `packages/omniface/src/fix.ts`, behind `omniface lint --fix`. The example app's own CI is now
`omniface lint && omniface conformance --strict`, run through the installed bin.

Four things worth knowing about how they were built:

- **The command has a zero-setup mode, because the checks divide by what they need.** The contract
  checks read the manifest and call nothing, so `omniface conformance app.ts` runs them against any
  app with no credential, no fixtures and no test runner. Everything else has to call the app, so
  it waits for a `conformance.fixtures.ts` beside the entry — the same object the vitest suite
  passes, so the command and the suite run the same cases instead of two drifting copies.
  `@omniface/testing` is resolved from the *app's* node_modules, not facet's: it peer-depends on
  facet, so depending on it here would be a cycle, and the copy that matters is the app's.
- **4.6 is a diff, not a second copy of the rules.** `conformanceCoverage()` generates the cases
  twice — once as the app stands, once with a placeholder input for every op — and reports the
  difference. Whatever `conformanceCases` decides an input unlocks, coverage reports, including
  rules added after it was written. `--strict` makes a gap an exit code.
- **4.3 does not catch what it was written to catch, and that is the finding.** The story assumed a
  schema method after `t()` strands the traits on a discarded instance. It does not: zod's clones
  stay visible to the adapter's conversion callback, so `.min()`, `.nullable()`, `.optional()` and
  `.describe()` all keep their traits, and `hasTrait` already looks through `anyOf` for the nullable
  case. Tests pin that behaviour. What the rule does catch is the honest reading of its name — a
  trait no op reaches at all, usually a field dropped from an op while its `pii` or `internal`
  declaration stayed behind, reading as protection while protecting nothing. It is opt-in, because
  the trait registry is process-wide and an orphan belongs to no app; `omniface lint` turns it on,
  having loaded exactly one definition.
- **A case that could never pass was being generated.** Giving `tasks.delete` an input surfaced it:
  `agree` drove all four facets at one app, so the first delete consumed the row and the other three
  answered `not_found`. An op that destroys something and is not idempotent now gets a fresh app per
  facet — the isolation every case already had, one level further down — so delete is proven to
  agree across facets instead of being skipped.

**Done when:** CI for the example app is `omniface lint && omniface conformance`, and a
deliberate per-facet divergence fails it. — done: `pnpm --filter example-tasks check` runs both in
CI, and a CLI column naming a field the output does not have fails `tasks.list · contract` with
that sentence and exit 1. The same proof runs for the diff: `examples/tasks/test/tooling.test.ts`
renames a CLI command, drops a `destructive` trait and moves a REST route in a published manifest,
then asserts the installed bin answers "Breaks rest and cli, not mcp and sdk." with exit 1 under
`--strict`.

Four more, from 4.2:

- **The verdict is per facet because a single verdict would be useless.** One definition projects
  onto four interfaces, and they disagree about almost every change. Renaming an output type breaks
  a generated SDK and an OpenAPI component and is invisible to MCP and the CLI. Marking an op
  `destructive` breaks CLI scripts — the CLI starts prompting, and an unattended run stops — while
  REST and MCP only gain a hint. Widening an output enum breaks every caller with an exhaustive
  switch; widening an *input* enum breaks nobody. A single answer would have to take the worst of
  the four and call every release breaking, so each change carries the facets it lands on and the
  report ends in one sentence: "Breaks rest and cli, not mcp and sdk."
- **It diffs manifests, not definitions.** The manifest already *is* every facet's view of every op,
  so the diff is one data comparison rather than four facet-specific diffs kept in step by hand. A
  rule added to a facet's projection is diffed the moment it reaches the manifest. It also means
  either side can be a published `manifest.json` or a working-tree app module, which is what makes
  `omniface diff .omniface/manifest.json src/app.ts` — released versus about-to-be-released — the normal
  invocation.
- **Three levels, not two.** `breaking` and `additive` leave nowhere to put a reworded MCP
  description or a changed CLI column, and filing those as additive would mean every release
  reported changes nobody can observe. They are `neutral`, `--quiet` hides them, and the split is
  what keeps a real breaking change visible in the output.
- **Breaking is a decision, not an error.** `omniface diff` exits 0 with breaking changes listed and
  suggests the bump (`minor`, pre-1.0, per RELEASING.md); `--strict` is what turns them into an
  exit code. Releases are allowed to break things on purpose — the command's job is that nobody
  finds out afterwards.

And three from 4.4:

- **The recursive-schema rule was checking for the wrong shape.** It looked for `$defs`, and zod 4
  does not emit one: a recursive type comes out as a bare `{ "$ref": "#" }` at the recursion point,
  pointing at the document root, with no `$defs` anywhere. So the rule never fired for the case it
  was written for. It now treats any internal `$ref` as recursion, which is the property that
  actually matters — an anonymous self-referential type gives the reference nothing to point at.
- **A fix needs a line number, and nothing else in facet does.** Schemas are compared by instance
  and ops by id; no value knows where it was written. The only bridge is the stack at the
  `op({...})` call, so `captureDefinitionSites()` records one per op — off by default, because it
  is pure cost to an app that is only going to run, and turned on by `omniface lint --fix` before it
  imports the entry. From there the edit is made by a scanner, not a parser: facet has no
  TypeScript parser at runtime and will not grow one for this.
- **The guarantee is not that the scanner is right, it is that a wrong edit never survives.** Every
  fix is checked by re-linting in a fresh process — fresh because the rewritten files are modules
  the fixing process already imported, and the ESM cache would hand back exactly the version the
  fix replaced. A file whose app no longer loads, or whose finding is still there, is restored byte
  for byte. Shapes the scanner does not recognise are declined with the edit to make by hand, which
  is the same outcome as a rollback and the reason declining is cheap.

**Still open:** nothing. E4 is complete.

---

## E5 — SDK distribution

**Goal:** consumers outside the repo, in and beyond TypeScript.
**Why:** the inferred client covers the monorepo case. The decision in DX.md is our own TS
SDK and outsourced generators elsewhere; both halves are built now, and what is left is proving
the second language rather than describing it.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 5.1 | Generated `@acme/sdk` package: `omniface build sdk`, on top of `@omniface/client` | L | want | done |
| 5.2 | Complete the `x-omniface-*` OpenAPI extensions so traits survive into other generators | S | want | done |
| 5.3 | Outside-generator configs (Stainless / Speakeasy / Fern / open source) with a documented setup | M | want | done |
| 5.4 | Python SDK via those generators, with a conformance run against it | M | maybe | open |
| 5.5 | SDK sugar the DX table promises: `.autoPaginate()`, constructor options, method grouping | M | — | done |

Where each landed: the package is written by `buildSdk()` in `packages/omniface/src/sdk.ts`, emitted
into `.omniface/sdk/` by `omniface build`; the named-type table both it and OpenAPI read is
`hoistNamedSchemas()` in `packages/omniface/src/schemas.ts`; `autoPaginate` is `Caller.collect` in
`@omniface/client`, reachable on the inferred client and the generated one alike; and the extension
reference plus the generator setup is [SDKS.md](SDKS.md), with starting configurations in
`examples/tasks/sdks/`.

Five things worth knowing about how they were built:

- **5.2 was not a missing feature, it was a broken document.** A recursive type comes out of zod 4
  as a bare `{ "$ref": "#/$defs/__schema0" }`, rooted at the *operation's* schema. Inlined into an
  OpenAPI document, where `#` is the document, that points at nothing — so any app with a
  recursive named type was emitting OpenAPI that no generator could resolve, and nothing said so.
  Named types are hoisted into `components.schemas` now, which fixes the reference and, in the
  same move, gives every method one shared `Task` model instead of a `TasksCreateResponse`, a
  `TasksGetResponse` and a `TasksCompleteResponse` for the thing the author named once. The test
  that matters is not about recursion: it walks the whole finished document and asserts every
  reference in it resolves.
- **The generated SDK generates types, not requests.** The methods are the same proxy over the
  same embedded manifest the inferred client and the CLI engine use, so nothing in the package is
  a request someone could hand-edit. That is the rule DX.md already set for the generated CLI, and
  the reason is identical: generated per-method source is a drift surface with a cursor in it.
- **What proves it is `tsc`, not an assertion about strings.** The generated `index.d.ts` is
  compiled in a separate process against a usage file whose wrong calls are marked
  `@ts-expect-error`. That fails in both directions — types too loose and the expected errors stop
  appearing, types too tight and the correct calls stop compiling — which a test that greps the
  declaration file for method names cannot do. The fresh-install smoke run then builds the package
  from packed tarballs and round-trips a call through it against a live server, so the thing being
  checked is what a consumer would actually install.
- **The package name is a break `omniface diff` could not see.** `facets.sdk.packageName` now reaches
  the manifest, which means renaming it breaks every consumer's `import` while no op changed at
  all. `omniface diff` gained `sdk-package-renamed` for the same reason it already had
  `cli-bin-renamed`.
- **A name is a promise, so a clash is reported rather than renamed.** Two `t.named('Thing', …)`
  with different shapes could be disambiguated into `Thing` and `Thing2`, but which one got the
  bare name would then depend on the order the ops happen to be declared in. The first shape keeps
  the name and the conflict is returned as data.

**Done when:** a generated SDK in a second language passes the same error and pagination
checks the TS client does. — **not yet.** 5.1–5.3 and 5.5 are built and the TypeScript half is
finished: the OpenAPI document carries every `x-omniface-*` an outside generator needs, and
`examples/tasks/sdks/` has starting configurations for Stainless, Speakeasy, Fern and the
open-source generators. What is missing is 5.4, and it is missing for a reason worth writing down:
none of those generators runs here. Three need a vendor account and the open-source ones need a
network plus a Python toolchain or a JVM, so the configurations are written from each generator's
documented format rather than from a build anyone watched succeed. Worse, `omniface conformance`
drives the app's four facets *in process* — it has no way to reach a package in another language.
So 5.4 is not "run a generator": it is a second conformance runner that speaks to an SDK as a
subprocess, and it should not be started until someone actually wants a Python SDK.

---

## E6 — CLI as a product

**Goal:** the CLI feels native to a terminal, not like a REST client in disguise.
**Why:** the CLI is the facet that proves facets aren't all HTTP-shaped, and it's the one a
human judges on feel.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 6.1 | Keychain credential storage, replacing env-var-only auth | M | want | **done** — the secret goes to the macOS keychain or libsecret, and `credentials.json` keeps only the base URL |
| 6.2 | Shell completions (bash, zsh, fish) from the manifest | M | want | open |
| 6.3 | `login` device flow against the auth adapters from E2 | M | want | open |
| 6.4 | Single-binary distribution (`bun build --compile`) after the npm path is solid | M | — | open |
| 6.5 | Output polish the DX table promises: `--output`, columns from field traits, masked `sensitive` values, relative time for `datetime` | S | — | partial |

**Done when:** `acme login`, tab completion and `acme tasks list --all | jq` all work
against a deployed app.

**6.1, and what it does not do.** `login` wrote the key into `credentials.json` in the clear, mode
0600. That is the right floor and the wrong ceiling: file permissions stop another account reading
it and stop nothing already running as this one — a backup, a `cat` in a screen share, a grep
through a synced directory. The secret now goes to the macOS keychain or, on Linux, libsecret, and
the file keeps only the base URL, which is not a secret. Windows keeps the 0600 file: its
credential manager has no shipped command that reads a secret back out, so reaching it means DPAPI
through PowerShell, which is more surface than this story is worth — and a fallback that quietly
pretended otherwise would be worse than one that says so.

Neither backend is reached through a native module. `keytar` would mean a compiled dependency in a
CLI that currently has one workspace dependency and nothing else, so both backends shell out to the
platform's own tool. On Linux the secret goes over stdin rather than argv, because argv is readable
by every other process on the machine.

A key written before this existed is still read, so an upgrade logs nobody out; the next `login`
moves it and the file stops holding it. The keyring refusing — locked, no daemon, not installed —
falls back to the file rather than failing the login.

What this is not is 6.3. The credential still arrives as `--api-key` or a prompt; where it is
*stored* changed and how it is *obtained* did not.

---

## E7 — Inspector and dev loop

**Goal:** the inspector reads well, and the author loop is one command.
**Why:** picking an op and seeing what every facet does with it already works. What is left
here is the loop *around* the page: it stays true while the definition changes underneath it,
a new app starts from something, and a new facet shows up in it without being special-cased.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 7.1 | Inspector "try it" — run an op from the page on each facet | M | want | **moved → [11.1](#e11--playground)** |
| 7.2 | Live pipeline trace — which plugins ran, in what order, with timings | M | want | **moved → [11.3](#e11--playground)** |
| 7.3 | `omniface dev` watch mode: reload on definition change | S | want | partial |
| 7.4 | Playground surface for MCP and the CLI inside `omniface dev` | M | want | **moved → [11.4](#e11--playground)** |
| 7.5 | `omniface init` templates | S | maybe | open |
| 7.6 | The inspect layer takes a new facet without edits — the web projection (12.1) is the test case, and it must reach the page, the docs and `omniface diff` by landing once | S | — | open |

**Done when:** editing an op reloads `/_omniface` without a restart, `omniface init` produces an app
that already runs, and adding a facet adds a column rather than a patch.

**Why it shrank:** running an op from the page turned out to be its own product — a form per
schema, four rendered calls, a trace, an actor switcher, and a real question about what a write
button means on a page someone deployed. That is [E11](#e11--playground).

---

## E8 — Docs

**Goal:** one op, every facet, side by side, generated.
**Why:** the inspect data layer already returns exactly this JSON; the docs site is mostly
a renderer over work that exists.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 8.1 | Docs site generation, one page per op, every facet shown together | L | want | open |
| 8.2 | Examples, ordering and prose overrides for docs (ladder step 3 for the docs facet) | S | — | open |
| 8.3 | Keep `llms.txt` in step with the docs site | S | want | partial |
| 8.4 | Author-facing guide: the ladder, the four override kinds, when to reach for each | M | — | open |

**Done when:** the example app's docs are generated in CI and nothing in them is hand-written.

---

## E9 — Async surface

**Goal:** operations that don't finish in one request-response.
**Why:** declared events are the single source webhooks, SSE and queues all read from, so
the order inside this epic matters more than the epic's position. Streaming and
long-running are `maybe` — they wait for a real slow op to design against.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 9.1 | Declared events (`op.emits(TaskCreated)`) — the foundation for everything below | M | want | open |
| 9.2 | Webhooks: signing, retries, replay | L | maybe | open |
| 9.3 | Streaming ops (`stream: Event`) and their per-facet semantics | L | maybe | open |
| 9.4 | Long-running ops (`async: true` → job handle): 202 + job URL, `await job.wait()`, CLI spinner, MCP progress | L | maybe | open |
| 9.5 | SSE / WebSocket live facet — promote together with 9.3 | L | later | open |
| 9.6 | Queue consumers (Kafka, SQS, NATS) — ops triggered by messages, after 9.1 | L | later | open |

**Done when:** one declared event reaches a webhook, an SSE stream and a queue with no
per-transport re-declaration.

---

## E10 — Model breadth

**Goal:** more schema libraries and more op shapes, without bending the core.
**Why:** each of these is pulled in by a user rather than pushed by the roadmap. Keep them
parked with a note on what would promote them.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 10.1 | `omniface/valibot` and `omniface/arktype` adapters — about one small file each | S | maybe | open |
| 10.2 | Raw per-facet handler escape hatch, still running the pipeline (Gate 1) | M | maybe | open |
| 10.3 | Resource shorthand (`resource(Task)` → CRUD ops) — only once ops feel right | M | maybe | open |
| 10.4 | File upload / download type: multipart vs presigned vs base64 per facet | L | later | open |
| 10.5 | API versioning, per-op or global — after the diff tool (4.2) exists | L | later | open |
| 10.6 | MCP tool search mode for very large apps | M | later | open |
| 10.7 | Feature-flag adapter over an existing service | S | maybe | open |

**Promotion triggers:** 10.1 on the first non-Zod user; 10.2 on the first adoption blocker;
10.4 on the first app with real files; 10.5 on the first outside consumer that can't move
in lockstep.

---

## E11 — Playground

**Goal:** one op, called four ways, from one page — and you can see what happened.
**Why:** E7 built a page that *reads*: here is the REST request this op would take, the SDK call,
the CLI line, the MCP tool JSON. Every visitor's next move is to try to click it. Making that
click work is the difference between a diagram of the thesis and a demonstration of it — type an
input once, fire it at all four facets, and watch the same three plugins run in the same order
each time. It was three rows inside E7 (7.1, 7.2, 7.4). It is the front door of the product, it is
what a stranger screenshots, and [E12](#e12--web-facet) inherits its runner, so it gets its own epic.

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 11.1 | Op runner: an input form derived from the op's schema, executed through the real pipeline — the same call path a `curl` takes, never a second one | M | want | partial (was 7.1) |
| 11.2 | Four-up result: one input, rendered as the REST exchange, the SDK snippet, the CLI invocation and the MCP tool call — with the bytes each actually produced, not a mock-up of them | M | want | open |
| 11.3 | Live pipeline trace: which plugins ran, at which stage, in what order, with timings — and the same trace shape for all four, because that is the claim being proved | M | want | open (was 7.2) |
| 11.4 | MCP and CLI playgrounds: drive the tool list and the generated CLI from the page — a transcript, not a form, because that is what those two feel like | M | want | open (was 7.4) |
| 11.5 | Copy-out: every panel yields something runnable elsewhere — a `curl`, a `.ts` snippet, the CLI line, the MCP JSON | S | — | open |
| 11.6 | Actor switcher: the same op as anonymous, as a reader key, as admin — the conformance matrix, driven by hand | S | — | open |
| 11.7 | Write safety: `destructive` ops confirm, `internal` ops never appear, and the runner is off unless the server was started for development or the app opted in explicitly | S | — | open |

**Done when:** a visitor opens `/_omniface`, calls one op four ways without leaving the page, and
sees the same plugins in the same order in all four traces.

**Depends on:** the inspect data layer, which already returns the per-facet projections 11.2
needs — but those are the *static* pipeline (`inspect.ts` reports which plugins sit at which
stage), not a record of a call. 11.3 is the one story that needs new core: `runStage` in `app.ts`
awaits each hook and emits nothing, so it grows a trace sink that is unset by default and costs a
branch when it stays that way. 11.6
reuses the conformance actors rather than inventing a second idea of "who is calling".

**The risk worth naming:** 11.1 is a remote code execution surface if it is ever on by default in
production — it runs the app's own operations, which is the point. 11.7 is not polish; it is the
story that makes the rest of the epic shippable, and it lands with or before 11.1.

---

## E12 — Web facet

**Goal:** a fifth facet — the app's operations as screens a person can use, generated from the
same definition as the other four, and those same operations offered to the agent in the
visitor's browser over WebMCP.
**Why:** the app already declares what it can do, who may do it, what is destructive, what is
paginated, and which fields are `pii`, `sensitive` or `internal`. Every one of those declarations
is something a hand-written admin panel re-states in its own words and then gets wrong six months
later. That is drift, which is the problem facet exists to solve, and it is currently solved for
four interfaces and conceded on the fifth. And once facet serves a page, the WebMCP question
answers itself differently than it did in September: the thing that made it awkward was that the
registration lived in someone else's bundle.

### This reverses two recorded decisions

Both were recorded so they would not be re-litigated casually. They are being re-litigated
deliberately, so the reasoning is written down here.

**Gate 5, "a generated admin / web UI is maxstack's job."** The gate is still right; its wording
was too wide. It ruled out *UIs as a category*, when what it should rule out is *applications* —
data models, migrations, screens for things that are not operations. A web console is a
projection of declared ops, exactly like the REST routes and the CLI commands are, and the CLI
already proved that a facet aimed at a human is a facet and not an app. [CRITERIA.md](CRITERIA.md)
is updated to say interfaces-not-applications, and the fence below is what keeps that honest.

**WebMCP, "build later."** [The proposal](proposals/webmcp.md) said don't build it now, and set
promotion triggers. Two of the five are now met — 3.1 and 2.6's groundwork make the attenuated
credential (W5) writable, and this epic is a real ask against a real app. The third change is
structural rather than a trigger: the proposal's strongest objections were that facet does not
control the browser bundle, so the registration would live somewhere the definition cannot see,
and that §5's origin isolation had no candidate page. A generated web facet is that bundle and
that page. W1–W7 move here wholesale as 12.6–12.11.

### Where this stops

The failure mode of this epic is not that it goes badly. It is that it goes well and keeps going.
So the line is drawn before the first commit, and it is a testable one.

| facet generates | maxstack's job |
| --- | --- |
| a screen per declared op | a screen for anything that is not an op |
| a table from a `paginated` read, a form from an input schema | a form builder or page designer |
| field visibility straight from field traits | a data model, migrations, an ORM |
| sign-in through the E2 auth adapters | user management and tenant administration screens |
| labels, ordering and column choice as overrides | a theme system, a component library, design tokens |
| one stylesheet an app can replace wholesale | an app you extend by writing components inside it |

**The test:** if a screen cannot be derived from a declared operation, facet does not render it,
and there is no supported way to add one. The day the answer to "how do I add a custom page?" is
anything other than *"you don't — declare the op, or write your own app against the SDK"*, this
epic has become maxstack and should be stopped. Concretely that means: no client framework, no
build step in the app, no component API, and no npm dependency added to the app to use it.

### Stories

The screens:

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 12.1 | Web projection in the manifest: every op gets a screen kind derived from what it already declares — a `paginated` read is a table, a single read is a detail, a write is a form, `destructive` adds a confirm — sitting beside the REST, CLI and MCP projections so `omniface inspect`, the docs and `omniface diff` see it without being taught | M | want | **done** |
| 12.2 | The renderer: server-rendered HTML from that projection plus one small island script. No framework, no build step, no dependency in the app — the constraint is the fence from the section above, not asceticism | L | want | **done** — not mounted until 12.5 |
| 12.3 | Field traits on screen: `internal` never rendered, `sensitive` masked behind a reveal, `pii` under the same rule the other facets apply, `deprecated` marked, `datetime` relative — one table of rules shared with the CLI's output layer, not a second interpretation of the same traits | S | want | **done** |
| 12.4 | The four override kinds for web (ladder steps 2–3): labels and ordering, which fields a table shows, which op backs an action, confirm and refresh behaviour. Unknown op ids fail `tsc`, like every other facet | M | want | **done** |
| 12.5 | Mount and serve: `facets: { web: { path: '/app' } }`, its own CSP (a page needs a script; the API still must not), session sign-in over the E2 adapters, CSRF on every write | M | want | **partial** — mounted, own CSP, CSRF; sign-in still waits on 2.6 |

The browser's agent — [W1–W7](proposals/webmcp.md) relocated:

| ID | Story | Size | Verdict | Status |
| --- | --- | --- | --- | --- |
| 12.6 | WebMCP registration from the generated page: `document.modelContext` fed from the same projection, `internal` ops never registered, MCP annotations mapped across (`destructiveHint` → `consequentialHint`), an unregister handle, cancellation through `AbortSignal` — plus `X-Facet-Via: webmcp` and `X-Facet-Client` carried end to end through logging and audit, as a claim and never as authority | M | want | **done** — W1–W3; opt-in, and see the note below on 12.8 |
| 12.7 | Advertise-and-refuse from one declaration: what a browser-agent caller may do, stated once and read both by the registration filter and by an `authorize` hook, so the in-page filter is a presentation detail and never the enforcement | M | want | **done** — W4 |
| 12.8 | Attenuated agent credential: a short-lived, scope-narrowed token minted for in-page agent use and carried by the caller, instead of handing the agent the ambient session cookie and with it the user's whole authority | L | want | **done** — W5; 2.6 turned out not to be needed |
| 12.9 | Untrusted-output trait → `untrustedContentHint`, and what that same trait should mean for the MCP facet, which has had the problem all along and has been living with it | S | want | **done** — W7 |
| 12.10 | Conformance for both halves: an op not advertised is refused when called anyway; `internal` never renders and never registers; redaction matches the other four facets field for field; CSRF defaults hold; a `destructive` op confirms on the page and is annotated for the agent | M | want | **done** — W6; the `presentation` check reads the screen and diffs it against REST through `presentation.ts` |

**Done when:** the example app's console is generated with nothing hand-written in it, a browser
agent completes a task through the same ops a human just clicked, and the conformance suite shows
the web facet refusing exactly what the other four refuse — same actor, same error, same shape.

**Where the WebMCP half got to.** 12.7 is the declaration: `facets.web.agent` says what a browser
agent may reach — `readonly` by default, per-op overrides, `none` and `all` — and *two* readers
use it, which is the whole story. `webTools()` registers exactly what it allows, and `app.invoke`
refuses everything else when the caller claims `X-Facet-Via: webmcp`. The claim narrows and never
widens: the same write a page never advertised is refused for an agent and answered for a script,
which is the right direction for an unverifiable claim to travel. 12.6 is the registration itself,
in the generated page's one script: MCP's descriptors reused wherever the MCP facet already
computed them, `destructiveHint` mapped to `consequentialHint`, the agent's `AbortSignal` threaded
into the fetch, and `window.facetAgent.unregister()` to take it all back down. 12.9 is the
`untrusted` trait — `untrustedContentHint` on WebMCP, and, because MCP proper has no such
annotation, a sentence in the tool description saying to treat the output as data. 12.10 runs every
generated case against the screens too, plus two the browser half needs — an op the page never
advertised is refused when called anyway, and a write with no CSRF token is refused.

**12.10 was recorded as done before it was, and the correction is worth keeping.**
For a while the generated suite could not see the contents of a screen at all: gutting the table and
detail renderers so every screen returned 200 with no records passed 67 of 67 generated cases. The
redaction claim was carried by `web-render.test.ts`, which hand-built a `Task` with fields the
example app did not have and called `renderScreen` directly, bypassing the pipeline — a
hand-maintained restatement of the trait rules, drifting independently of the app it described, and
load-bearing for the fifth facet.

`harness.ts:175` still marks every successful web answer `presentation: true`, and `outcomesAgree`
still skips value comparison when that flag is set, because a rendering is not a record. The comment
at `harness.ts:18-26` named the gap that leaves — *"a test that cares what reached the page reads the
HTML"* — and a generated case now does. The `presentation` check opens the screen, parses the
rendered field set out of it by `data-field`, asks `presentation.ts` what that op should show, and
diffs both the field set and the values against what REST answered for the same call: `sensitive`
masked rather than absent, `pii` in the clear as on every other facet, `deprecated` marked, and no
field the rules did not list. It reads the same table the renderer renders from, so there is no third
copy of the rules. The example app now declares a `sensitive` field (`shareToken`), so the masking
path runs against the shipped definition rather than only a fixture, and the part of
`web-render.test.ts` the generated case took over is gone.

The mutation is the gate, and it is run rather than described: gutting the two renderers now fails
four generated cases instead of none. A screen with nothing on it and a record with nothing in it is
reported as a problem too — a case that proves nothing is the failure mode this whole entry is
about — which is why the list screens carry a `setup` in the fixtures.

Two things were fine all along, and are worth not re-deriving later: `stripInternal` runs in the
pipeline (`app.ts:400`) before any facet, so `internal` leaking is structurally prevented rather than
merely tested, and the agent-token wiring is correct.

**12.8 is built, and 2.6 turned out not to be in the way.** The proposal read the dependency as
"minting is a plugin concern needing an `adapters` slot", and 3.1 delivered that slot; what was
left needed no per-facet credential *presentation* at all, because the page presents the credential
to itself. `agentTokens()` contributes one op — `agentToken.mint` — which the page calls with
whatever the visitor is already signed in with, and gets back a token that is short-lived (five
minutes by default) and narrowed twice: to the app's ceiling, and to what that caller actually
holds. The tools carry it instead of the cookie, and a page that cannot mint registers nothing
rather than falling back to the session, because the fallback is the failure. Downstream nothing is
new — `scopes()` refuses the narrowed token exactly as it refuses a narrow API key, which is the
point of attenuating rather than inventing an agent-shaped permission system. The example app shows
it: the admin holds `*`, the token holds `tasks:read`, a write through the token is refused and the
same write with the admin's own key is not.

An app that asks for `credential: 'attenuated'` without the plugin refuses to start, rather than
quietly leaning on the session — the same startup refusal facet already makes for a scope no plugin
enforces.

**Order inside the epic:** 12.1 first, because it is the story the other nine read from, and
because until the projection exists the argument that this is a facet rather than an app is
unproven. It is built: `facets: { web: true }` puts a `web` block on every op in the manifest —
screen kind, route, title, the fields it shows, whether it confirms — and `omniface inspect`,
`omniface diff`, `llms.txt` and the conformance contract check read it like they read the other four.
The facet is opt-in rather than on under `facets: undefined`, because until 12.5 nothing serves
the routes it names, and because a page a person lands on should be a decision.

12.2 and 12.3 followed it. `renderScreen(manifest, opId)` returns a whole HTML document — one
inlined stylesheet, one island script, nothing fetched from anywhere — and it *cannot* render
anything that is not a declared op: the only argument it takes is an op id, and an id with no
screen throws with the sentence the fence is written in ("declare the op, or write your own app
against the SDK"). The island does the three things markup cannot: confirm a `destructive`
action, reveal a masked value, say how long ago a timestamp was. With it off, the forms are still
forms. The trait rules are `presentation.ts` in the core, which the CLI's tables now read too, so
there is one table of them rather than one per human-facing facet.

12.4 followed: `facets.web.ops[id]` takes a title, a path, which fields a screen shows and in what
order, per-field labels, whether it confirms and what it asks, which ops are offered as actions,
where a write lands, nav order and whether it is in the nav — and nothing that would add a screen,
a field or a non-op action. 12.5 is mounted but not finished: `createWebApp` serves every screen
under the mount path, runs each one through `app.invoke` like every other facet, gives the page
its own CSP (`form-action 'self'`, inline style and script, nothing else) and puts a double-submit
CSRF token on every write, and `omniface dev` lists it beside REST and MCP. The example app turns it
on, so the screens are exercised by the suite and by hand. What is left of 12.5 is the sign-in
presentation, which is 2.6's to build: a session reaches the pipeline through the request headers
today, so an API key works and a cookie session works if the auth plugin reads one, but the web
facet has no sign-in screen of its own. 12.2–12.5 are shippable without a single line of WebMCP. 12.6 is the demo. 12.7 and 12.8
are what make it defensible for traffic that is not a demo — **12.6 does not ship to a released
version before 12.7 and 12.8**, because shipping a supported surface that quietly stops narrowing
scopes would contradict the one promise facet makes.

**Depends on:** 2.6 (per-facet auth presentation) for anything with a session; 3.1 for the
credential work in 12.8; [E11](#e11--playground)'s 11.1 runner, which is the same problem — a form
from a schema, executed through the pipeline — and should be written once and used twice.

---

## Not in the backlog

Recorded here so they aren't re-litigated. Full reasoning in FEATURES.md.

| Item | Why not |
| --- | --- |
| Generated admin / web UI | **Promoted 2026-09-19 → [E12](#e12--web-facet).** Gate 5 was re-read as interfaces-not-applications; the fence that replaces the flat "no" is in the epic |
| Full RBAC / ReBAC policy engine | Gate 4 — adapters for OpenFGA / Cedar / OPA instead |
| Billing | Gate 4 — Stripe via hooks and metering events |
| Hosting our own identity provider | Gate 4 |
| SOAP / XML-RPC | Nobody picks facet for this |
| GraphQL, gRPC / Connect, TUI, A2A | `later` — graph traversal fights the op model; the rest are audience mismatches for now |
| Go / Rust / Java SDKs | `later` — outside generators first |
| Non-TS server runtime | `later` — the server stays TypeScript; clients can be any language |
