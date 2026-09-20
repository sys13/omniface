# Plugin template

A facet plugin with every slot filled, and the tests that prove it behaves. Copy the directory,
rename, and replace the behaviour — the structure is the point, not the counting.

```
src/index.ts                 the plugin: hooks, a contributed op, the per-facet adapters slot
test/conformance.test.ts     the generated kit, plus what the plugin is actually for
```

`usage()` counts how often each operation is called and answers three ways: an op
(`usage.summary`, which every facet gets), a REST route of its own (`/_usage/summary.json`), and an
`x-usage-op` response header. It shows, in one small file:

- **`hooks`** — `after` counts a call once it has been answered; `validate` puts a typed helper on
  `ctx`. Both run for every facet, because the pipeline is where facet-agnostic decisions live.
- **`ops`** — a contributed op is an op: conventions, traits, manifest, OpenAPI, all four facets.
- **`adapters`** — the per-facet slot. Presentation only: a route beside the ops (never in front of
  one), a response header, MCP instructions, a CLI alias for the contributed op.

## Running it

From the repository root:

```sh
pnpm build
pnpm exec vitest run examples/plugin-template
```

## Making it yours

1. Rename the factory, the plugin `name` and the package. The name is also the plugin's REST
   namespace (`/_<name>/…`), so keep it URL-safe.
2. Replace the hook bodies. Decisions about *whether* an op runs belong in `authorize`, never in an
   `adapters` entry — see [docs/PLUGINS.md](../../docs/PLUGINS.md#the-one-rule-an-adapter-may-not-decide-whether-an-operation-runs).
3. Keep the conformance block. It is what tells you that a change in your plugin has not quietly
   changed what one facet promises.

A published plugin peer-depends on `omniface` rather than depending on it, so an app has one copy of
the pipeline. This template uses a workspace dependency because it lives in this repo.
