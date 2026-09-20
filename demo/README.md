# The facet demo

A nine-chapter walkthrough that alternates between the **code** that defines the app
and the **CLI** that serves it, ending with a breaking change caught across all four
facets at once.

```sh
pnpm demo              # paced for an audience
pnpm demo --fast       # no typing delay — use this to rehearse or to check it still works
pnpm demo --manual     # advance chapter by chapter with the return key (needs a terminal)
pnpm demo --no-color   # plain text
```

## What it shows

| # | Chapter | Beat |
| --- | --- | --- |
| 01 | The definition | `Task`, one op with traits, and the four opted-in facets — sliced live out of `examples/tasks/src/app.ts` |
| 02 | One op, every facet | `omniface inspect` renders `tasks.complete` as curl, an SDK call, a CLI command and an MCP tool |
| 03 | Build | `omniface build` writes the manifest, OpenAPI 3.1, `llms.txt` and a runnable CLI |
| 04 | Serve | `omniface dev` answers REST, MCP and the inspector from one process |
| 05 | The same task, four ways | The generated CLI, raw curl, the inferred TypeScript SDK, and a real MCP stdio handshake |
| 06 | Auth is not a facet concern | The plugin pipeline, then 401 and an RFC 7807 403 from a reader key |
| 07 | Traits travel | `pii` is redacted in the log while the API still returns it; `internal` never leaves the process |
| 08 | Prove it | `omniface lint` and `omniface conformance --strict` |
| 09 | Break it on purpose | One narrowed enum, and `omniface diff --strict` naming every facet it breaks — exit code 1 |

## Rules this demo follows

- **Nothing is pre-recorded.** Every command really runs and every byte of output is real.
- **The code slides cannot drift.** They are sliced out of the example app at run time by
  line number, so editing `app.ts` changes the slides.
- **It cleans up after itself.** The dev server is stopped and the temporary
  `src/app.breaking.ts` is removed on exit, including on Ctrl-C.

## Files

| Path | What |
| --- | --- |
| `demo/run.mjs` | The presenter: chapters, syntax highlighting, and the real command runs |
| `examples/tasks/demo/sdk-demo.ts` | A real SDK script — typed from the app, run live in chapter 05 |
| `examples/tasks/demo/mcp-demo.mjs` | A real MCP host: spawns `omniface mcp` and speaks JSON-RPC over stdio |

## Requirements

Node 22.18+, Node 24 or Bun (the `.ts` entry needs a runtime that strips types), `curl`,
and a free port — `3010` by default, or set `DEMO_PORT`. Run `pnpm build` once first so
the workspace packages are compiled.
