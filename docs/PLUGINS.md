# Writing a facet plugin

A plugin is how a cross-cutting concern — auth, rate limits, logging, tracing, idempotency, audit —
is added to an app **once** and appears on every facet. That is the whole bargain: you write one
object, and REST, the SDK, the CLI and MCP all change together, because every facet reaches a
handler through `app.invoke` and nothing else does.

This page is the authoring guide: the shape, the slots, the rules, and how to prove a plugin keeps
them. The starting point to copy is [`examples/plugin-template`](../examples/plugin-template).

```ts
import { definePlugin } from 'omniface'

export function usage() {
  return definePlugin({
    name: 'usage',
    hooks: { after: (inv) => count(inv.op.id) },
  })
}
```

Install it like any other:

```ts
const f = facet({ plugins: [logging(), usage()] })
```

## The shape

| Slot | What it is | Runs |
| --- | --- | --- |
| `name` | Identity. Unique per app; it is also the plugin's REST namespace | — |
| `requires` | Plugin names that must be installed *before* this one | startup |
| `hooks` | One function per pipeline stage | every call, every facet |
| `wrap` | A function around the whole pipeline (logging, tracing, audit) | every call, every facet |
| `ops` | Operations the plugin contributes, projected like the app's own | — |
| `adapters` | The per-facet slot: presentation only | per facet |
| `traits` | Op trait keys this plugin reads, for docs and the inspector | — |
| `Ctx` (type param) | What the plugin adds to `ctx` for handlers | — |

### Hooks and the pipeline

The stages, in order. A hook may read and change the invocation; `handle` is the op's and is not
open to plugins.

| Stage | For |
| --- | --- |
| `authenticate` | Work out who is calling — set `inv.principal` |
| `resolveTenant` | Resolve the tenant into `ctx` |
| `rateLimit` | Refuse a caller who is asking too often |
| `validate` | After the input has been parsed: derived context, input-dependent checks |
| `authorize` | Decide whether this caller may run this op |
| `idempotency` | Replay a previous answer instead of running the op again |
| *handle* | The op's handler. Not a plugin slot |
| `after` | Once there is an output: counting, emitting, cleanup |

A hook that throws a `FacetError` ends the call, and every facet renders it the same way. A hook
may also call `inv.respond(output)` to answer without running the handler — that is how an
idempotency replay works — and the stages after it are skipped.

`wrap` is for anything that needs to see both sides of the call: it receives the invocation and a
`next()` and is responsible for calling it. Earlier plugins wrap later ones.

### Ops

Ops a plugin contributes are ops. They project onto every facet by the same conventions, carry
traits, appear in the manifest and OpenAPI, and run the same pipeline — including this plugin's own
hooks. `apiKeys()` contributes `auth.whoami` and `apiKeys.*` this way.

If a contributed op declares a `scope`, the app will refuse to start unless some plugin fills the
`authorize` stage. That is Gate 1 doing its job, not a bug.

## The `adapters` slot

Some plugin concerns really are per-facet: a credential arrives as a header on REST, as an env var
on the CLI, as a constructor option in the SDK, and as transport metadata on MCP. `adapters` is
where that is expressed — **the only place a plugin may touch a facet.**

```ts
definePlugin({
  name: 'sessions',
  adapters: {
    rest: {
      credential: (request) => cookieToken(request),
      routes: [{ method: 'POST', path: '/login', handler: login }], // served at /_sessions/login
      headers: ({ ok }) => (ok ? { 'x-sessions': 'live' } : undefined),
      securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'session' } },
    },
    mcp: { instructions: 'Log in first.', client: (ctx) => nameFrom(ctx.headers) },
    cli: {
      flags: [{ name: 'session', summary: 'A session token', env: 'ACME_SESSION', credential: true }],
      commands: [{ command: 'whoami', summary: 'Show who you are', op: 'auth.whoami' }],
    },
    sdk: { options: [{ name: 'sessionToken', summary: 'A session token', header: 'x-session', credential: true }] },
  },
})
```

### The one rule: an adapter may not decide whether an operation runs

That decision is Gate 1, and it belongs to the pipeline, where it applies to all four facets at
once and the conformance suite can see it. Nothing in `adapters` receives an `Invocation`, and
nothing in it can abort, skip, replace or re-order one. What an adapter may do is:

- **find** a credential the facet's default reader misses — what the credential *means* is still
  the `authenticate` stage's business, so returning a token grants nothing;
- **attribute** a caller, for logs and audit — metadata, never authority;
- **add** routes, commands, flags and options of its own, *next to* the ops, never in front of one;
- **decorate** what the facet has already decided: response headers, OpenAPI security schemes,
  MCP instructions.

If a facet adapter looks like a convenient place to reject a call, that is the signal it is drift:
put it in `hooks.authorize` (or `rateLimit`, or `idempotency`) instead.

### Typed slot reference

Every type below is exported from `facet`.

**`RestFacetAdapter`** — runs in the server process.

| Member | Type | Notes |
| --- | --- | --- |
| `credential` | `(request: Request) => Credential \| undefined` | Consulted only when `Authorization` / `X-API-Key` found nothing |
| `routes` | `RestPluginRoute[]` | `{ method, path, summary?, handler }`, mounted at `/_<name><path>` |
| `headers` | `(ctx: RestResultContext) => Record<string, string> \| void` | `ctx` is `{ request, op, requestId, status, ok }`; runs on success and on failure |
| `securitySchemes` | `Record<string, SecurityScheme>` | Merged into OpenAPI `components.securitySchemes` |

A route handler gets `RestRouteContext` (`{ request, url, params, requestId }`) and returns a
`Response`. It is not an op: if it needs to *do* something the app knows about, it should call
`app.invoke`, which runs the whole pipeline like any other facet.

**`McpFacetAdapter`** — runs in the server process.

| Member | Type | Notes |
| --- | --- | --- |
| `credential` | `(ctx: McpCallContext) => Credential \| undefined` | `ctx` is `{ headers?, clientInfo?, transport }` |
| `client` | `(ctx: McpCallContext) => { name?, version? } \| undefined` | Attribution when the transport cannot say |
| `instructions` | `string` | Appended to the MCP server's instructions |

**`CliFacetAdapter`** and **`SdkFacetAdapter`** — declarations, not behaviour.

The CLI is the shared engine plus a manifest, and the SDK is a client package; neither runs in the
server's process, so a plugin *declares* what it adds and the manifest (`manifest.adapters`)
carries the declaration to wherever the facet runs.

| Member | Type | Notes |
| --- | --- | --- |
| `cli.flags` | `CliFlagSpec[]` | `{ name, summary, type?, env?, credential? }`. Shown in help; a `credential` flag is sent as a bearer token. May not shadow a built-in (`RESERVED_CLI_FLAGS`) |
| `cli.commands` | `CliCommandSpec[]` | `{ command, summary, op }` — an alias for an op, never a side door around one |
| `sdk.options` | `SdkOptionSpec[]` | `{ name, summary, type?, header?, credential? }`. May not shadow a built-in (`RESERVED_SDK_OPTIONS`) |

Everything checkable is checked when the app is created: a flag that shadows a global one or
another plugin's, a command that names an op the app does not have or shadows one the app already
answers to, a route outside its namespace, a duplicate — all of them are startup errors, not
surprises in production. `adapterProblems()` is the same check,
exported, if you want it in your own tests.

## Proving it: the conformance kit

`@omniface/testing` ships the cases a plugin has to pass, run against a sample app on every facet:

```ts
import { pluginCases } from '@omniface/testing'
import { describe, expect, it } from 'vitest'

for (const c of pluginCases({ plugin: () => usage() })) {
  it(c.name, async () => expect(await c.run()).toEqual([]))
}
```

What it checks:

| Case | What it means |
| --- | --- |
| installs, and the app still projects to every facet | Installing you did not remove a facet or an op |
| is shaped like a plugin | A usable name, hooks only in real stages, adapters that pass their own validation |
| refuses to be installed twice | Names are unique; two instances are a mistake worth catching |
| says what it requires | `requires` is honest — without it, installation is refused and the message names what is missing |
| every facet agrees on every op | The drift check, with the plugin installed |
| leaves the app's own answers alone | Installing a plugin an app does not use changes nothing it answers |
| refuses an anonymous caller the same way on every facet | For a plugin that authenticates (`deniesAnonymous: true`) |
| projects the ops it contributes onto every facet | Contributed ops are ops |
| stays inside the adapters slot | Routes are namespaced, mounted, and shadow no op; commands name real ops |

Options: `before` (the plugins yours requires), `app` (your own app instead of the sample one),
`apiKey`, `deniesAnonymous`, and `scope` (make every sample op declare a scope, for a plugin that
authorizes). `runPluginConformance()` is the same suite outside a test runner.

The kit checks that facet's promises survive your plugin. It cannot check what your plugin is
*for* — that is still your own tests, next to it.

## Conventions for a published plugin

- **Export a factory, not an instance.** `myPlugin(options)`, so two apps never share state.
- **Name it after the concern**, lowercase and dash-separated. The name is the REST namespace and
  shows up in `ctx.auth.adapter`-style diagnostics and error messages.
- **Type the context.** `definePlugin<{ myThing: Thing }>` is what makes `ctx.myThing` typed in
  every handler of an app that installs you.
- **Say what you require.** `requires: ['auth']` fails at startup with a message rather than at 3am
  with a stack trace.
- **Put decisions in hooks, presentation in adapters.** The split is the whole design.
- **Peer-depend on `facet`**, don't bundle it — one copy of the pipeline per app.
- **Ship the conformance test.** It is eight lines and it is the difference between "it works here"
  and "it works".
