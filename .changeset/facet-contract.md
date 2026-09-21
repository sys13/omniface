---
'omniface': minor
'@omniface/client': minor
'@omniface/cli': minor
'@omniface/testing': minor
---

A facet is a module now, not a set of keys the core knows about. See [FACETS.md](../docs/FACETS.md).

`ManifestOp` used to carry one hand-written key per facet, `Manifest.facets` repeated the same five
names as booleans, and `diff.ts` held 21 sites that named a facet. Adding the web facet cost edits
in six files — none of them hard, which was the problem, because the next one would have cost the
same six.

A facet now declares a projection (given an op, what this facet does with it, or `null`), a diff
contract (given two projections, what changed and whether it breaks *this* facet), a presentation
(one line for `llms.txt`, one card in the inspector), a contract check the generated conformance
suite runs, and a `serve` hook only if it is served — `sdk` and `cli` have none. The five omniface
ships are written against exactly that contract, and nothing in `manifest.ts`, `inspect.ts`,
`diff.ts`, `build.ts`, `server.ts` or `@omniface/testing` names a facet.

**Breaking, for anything that reads a manifest or the inspection JSON.**

- The manifest format is **2**. Per-op projections live in `op.facets`, keyed by facet name, and
  what a facet carries app-wide lives in `manifest.facets.<name>` — so `manifest.facets.cli` is
  `{ binName }` rather than `true`, and a facet that is off has no key at all. `manifest.cli`,
  `manifest.sdk`, `manifest.web` and `manifest.mcpTools` are gone; `mcpTools(manifest)` replaces the
  last of them. A manifest carrying a facet the reader has never heard of now round-trips.
- Read a facet's slot with the accessor that facet exports: `restOf(op)`, `cliOf(op)`, `mcpOf(op)`,
  `sdkOf(op)`, `webOf(op)`, and `cliSettings`, `sdkSettings`, `webSettings`, `mcpSettings` for the
  app-wide half.
- `OpInspection` carries `facets`, a record of `{ label, short, snippet, line }` per facet, in place
  of its `rest`/`sdk`/`cli`/`mcp`/`web` keys. `omniface inspect` and the inspector render that
  record, so a facet appears in both by landing.
- `FACET_KEYS` is gone and `FacetKey` is now `string`. Ask the registry: `facetModules()`.
- `FacetsConfig` is an interface, so a facet can add its own key by declaration merging.

One behaviour change in `omniface diff`: marking an op `destructive` is breaking on every facet that
turns the trait into behaviour a caller runs into — the CLI prompt and the screen's question — not
on the CLI alone.
