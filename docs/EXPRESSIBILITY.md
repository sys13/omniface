# Expressibility study

**Question:** take tools and APIs people actually use, define them in facet, and see what happens.
Not "could this be done in principle" — write the definition, run `omniface lint`, `omniface build` and
`omniface conformance` against it, and read the answer off the output.

Six subjects, chosen so that each one stresses something different. Everything below is in
[`examples/expressibility`](../examples/expressibility); `node run-study.mjs` reproduces the table
and `examples/expressibility/test/study.test.ts` asserts it in CI.

| Subject | What it stresses | Ops | Per-op overrides | MCP tools | Lint | Builds |
| --- | --- | --- | --- | --- | --- | --- |
| **linear** (control) | a conventional SaaS API | 15 | **0** | 15 | 0 | yes |
| **stripe** | money, unions, metadata, idempotency, events | 14 | 4 | 14 | 0 | yes |
| **github** | composite identity (`owner/repo/number`) | 16 | **13** | 13 | 1 | yes |
| **s3** | opaque bytes, keys with slashes, ranges | 12 | 3 | 10 | 0 | yes |
| **docker** | CLI-first, streams, long-running work | 11 | 5 | 11 | 1 | yes |
| **kubernetes** | an op set computed at runtime (CRDs) | 19 | 0 | 10 | 0 | yes |

Op counts include the ops `apiKeys()` contributes. "Per-op overrides" counts entries under
`facets.*.ops` in the definition.

## The short answer

Four of the six fit with little or no friction, and the two that do not fail for reasons that are
already on the backlog. The single biggest cost in the whole study is not streaming or binary
payloads — it is **composite identity**, which is ordinary, extremely common, and currently taxed
once per operation.

The control subject is the result worth stating first: a Linear-style tracker is 15 ops with zero
overrides on any facet and zero lint findings, and its generated conformance suite —
**71/71 cases, four facets, no hand-tuning** — passes on an app written against the public API
with nothing adjusted in facet to accommodate it. The pitch holds on the shape it was designed for.

## What the study found in facet itself

Three defects, found by modelling rather than by reading code. The first is a real bug and is
fixed in this branch.

### 1. A named union made `omniface build` emit a `.d.ts` that does not parse — **fixed**

Stripe's `PaymentMethod` is a card or a bank account. `t.named()` over a discriminated union
reached the SDK generator, which chose `interface` or `type` by asking whether the rendered body
started with `{`. A union of objects does:

```ts
export interface PaymentMethod {
  type: "card"
  …
} | {              // ← TS1109: Expression expected
  type: "bank_account"
  …
}
```

The whole generated package failed to compile, not just that type. The fix asks the schema for
branch keys instead of asking the text for a brace (`packages/omniface/src/sdk.ts`), with a
regression test in `packages/omniface/test/sdk-types.test.ts` that runs `tsc` over the output —
the check `examples/tasks` already does, on an app that happens to have no union in it, which is
how this got through. All six subjects' SDKs now typecheck.

### 2. `omniface lint --fix` reported the wrong reason for declining — **fixed**

On the Kubernetes subject, `--fix` declined with "`Ref` is not declared with `const` … it is
probably imported". `Ref` *is* declared with `const` — inside the factory that generates the ops.
The fixer only looks for a top-level declaration, so it cannot tell the two apart. Declining is
still correct (a schema built inside a factory is a distinct instance per call, so they cannot all
carry one name), but the reason was wrong and sent the author looking for an import that does not
exist. The message now names both possibilities and says what to do in the generated case.

### 3. The REST facet cannot express a path segment containing `/` — open, low priority

An S3 key is `photos/2026/cat.jpg`. With `path: '/{bucket}/{key}'`, `GET /b/photos/2026/cat.jpg`
is a 404 and `GET /b/photos%2F2026%2Fcat.jpg` is a 200. facet's own SDK, CLI and MCP clients all
percent-encode, so **the four facets do agree** — `examples/expressibility/probe-agreement.mjs`
checks exactly that, and they do. What is lost is compatibility with the wire format an existing
S3 client or a hand-written `curl` already speaks. A wildcard segment is not expressible in
`RestOverride` (`{ method, path, status }`).

## The fourteen frictions, by weight

Each is marked in the source at the op it bites.

### Heavy — worth a design response

**F1. Composite identity costs one override per op.** (github) `conventionalRest` inserts `{id}`
only when the input has an `id` property. A GitHub issue is identified by `owner`, `repo` and
`number`, so all ten resource ops need an explicit `rest.path`, and `omniface lint` then fires
`override-budget` — correctly by its own rule, and misleadingly, because its advice ("the ops are
named wrong; rename the ops instead") does not apply. The ops are named right; the *identity* is a
tuple. Nested resources are not exotic: GitHub, Kubernetes namespaces, Stripe subresources and
every multi-tenant API have them.

Worth considering: extend the convention so that input properties carrying `scalar: 'id'` become
path segments in declaration order, making `/repos/{owner}/{repo}/issues/{number}` the derived
path rather than the override. That would take github from 13 overrides to roughly 2 and is the
single highest-leverage change this study suggests.

**F9/F11/F12. Streams and long-running work have no projection.** (docker, kubernetes) Already
listed as unbuilt in the README; this measures the cost. Three different degradations show up, and
they are not equally acceptable:

- `docker logs` degrades into a paginated read a client polls. Worse than `-f`, but real: the
  SDK's `.iterate()` makes a usable poll loop, and the op can report that the container exited.
- `docker pull` degrades into job-as-resource: `pull` returns a job id, `jobs.get` reports
  progress. Expressible, but it turns one verb into three ops and makes the async-ness the API
  consumer's problem.
- `kubectl watch` does **not** degrade. Every controller in Kubernetes is a watch loop, and
  polling a list is not a substitute at cluster scale. This is the one operation in the study that
  a workaround does not rescue.

`docker exec -it` is a fourth case that a streaming *response* alone would not fix: an interactive
terminal needs a streaming request too. The batch form (`run, wait, return output`) is
expressible, and it is what CI actually uses.

**F8. The request body cannot be raw bytes.** (s3) `PutObject` takes the caller's bytes with the
caller's content type. The only expressible form is a base64 field in a JSON envelope: a third
larger, unstreamable, and a different API from the one every S3 client speaks. No trait says "this
field is the body, sent raw".

The escape hatch that *does* work is worth noting, because it is the idiom to recommend if facet
never grows binary payloads: **presigned URLs**. A presign op is a JSON value describing a byte
transfer without performing one, so the bytes leave facet's world and the operation stays an
ordinary op on all four facets.

### Medium — a rough edge with a workaround

**F13/F14. Generating ops works; the type layer and the tool budget only half-follow.** (kubernetes)
This was the study's most uncertain question and it came out well: `f.app({ ops })` takes a plain
object, so a loop over a resource table produces 15 fully-projected ops, and adding a CRD adds five
operations across four facets with no new code. Two things do not follow:

- Handler input inference dies on a generic schema parameter. With
  `resourceOps<Spec extends z.ZodType>(kind, spec: Spec)`, tsc reports `Property 'spec' does not
  exist` in the handler. Runtime is unaffected; the typing that is facet's pitch is what is lost.
  The workaround is to erase to `z.ZodType` and narrow by hand.
- `facets.*.ops` override keys and `mcp.tools` groups are checked against op ids the generated
  tree no longer exposes as literals, so they need `as`. Grouping is also the only way to keep a
  generated surface inside `MCP_TOOL_BUDGET` (15) — and a group is a hand-written literal listing
  op ids, so the one part that cannot be generated is the part that has to grow with the generated
  surface.

**F3. The MCP tool budget is tight for one real service.** (github, kubernetes) Twelve ops is most
of the budget of 15 before a second service is in the picture. Grouping works and is the right
answer; it is just manual.

**F4. Free-form maps have no vocabulary.** (stripe, docker) `metadata`, `labels`, `docker run -e`:
open string→string maps are everywhere. `z.record` survives to JSON Schema and the SDK renders
`Record<string, string>`, but the CLI has no flag shape for arbitrary key/value (Stripe's own CLI
invented `-d "metadata[k]=v"`) and no trait marks a map as user-supplied-never-interpreted.

**F5. A union reaches the CLI as raw JSON.** (stripe) `stripe payment-intents confirm <id>
--payment-method '{"type":"card",…}'` is usable and is not what a CLI user expects.

**F2/CLI idiom. A tool's idiomatic command surface is a pile of overrides.** (docker) The
conventions give `docker containers list`, not `docker ps`. Each alias is one override, and a
tool's whole vocabulary (`ps`, `rm`, `rmi`, `exec`) trips the CLI override budget. Related, and
more interesting: real `gh` uses an ambient `--repo` defaulted from the working directory. facet
has no notion of a pervasive parameter with a context-supplied default, so every op repeats
`owner` and `repo` — `gh repos issues get <owner> <repo> <number>` where the real tool says
`gh issue view 42`.

**F6. Events can be polled, not delivered.** (stripe) The event *object* and an `events.list` op
model fine — Stripe has one. The push half (a subscription, a signed payload, a retry schedule) has
no facet to live on. Webhooks are on the backlog; this is what their absence costs on the API most
defined by them.

### Light — noted, no action suggested

**F7.** See defect 3 above (keys with slashes).
**F10.** Interactive `exec`; covered under streams.
**Group tool names bypass the naming convention.** A `configMaps` group key yields the MCP tool
`configMaps_admin` next to the derived `config_maps_changes_since`. Defensible — the author wrote
the key literally, as with `override.name` — but inconsistent.

## What fit better than expected

- **`idempotent` is exactly `kubectl apply`.** Declarative upsert is what the trait means, and one
  word gives it an `Idempotency-Key` over REST, an MCP `idempotentHint` and SDK retry safety — all
  correct for apply and all wrong for create. This is the clearest instance of "traits carry
  intent" paying off on a surface nobody designed them for.
- **`cost` expresses a second rate budget.** GitHub's search endpoint has a much lower limit than
  the rest of the API; `cost: 30` says so without a second plugin.
- **Non-CRUD verbs are better off here than under REST.** `search.issues` reads as a member of
  `search` and lands on `GET /search/issues` — GitHub's real route — with no override. An
  op-shaped core handles the verbs a resource-shaped one has to contort.
- **`t.money()` is Stripe's minor-units representation**, tagged and carried to every facet.
- **Field traits survive real schema composition.** `pii`, `sensitive` and `internal` came through
  `.pick()`, `.extend()`, `.partial()` and `.nullable()` across all six subjects; Stripe's internal
  `riskScore` is absent from every projection, and `pii` reaches the generated SDK as the JSDoc a
  consumer reads.

## Where the boundary actually sits

Before the study, the natural summary was "facet does request/response APIs". That is too broad in
one direction and too narrow in another.

Too broad: an API being request/response is not sufficient. S3 is request/response and does not fit,
because the payload is opaque bytes rather than a value with fields.

Too narrow: a tool being stream-shaped does not disqualify it. Docker is a streaming tool and its
request/response half — create, start, stop, remove, list, inspect, batch exec — is most of what a
script or an agent ever calls. The interactive half is what people use at a terminal, and that is
the half facet is not for.

The sharper statement: **facet fits an operation whose input and output are values.** Bytes,
subscriptions and sessions are the three things that are not values, and they are what every
subject that struggled has in common.

## Reproducing

```sh
cd examples/expressibility
node run-study.mjs                          # the table above
node check-sdks.mjs                         # every generated SDK typechecks
node probe-agreement.mjs                    # the four facets agree on a key containing '/'
pnpm exec omniface conformance src/linear.ts   # 71/71 on the control subject
pnpm exec omniface inspect src/github.ts repos.issues.get   # one op, four facets
```
