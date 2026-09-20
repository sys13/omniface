# Outside-generator configurations

Starting points for generating an SDK in a language facet does not generate itself. The input is
always `.omniface/openapi.json`, written by:

```sh
pnpm --filter example-tasks exec omniface build src/app.ts
```

| Directory | Generator | Needs |
| --- | --- | --- |
| [`speakeasy/`](speakeasy/workflow.yaml) | Speakeasy | An account, `speakeasy` on PATH |
| [`fern/`](fern/generators.yml) | Fern | An account, `fern` on PATH |
| [`stainless/`](stainless/stainless.yml) | Stainless | An account |
| [`openapi-generator/`](openapi-generator/README.md) | openapi-python-client, openapi-generator-cli | Network, plus Python or a JVM |

**None of these runs in CI.** Each needs either a vendor account or a toolchain this repository
does not install, so they are written from each generator's documented format rather than from a
build that was watched succeed — check them against the current version before trusting one. What
*is* checked is the input they all read: `examples/tasks/test/generated-sdk.test.ts` proves this
app's OpenAPI document resolves every reference it makes, shares one `Task` model across every
method, and carries the `x-omniface-*` a generator needs.

The part worth reading is not the YAML. It is
[docs/SDKS.md § Other languages](../../../docs/SDKS.md), which says which `x-omniface-*` extension
answers which question a generator has to answer: what to call a method, which ops paginate, which
ops are safe to retry, and which fields must not be logged. A generated SDK that ignores those
compiles and runs and quietly disagrees with every other facet, which is the failure this whole
repository is arranged to prevent.
