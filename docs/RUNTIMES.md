# Supported runtimes

What the published packages run on, what this repository is developed on, and what CI proves.

## The matrix

| Runtime | Published packages | A TypeScript entry (`omniface dev app.ts`) | Developing this repo |
| --- | --- | --- | --- |
| Node 20.11+ | supported, checked in CI | no — compile first, or use `tsx` | no |
| Node 22 (22.18+) | supported, checked in CI | yes | no |
| Node 24 | supported, checked in CI | yes | yes — the only version the test suite runs on |
| Bun 1.4+ | supported, checked in CI | yes | no |
| Deno | untested | untested | no |

`engines.node` on every published package is `>=20.11`.

## Why these lines

**Node 20.11 is the floor.** The packages ship as compiled ESM, so nothing at runtime needs
TypeScript support. 20.11 is where `import.meta.dirname` lands, and Node 20 is the oldest release
line still worth supporting; `hono`, `@hono/node-server` and `@modelcontextprotocol/sdk` all clear
it comfortably.

**Loading a `.ts` entry is a separate question.** `omniface dev`, `omniface build`, `omniface lint`,
`omniface inspect`, `omniface conformance` and `omniface mcp` all `import()` your entry module, so whether `app.ts` works depends
on the runtime, not on facet: Node 22.18+ and 24 strip types natively, Bun compiles them. On Node
20, point the commands at compiled JavaScript (`omniface dev dist/app.js`) or run them under a loader
(`node --import tsx node_modules/.bin/omniface dev app.ts`).

**Node 24 for development.** The repo is typechecked with TypeScript 7 and tested with Vitest on
Node 24; `packageManager` pins pnpm. Contributors on older Node versions are not supported — the
published artifacts are what the matrix is about.

**Bun is a target, not a host.** A facet app runs on Bun, and CI proves it by installing the packed
tarballs with `bun install` and driving every facet with the `omniface` bin under Bun. The repo's own
tooling still runs on Node.

**Deno is untested.** Nothing here should offend it (ESM, npm specifiers, no `node:`-only gaps
beyond what Deno polyfills), but nobody has asked, so nothing claims it.

## How CI proves it

`.github/workflows/ci.yml` runs `scripts/smoke-install.mjs` on every runtime in the matrix. That
script packs the four packages exactly as a publish would, installs them into an empty directory —
no clone, no workspace links — writes a small app, and then:

- `facet --version`, `omniface lint`, `omniface build`, `omniface inspect`
- the generated CLI package's `--help` and a real `tasks create`
- `omniface dev` serving REST (create, read, a 404), `/.well-known/facet.json`, and MCP `tools/list`
- `omniface build` against a `.ts` entry, on the runtimes that can load one

Run it locally with `pnpm smoke` (add `--keep` to leave the temporary project behind).
