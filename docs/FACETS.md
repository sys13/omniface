# Writing a facet

A facet is a module. It declares what it does with an op, what a change to that means for its
own callers, and how it shows up in the inspector and the docs. Nothing in the core has to be
taught that it exists.

## Background: what it cost before format 2

That was not true under manifest format 1. `ManifestOp` carried one hand-written key per facet,
`Manifest.facets` repeated the same names as booleans, and `diff.ts` held 21 sites that named a
facet. Adding the web facet cost edits in six files. None of them was hard, which is exactly why
it mattered: the seventh facet would have cost the same six, forever. Format 2, described below,
is what replaced it.

## The contract

```ts
import { registerFacet, defineFacet, projectionOf } from 'omniface'

type ZapierProjection = { trigger: string; sample: Record<string, unknown> }

export const zapierOf = (op: ManifestOp) => projectionOf<ZapierProjection>(op, 'zapier')

export const zapierFacet = defineFacet<ZapierConfig, ZapierProjection, ZapierSettings>({
  name: 'zapier',
  defaultOn: false,
  normalize: (value) => (value === undefined || value === false ? null : value === true ? {} : value),
  project: ({ op, input }, config) => (op.traits.internal ? null : { trigger: op.id, sample: {} }),
  settings: (app, config) => ({ appId: config.appId ?? app.name }),
  diff: (before, after, { op }) =>
    before.trigger === after.trigger
      ? []
      : [{ level: 'breaking', rule: 'zapier-trigger-renamed', message: `${op}: trigger renamed.` }],
  present: (_ctx, projection) => ({
    label: 'Zapier',
    short: projection.trigger,
    line: `- Zapier: \`${projection.trigger}\``,
  }),
  summary: () => 'a Zapier connector',
  contract: (_ctx, projection) => (projection ? [] : ['no Zapier trigger']),
})

registerFacet(zapierFacet)
```

| Member | What it answers | Required |
| --- | --- | --- |
| `name` | The key in `facets` config, in the manifest and in a diff report | yes |
| `order` | Where the facet sorts in output — display order, not mount order. Lower first; unset sorts last | no |
| `defaultOn` | Whether the facet is on when the app says nothing about facets at all | yes |
| `normalize` | What the app wrote under `facets.<name>`, as this facet's config. `null` is off | yes |
| `project` | Given an op, what this facet does with it. `null` means it does not reach that op | yes |
| `settings` | What the manifest carries app-wide: a bin name, a mount path, a tool list | no |
| `references` | Which keys of the config are op ids, so a typo is caught at `app()` | no |
| `check` | Anything else the config must satisfy against the app's ops | no |
| `observes` | Which op traits a caller can see as behaviour here, and whether schema type names are published | no |
| `diff` | Given two projections of one op, what changed and whether it breaks *this* facet | no |
| `diffSettings` | The same question for what the facet carries app-wide | no |
| `present` | One card in the inspector and one line in `llms.txt` | no |
| `summary` | How `llms.txt` introduces the facet | no |
| `contract` | What the generated conformance suite checks, without calling anything | no |
| `serve` | How the facet mounts, **only if it is served**. Its `mountOrder` is the HTTP one: lower mounts first, and the first mount wins a route two facets both claim | no |

## The `serve` hook

`serve` is the only member with members of its own. A facet that has it is mounted by
`createServer`; a facet without it is skipped, and nothing in the core knows which is which.

| Member | What it answers | Required |
| --- | --- | --- |
| `mountOrder` | Where this facet mounts in the HTTP server. Lower mounts first, and Hono matches in registration order, so the first mount wins a route two facets both claim. Unset mounts last. Not `FacetModule.order`, which is display order | no |
| `create` | Given the app, the manifest and `options`, the thing that serves this facet's routes | yes |

The three served facets omniface ships claim `mcp: 0`, `web: 1`, `rest: 2`. The last two are the
case the numbers exist for: a screen route and a REST route can be the same route, and the screen
is meant to win.

An unset `mountOrder` sorts after every facet that sets one, the same way an unset
`FacetModule.order` sorts after every facet that asks. It read as `0` before, which put an
out-of-tree facet whose author had not thought about mount order level with `mcp` and left the tie
to registration order — and registration order depends on which import ran first, so the case with
the least thought behind it had the least defined answer. Mounting last is not a good place either;
it is a stated one. A facet with a route that may collide sets a number.

`create` is declared as returning `unknown`, and `createServer` casts the result to a Hono app
before mounting it. In practice that means a served facet returns a Hono app today — that is what
all three shipped ones do. Whether hono belongs on the facet-authoring surface at all, or whether
`create` should return a plain `(request: Request) => Response` that `createServer` adapts, is an
open question and not yet decided. Until it is, a facet that returns something else fails at
runtime inside `createServer`, with a hono error that does not name the facet.

`options.security` is typed `false`, which is the only value it has ever carried. `createServer`
mounts CORS, CSRF and the security headers once at the root, where they cover MCP over HTTP and the
inspector too, and the flag is how it tells a facet not to apply them a second time. A facet that
applies security of its own reads it; one that does not can ignore it. `createRestApp` is the
worked example: called directly it reads `facets.rest.security`, and called through `serve.create`
it is handed `false` and defers to the root.

It was `boolean` before. Nothing passed `true`, and nothing could have: `true` is not in
`RestAppOptions`' `SecurityConfig | false`, so the one place the value crossed that boundary cast
it back to `false` to keep the compiler quiet. Widening it to `SecurityConfig | false` would have
matched the type on the other side, but it would also have described a facet mounting security
after the root already did — a thing the server does not do and would be wrong to start doing
here. The one-valued flag is the honest shape.

## A facet that is not a server

`sdk`, `cli` and `events` have no `serve` hook. `sdk` and `cli` run in another process, on nothing
but the manifest, which is why a projection has to travel as data rather than as behaviour.
`events` is a declaration that other things read: an op says what it emits, and a transport that
carries those events reads the catalog rather than being told again. A facet without a server is
not a lesser facet; it is three of the six that ship.

## What a facet may not do

A facet projects and presents. It never decides whether an op runs. The pipeline
(`app.invoke`) is facet-agnostic on purpose and stays that way: the facet name reaches a handler
as `args.facet`, for attribution, and the authorize stage does not read it. The same rule the
plugin `adapters` slot has, for the same reason — it is what makes opening this up safe.

## Reading a manifest

Per-op projections and app-wide settings are both records keyed by facet name:

```jsonc
{
  "facet": 2,
  "facets": { "rest": {}, "cli": { "binName": "acme" } },   // absent means off
  "ops": [{ "id": "tasks.get", "facets": { "rest": { … }, "cli": { … } } }]
}
```

A facet reads its own slot back with the accessor it exports — `restOf(op)`, `cliSettings(manifest)`
— which is what the call sites in this repo use. `projectionOf` and `settingsOf` are what those
accessors are made of. A manifest carrying a facet the reader has never heard of still round-trips,
and `omniface diff` still reports the facet appearing, disappearing and reaching an op; only that
facet's own rules are missing.

Manifest format 1 carried `rest`, `mcp`, `cli`, `sdk` and `web` as keys beside the op's own fields,
with booleans in `facets`. Format 2 is what is written above.

## Type-level configuration

`FacetsConfig` is an interface so a facet can add its own key:

```ts
declare module 'omniface' {
  interface FacetsConfig {
    zapier?: boolean | ZapierConfig
  }
}
```

Nothing at runtime reads those keys — `normalizeFacets` walks the registry — so the augmentation is
for autocomplete and for catching a typo, not for the facet to work.

## What this does not cover yet

The generated conformance suite's **contract** check grows with a new facet; its **live channels**
do not. `CHANNELS` in `packages/testing/src/harness.ts` is still a hand-written list of five, and
each entry is a driver that knows how to call an op over that protocol. A new facet reaches the
contract check by landing and reaches the live cases only by teaching the harness how to call it.
That is a real gap, and it is the honest limit of what "lands once" currently means.

The `lint` override budget also still needs a per-facet entry to opt in; a facet without one is
simply not budget-checked rather than being a hole in the loop.
