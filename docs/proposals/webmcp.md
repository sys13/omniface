# Proposal — WebMCP

**Question:** should facet support WebMCP — the browser-side API where a web page registers tools
for an agent running in the browser — and if so, what shape would it take?

**Recommendation: build later.** Not as a facet. Ship the ~30-line userland recipe now as an
example, make the two small core changes that stop it lying to the audit log, and promote it to
real work when the Chrome origin trial graduates and a second consumer exists.

Scored with [CRITERIA.md](../CRITERIA.md): `L1 C1 D1 T1 B1 E2` = **7 → maybe**, with an external
promotion trigger. Reasoning at the end.

---

## 1. What WebMCP actually is

A web page registers named, described, JSON-Schema'd functions on the document. An agent running
inside the browser — today, Gemini in Chrome — lists them and calls them. The tool body is ordinary
page JavaScript: it can touch the DOM, read app state, or `fetch` the site's own backend.

```js
await document.modelContext.registerTool({
  name: 'create_task',
  description: 'Create a task for the signed-in user.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  annotations: { readOnlyHint: false, consequentialHint: true },
  async execute(input, { signal }) { /* page code */ },
})
```

Alongside `registerTool` the spec has `getTools()` and `executeTool()`, `toolchange` /
`toolactivated` / `toolcancel` events, an `exposedTo` origin filter on registration, and a
declarative form-annotation variant in Chrome's implementation. The API is gated by a `tools`
permissions policy (default `self`, so a cross-origin iframe needs `allow="tools"`), requires a
secure context, and is disabled in documents that opted out of origin isolation via
`document.domain`.

The tool descriptor is, deliberately, an MCP tool descriptor: same `name` / `description` /
`inputSchema`, same `readOnlyHint` family of annotations, plus two WebMCP additions —
`untrustedContentHint` and `consequentialHint`.

### Maturity — say it plainly

It is an **incubation-stage proposal with one implementation, behind a time-limited flag.**

- **Spec status:** Draft Community Group Report from the W3C Web Machine Learning Community Group,
  latest draft 17 September 2026. A CG report is explicitly *not* a W3C standard and is *not* on
  the standards track. Editors come from Google and Microsoft.
  ([spec](https://webmachinelearning.github.io/webmcp/),
  [repo](https://github.com/webmachinelearning/webmcp))
- **Browser support:** Chrome only. A behind-a-flag developer preview earlier in 2026, then a
  public origin trial from Chrome 149 — meaning a site must serve a per-origin token that expires,
  and reported end-of-trial dates fall in November 2026.
  ([Chrome docs](https://developer.chrome.com/docs/ai/webmcp),
  [origin trial](https://developer.chrome.com/blog/ai-webmcp-origin-trial),
  [InfoQ, June 2026](https://www.infoq.com/news/2026/06/webmcp-web-agent-standard-chrome/))
  No shipping implementation in Firefox or Safari. Multi-vendor *participation* in the CG is not
  multi-vendor *implementation*.
- **The API moved during the trial.** The spec now defines `document.modelContext`; Chrome's own
  docs still mention both `document.modelContext` and `navigator.modelContext`, and secondary
  reporting describes a mid-trial migration from the navigator surface to the document surface with
  a deprecation window. Whatever the exact schedule, the surface changed under the feet of early
  adopters within one trial. Treat every name here as provisional.
- **Consumers:** essentially one — Gemini in Chrome. There is an unofficial polyfill and
  MCP-bridging work under the `WebMCP-org` (MCP-B) organisation, which also converts between the
  page API and MCP proper.

The open spec discussions are not cosmetic either: multimodal I/O, streaming, output schemas and
service-worker integration are all still being argued. This is not a stable target.

### How it relates to MCP proper

Same tool vocabulary, opposite execution location. MCP proper is agent → server, bypassing the web
UI. WebMCP is agent → page, *inside* the UI, so the agent and the user share state and the user can
watch it work. The README for the proposal is explicit that this is the point: reuse the
client-side code that already exists rather than duplicate it on a server.

That difference is the whole design question for facet.

---

## 2. Is it a facet?

**No.** It is a *client* of the REST facet that happens to advertise MCP-shaped descriptors.

A facet in this codebase is a projection of the definition that terminates in `app.invoke` —
REST, MCP over stdio, MCP over Streamable HTTP, the CLI engine and the SDK all reach the pipeline,
in-process or over HTTP. stdio and Streamable HTTP are two transports of *one* facet precisely
because both end in `app.invoke` on the server (`packages/omniface/src/facets/mcp.ts`).

A WebMCP tool cannot end there. Its body runs in a browser tab. The only way it reaches an
operation is by making an HTTP request to the server — which is the REST facet, or `@omniface/client`
on top of it. So WebMCP is not a new terminus; it is a new *caller*, in the same category as the
CLI engine or the inferred client. It is closer to "a second thing that reads the manifest" than to
"a fifth facet".

That framing is also what makes it cheap. Everything WebMCP needs already exists as an output:

- `manifest.mcpTools` — name, description, input schema, annotations, and the op ids each tool
  dispatches to — computed by `buildManifest` and written to `.omniface/manifest.json` by
  `omniface build` (`packages/omniface/src/manifest.ts`, `build.ts`).
- `createCaller({ baseUrl, manifest }).call(id, input)` — a generic op dispatcher that already
  builds the right HTTP request from the manifest, sets `X-Facet-Client` and `X-Facet-Via`, mints
  idempotency keys for `idempotent` ops and retries `readonly` ones
  (`packages/client/src/index.ts`).
- Same-origin cookies, because `fetch` defaults to `credentials: 'same-origin'`.

**Consequence worth stating loudly: facet already supports WebMCP today, in userland, with no core
change.** The whole of it is:

```ts
// browser bundle
import { createCaller } from '@omniface/client'
import manifest from './manifest.json' with { type: 'json' }

const caller = createCaller({ baseUrl: '/api', manifest, via: 'webmcp' })

for (const tool of manifest.mcpTools) {
  await document.modelContext.registerTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.annotations.readOnlyHint,
      consequentialHint: tool.annotations.destructiveHint,
    },
    execute: (input) => {
      const opId = tool.ops.length === 1 ? tool.ops[0] : pickAction(tool, input)
      return caller.call(opId, input)
    },
  })
}
```

Every MCP override the author already wrote — tool names, descriptions, `maxItems`, grouped
intent-level tools, hidden `internal` fields — carries over unchanged, because it is all baked into
`mcpTools`. Author tax for the happy path: zero.

**If it were built into the core**, the right shape is a `@omniface/client/webmcp` entry point
(`registerWebMcpTools({ caller, manifest, ... })` returning an unregister handle), **not** a
`facets: { webmcp: true }` key. A facets key would promise something facet cannot deliver: the
definition does not control the browser bundle, and turning a flag on in `app.ts` cannot make a
page register anything. A `webmcp` facets key that only filters which tools get advertised, while
the actual registration lives in the app's frontend, is a misleading API.

### The thing that must not happen

The obvious temptation is to let a WebMCP tool do something the REST facet does not expose — read
DOM state, fill the form the user is looking at, navigate. That is exactly the value WebMCP's own
README advertises, and it is exactly the drift facet exists to stop: the moment a tool body
contains behaviour that is not an op, the definition is no longer the single source and the
browser agent sees a different app than the CLI does.

The line to hold: **facet generates tools for ops, and only for ops.** A page that also wants
DOM-shaped tools calls `document.modelContext.registerTool` itself, next to facet's registration,
and owns them. facet should not pretend those are part of the contract, should not try to model
them, and should say so in the docs rather than leaving it to taste.

---

## 3. Gate 1 — a facet may not decide whether an operation runs

WebMCP passes this gate more comfortably than any existing facet, and then introduces one subtle
way to fail it.

**Why it passes:** the tool body is an HTTP call. `authenticate → resolveTenant → rateLimit →
validate → authorize → idempotency → handle → after` runs on the server, unchanged, exactly as it
does for a `curl`. A browser cannot skip a stage because it never touches the pipeline; it queues
up behind it. There is no facet adapter to write and nothing new that could abort, replace or
re-order an invocation. This is the mechanical benefit of WebMCP being a caller rather than a
facet.

**Where it could fail:** by putting policy in the registration list. "Don't register `tasks.delete`
for the browser agent" is a presentation decision about what is *advertised*. It is not, and must
never be, the mechanism that stops the agent calling it — a page's registration list is client-side
data, an XSS or a curious user can call the REST endpoint directly, and a filter in the browser is
security theatre.

So the rule is the usual one: **advertise from a declaration, refuse from the pipeline, and derive
both from the same source.** If an app decides that agents with ambient cookie authority may not
run destructive ops, that is an `authorize` hook keyed on the invocation, and the registration
filter reads the same declaration so the two cannot drift. A conformance case proves it: *an op not
advertised over WebMCP is refused when called over WebMCP.*

That in turn needs the invocation to know it came from a browser agent — see below, and note that
this knowledge is a **claim**, so it can narrow authority but must never widen it.

---

## 4. Auth — the crux

This is where the proposal earns or loses its keep.

Every facet facet has today carries an explicit credential: an `Authorization` header, an SDK
constructor option, `--api-key` or the MCP server's env, resolved by `AuthAdapter`s in the
`authenticate` stage. A WebMCP tool has none. It is a same-origin `fetch` from a page the user is
already signed in to, so the request carries **the session cookie**, and the spec says so in as
many words: agents inherit user identity and authentication from the browser.

Five consequences, in order of how much they should worry us.

**1. The agent gets the user's entire authority.** `scopes()` cannot narrow anything, because the
principal *is* the user and the user's scopes are the user's scopes. An API key minted with
`tasks:read` is a meaningfully different grant from "whatever Alice can do". Today, every
capability the app has is one natural-language instruction away from a browser agent, and
`consequentialHint` is advisory — it asks the agent to confirm, it does not make the server refuse.
This is not a facet bug; it is the WebMCP threat model, and an app adopting it is accepting it.
facet's job is to make that acceptance explicit rather than incidental.

**2. The right fix is attenuation, and it is blocked.** What we actually want: the page asks the
server for a short-lived, scope-narrowed, agent-purposed token, and the tool body sends *that*
instead of leaning on the cookie. The agent then holds a strictly weaker credential than the user
whose tab it is sitting in, and everything downstream — scopes, rate limits, audit — works the way
it already does for API keys. That is precisely backlog **2.6, per-facet auth presentation**, which
is open and waiting on the `adapters` slot from **3.1**. Minting attenuated tokens is a plugin
concern (`auth`, or a dedicated one) with a REST route to mint on and an SDK option to carry —
both of which are `adapters` slots that do not exist yet. **Building WebMCP before 3.1 and 2.6
means shipping the cookie-authority version and calling it done, which is the wrong first
impression to make.**

**3. CSRF is already handled, and must not be relaxed.** `securityMiddleware` refuses
state-changing requests from an origin that was not named, and treats an origin trusted by CORS as
trusted by CSRF, never `*` (`packages/omniface/src/facets/security.ts`). Same-origin page to
same-origin API: allowed, correctly, because it is same-origin. A page on `app.acme.com` calling
`api.acme.com` needs the origin named in `security.cors` with `credentials: true` and the caller
using `credentials: 'include'` — which is the existing, documented path. **Nothing about WebMCP
requires loosening these defaults, and any design that seems to is wrong.** Worth a test that
pins it.

**4. Attribution is weaker than MCP's, and must be labelled as such.** `mcp.ts` goes to real
trouble to make an HTTP audit record identical to a stdio one, and the comment there is the
governing principle: *naming yourself grants nothing.* Over WebMCP the server sees an ordinary
browser request; the only honest signal is `X-Facet-Via: webmcp` plus an `X-Facet-Client` naming
the agent — a claim made by the page, about an agent the page does not control, and therefore
weaker than stdio `clientInfo`. It is still worth having: `audit` exists to record the agent behind
a call, and "a browser agent did this" is exactly the fact an audit log should carry. Two small
core changes make it truthful:

- `facetFromHeaders` in `packages/omniface/src/facets/http.ts` currently allowlists `'sdk' | 'cli'`
  and silently falls back to `'rest'`. A WebMCP call is recorded today as plain REST. Adding
  `'webmcp'` is a few lines; `FacetName` is already open (`(string & {})`), so nothing else needs
  to move.
- `createCaller`'s `via` option already accepts any string, so the client side is free.

**5. Outputs leave the trust boundary.** Whatever a tool returns goes into the agent's context, and
the agent may be a third party (Gemini in Chrome). facet knows which fields are `pii` and
`sensitive` and already redacts and masks per facet. Whether `sensitive` should mask *harder* for a
browser agent than for REST is a real per-facet presentation question this proposal does not
answer, and a reason to design it deliberately rather than inherit REST's answer by accident.

---

## 5. Other security implications

- **Prompt injection through outputs.** WebMCP has `untrustedContentHint` for "do not treat this
  output as instructions". facet has no trait that means "this op returns user-generated content",
  so nothing sets it. An op returning a task title a stranger wrote is an injection vector and the
  agent has no way to know. A field or op trait could fix this; it does not exist.
- **The tool list is a public description of the app.** Anything registered is legible to any
  visitor's agent. `internal: true` ops must never register — enforce it in the generator, not by
  convention, and cover it in conformance.
- **XSS gets worse.** Script running on the page can register a tool whose description lies about
  what it does, and the agent will call it. facet cannot fix this and should not claim to; the
  closed default CSP in `securityMiddleware` helps for facet's own HTTP responses, and the honest
  thing is to name the risk in the docs.
- **Rate limits are the real backstop.** An agent loops faster than a human. `rateLimit()` is
  cost-aware and applies to every facet already, so this works — but the cost model was tuned for
  human and API-key traffic, and browser-agent traffic is a different shape.
- **Origin isolation and permissions policy.** WebMCP needs an origin-isolated secure context and
  is gated by the `tools` permissions policy. If facet ever serves the page (it does not today —
  Gate 5: UIs are maxstack's job), the inspector at `/_omniface` would be the only candidate, and
  that is a dev-loop toy, not a reason to build.

---

## 6. What would have to be built

Sized as in [BACKLOG.md](../BACKLOG.md): **S** ≈ hours, **M** ≈ days, **L** ≈ a week or more.
Ordering matters: W1 is safe today, W2–W3 want 3.1 and 2.6 first.

| ID | Story | Size | Verdict | Depends on |
| --- | --- | --- | --- | --- |
| W1 | Worked example + recipe: register `manifest.mcpTools` from a browser bundle over `@omniface/client`, in `examples/tasks`, with the "only ops, never DOM tools" rule written down. No core change. | S | maybe | — |
| W2 | `X-Facet-Via: webmcp` end to end: widen `facetFromHeaders`, thread `'webmcp'` through logging and audit, and pin the claim-not-authority rule with a test. | S | maybe | — |
| W3 | `@omniface/client/webmcp`: `registerWebMcpTools({ caller, manifest, exclude?, exposedTo? })` returning an unregister handle. Maps MCP annotations to WebMCP's (`destructiveHint` → `consequentialHint`), skips `internal` ops, handles grouped tools and `maxItems`, and cancels via `AbortSignal`. | M | maybe | W1, W2 |
| W4 | Advertise-and-refuse from one declaration: a per-op or trait-level statement of what a browser-agent caller may do, read by the registration filter *and* by an `authorize` hook, so the browser filter is never the enforcement. | M | maybe | W3, 3.1 |
| W5 | Attenuated agent credential: a plugin route that mints a short-lived scope-narrowed token for in-page agent use, carried by the caller instead of the ambient cookie. The actual fix for §4. | L | maybe | 3.1, 2.6 |
| W6 | Conformance cases for the browser-agent caller: an op not advertised is refused; `internal` never registers; `pii` / `sensitive` redaction matches the other facets; CSRF defaults hold. | M | maybe | W4 |
| W7 | Untrusted-output trait → `untrustedContentHint`, plus whatever it should mean for the MCP facet (which has the same problem and has been living with it). | S | maybe | W3 |

Roughly: W1+W2 is a day and carries most of the demo value. W3–W6 is the real feature and is
gated on E3.1 landing. W5 is the one that makes this defensible for real traffic.

---

## 7. Recommendation — build later

> **Superseded 2026-09-19 — promoted to [BACKLOG E12](../BACKLOG.md#e12--web-facet).**
> This section's reasoning still describes the state of the spec correctly, and the risks in §4
> and §5 are all still real and all still have to be paid. What changed is not a trigger going
> off but the architecture underneath the argument: facet is now building a web facet, so it
> serves the page and owns the bundle. Objections 2 and 3 above — "the recipe is thirty lines of
> userland", "registration lives where the definition cannot see it" — were both premised on
> facet never serving a page, and §5's origin-isolation note says as much in passing. W1–W7 move
> into E12 as 12.6–12.10, keeping the ordering rule this section argued for: the attenuated
> credential (W5 → 12.8) lands before the feature is called supported. Read what follows as the
> reasoning that was overturned, and as the list of things E12 must not get wrong.

**Don't build it now. Do W1 and W2 opportunistically, and set an explicit promotion trigger.**

The reasoning, in order of weight:

1. **The target is moving.** A CG draft, not on the standards track; one implementation; behind a
   per-origin token that expires; the API surface renamed mid-trial; streaming, output schemas and
   service-worker integration still open questions. Building `@omniface/client/webmcp` now means
   maintaining a shim against a spec that has already proved it will move, for an audience of one
   browser channel.
2. **The architecture already answers the question.** Because WebMCP is a caller rather than a
   facet, and because `mcpTools` and `createCaller` are both already outputs, the userland recipe
   is thirty lines. That is a strong result — it is the thesis working — and it means the core gets
   nothing structural from building this, only maintenance. "You can already do this, here is the
   example" is the right answer while the spec settles.
3. **Shipping it before 2.6 would ship the wrong default.** Without attenuated credentials, facet's
   WebMCP support would hand a browser agent the user's entire authority and describe it as a
   supported surface. facet's whole pitch is that one declaration behaves the same everywhere; an
   interface where scopes silently stop narrowing is not the same everywhere. Fix 3.1 and 2.6
   first, then this is a small feature rather than a caveat with a feature attached.
4. **It is not a drift risk in the meantime.** The pipeline runs regardless of who calls. The only
   drift hazard is in-page tools that are not ops, which is a documentation problem W1 solves for
   free.

Score, for the record — `L1` (one surface, reusing an existing projection), `C1` (supports the
thesis, but the MCP facet already proves the same point), `D1` (prevents no drift, and introduces
one to police), `T1` (a new entry point and a new auth question), `B1` (days for the honest
version), `E2` (opt-in; an app that never calls the function is unaffected) = **7, maybe**.
Consistent with `A2A` at 4 and `Zapier / n8n connector` at 6: this is a real but externally-paced
idea, and its pacing is not ours.

**Promotion triggers — any two, promote to a `want` row in E3 or E5:**

- The Chrome origin trial graduates to a shipped, unflagged API with a stable surface name.
- A second browser engine ships an implementation, or the spec moves to the W3C standards track.
- A second agent besides Gemini in Chrome consumes WebMCP tools.
- Backlog **3.1** and **2.6** land, making the attenuated-credential story (W5) writable.
- A real user asks for it against a real app.

**Where it would live when promoted:** E5 (SDK distribution) rather than a new epic — it is a
browser entry point on `@omniface/client` and a manifest consumer, which is what E5 is about. W4–W6
reference E3's `adapters` slot but do not extend it; nothing here needs a new plugin hook.

---

## Sources

- [WebMCP specification](https://webmachinelearning.github.io/webmcp/) — Draft Community Group
  Report, 17 September 2026
- [webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp) — explainer, open
  issues, security and privacy considerations
- [WebMCP | AI in Chrome | Chrome for Developers](https://developer.chrome.com/docs/ai/webmcp) —
  imperative and declarative APIs, origin isolation, `tools` permissions policy, Chrome 149
- [Join the WebMCP origin trial](https://developer.chrome.com/blog/ai-webmcp-origin-trial) — Chrome
  origin trial announcement
- [WebMCP Standard Proposal for Agentic Web Actuation Now Available in Chrome (Origin Trials)](https://www.infoq.com/news/2026/06/webmcp-web-agent-standard-chrome/) —
  InfoQ, June 2026
- [WebMCP-org (MCP-B)](https://github.com/WebMCP-org) — `document.modelContext` polyfill and
  WebMCP ↔ MCP bridging

Origin-trial end dates and the `navigator.modelContext` → `document.modelContext` migration
schedule come from secondary reporting and were not confirmed against a first-party Chrome
announcement; the direction (the surface moved to `document`, the trial is time-limited) is
confirmed by the spec and Chrome's own docs, the exact dates are not.
