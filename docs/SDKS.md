# SDKs

One definition projects onto four facets. Two of them are client libraries, and they are built
very differently, because the people who use them have very different things in hand.

| | Who it is for | How it is built | Where it lives |
| --- | --- | --- | --- |
| **Inferred client** | Code in the same repo as the app | `createClient<typeof app>()` — no codegen at all | `@omniface/client` |
| **Generated package** | Consumers outside the repo, in TypeScript | `omniface build` → `.omniface/sdk/` | the package you publish |
| **Other languages** | Everyone else | an outside generator, over the OpenAPI document | that generator's output |

The decision behind the split is in [DX.md](DX.md): **our own TypeScript SDK, outsource the rest.**
Writing and maintaining a generator per language is a full-time product; carrying facet's traits
into somebody else's generator is a document format.

---

## The inferred client

```ts
import { createClient } from '@omniface/client'
import type app from './app.ts'

const client = createClient<typeof app>({ baseUrl, apiKey })
await client.tasks.create({ title: 'Write the launch post' })
```

Types come from the app module by inference, so it cannot be stale and there is nothing to
rebuild. It needs the app's source, which is what makes it the wrong tool for anyone else.

## The generated package

`omniface build` writes `.omniface/sdk/`: a publishable package with the same methods, the types
written down instead of inferred, on top of the same `@omniface/client` runtime.

```
.omniface/sdk/
  package.json     name from `facets.sdk.packageName`, default `<app>-sdk`
  index.mjs        the constructor; the manifest is embedded, so there is no discovery round trip
  index.d.ts       every type and method, generated from the manifest
  manifest.json
  README.md
```

```ts
import { createTasksClient } from 'tasks-sdk'

const client = createTasksClient({ baseUrl: 'https://api.example.com', apiKey: process.env.API_KEY })
const task = await client.tasks.create({ title: 'Write the launch post' })
```

What is generated is **types and a constructor, never per-method request code.** The methods are a
proxy over the embedded manifest, exactly as in the inferred client, so there is no generated
request body for a hand edit to drift away from the definition. That is the same rule the CLI
follows, and the reason for it is the same.

Three things come out of the manifest and are worth knowing about:

- **`t.named('Task', …)` becomes one exported type.** Every method that returns a task returns
  `Task`, not an anonymous shape repeated per operation. Types no name was given get one from the
  op — `TasksCreateInput`, `TasksListOutput`.
- **Traits become documentation the consumer sees.** A `pii` field says so in its JSDoc, a
  `destructive` op says "Irreversible.", and an op's declared errors are listed as the codes its
  `FacetClientError` can carry. An `internal` field is not there at all: it is stripped before the
  manifest exists, so no facet can leak it.
- **A paginated op gets three forms.** `list()` for one page, `list.iterate()` for an async
  iterable over every page, and `list.autoPaginate()` for all of them in one array.

Plugins can add constructor options through the SDK adapter slot
([PLUGINS.md](PLUGINS.md)); they arrive as typed options on the constructor and are sent as the
header or credential the plugin declared. A plugin cannot add *behaviour* to this facet, because
this facet does not run in the server's process.

## Other languages

The OpenAPI document at `.omniface/openapi.json` (and `/openapi.json` on a running app) is the input.
It is ordinary OpenAPI 3.1 — any generator reads it — with two things done on purpose for the
generators' benefit.

**Named types are hoisted into `components.schemas`.** A generator that reads inline schemas emits
`TasksCreateResponse`, `TasksGetResponse` and `TasksCompleteResponse` for what the author called
one `Task`. Hoisting gives every method the same model. It is also what makes a recursive type
work at all: zod emits a self-reference as `{"$ref": "#/$defs/…"}` rooted at the *operation's*
schema, and inlined into a document with a different root that points at nothing.

**Every operation carries `x-omniface-*`.** The traits an op declares are the difference between a
generated SDK that agrees with facet's own and one named after URLs.

### Extension reference

Document level:

| Key | What it says |
| --- | --- |
| `x-facet` | `{ manifest, facets, cli?, sdk? }` — the manifest version, which facets this app serves, the CLI bin name and the SDK package name |

On each operation:

| Key | What it says |
| --- | --- |
| `x-omniface-op` | The op id (`tasks.create`). The stable identity across all four facets |
| `x-omniface-traits` | The op's declared traits, verbatim: `readonly`, `destructive`, `idempotent`, `paginated`, `scope`, `public`, `cost`, and any a plugin added |
| `x-omniface-errors` | The error codes this op declares it can throw |
| `x-omniface-sdk` | `{ method }` — the method path facet's own SDK uses (`["tasks","create"]`) |
| `x-omniface-cli` | `{ command, args, columns? }` — how the CLI spells it |
| `x-omniface-mcp` | `{ tool, description }`, or `{ group }` when the op is behind an intent-level tool |
| `x-omniface-pagination` | `{ style: "cursor", cursor, limit, items, nextCursor }` on paginated ops. The field names are the same on every op, so this is really a flag saying *this one paginates* |
| `x-omniface-plugin` | On a route a plugin added, rather than an op. It has no traits and no pipeline |

On a schema or a field:

| Key | What it says |
| --- | --- |
| `x-omniface-name` | The name `t.named()` gave the type. Kept on the hoisted model so a generator can prefer it over the component key |
| `x-omniface-pii` / `x-omniface-sensitive` | Personal data. It must not be logged; `sensitive` is also masked in CLI tables |
| `x-omniface-scalar` | The facet scalar kind: `id`, `datetime`, `date`, `email`, `url`, `money`, `cursor` |
| `x-omniface-deprecated` | The message, when `deprecated` was given one. The standard `deprecated: true` is set as well |
| `x-omniface-<other>` | Any other field trait, verbatim |

Standard keywords are used wherever one exists — `description`, `examples`, `readOnly`,
`writeOnly`, `deprecated` — so a generator that ignores every extension still gets those.

`internal` never appears: fields marked `internal` are removed from the manifest before any facet
sees them, so there is nothing for a generator to exclude.

### Generator setup

Starting configurations are in [`examples/tasks/sdks/`](../examples/tasks/sdks/). None of them runs
in CI — Stainless, Speakeasy and Fern need an account, and running the open-source generators needs
a network and a JVM or a Python toolchain — so treat them as a starting point rather than a pinned,
proven build.

The facet-specific advice is the same for all of them, and it is what the table above is for:

- **Take method names from `x-omniface-sdk.method`**, not from the URL. It is the same name the
  TypeScript SDK, the CLI and MCP use, so a Python user and a TypeScript user are talking about
  the same thing when they say `tasks.create`.
- **Take pagination from `x-omniface-pagination`**, so `.auto_paginate()` in the generated language
  means what `.autoPaginate()` means here.
- **Take retry and idempotency behaviour from `x-omniface-traits`**: `readonly` and `idempotent` ops
  are the safe ones to retry, and an `idempotent` write should carry an `Idempotency-Key`. Getting
  this from the traits is how a second language ends up with the same behaviour rather than a
  plausible-looking one.
- **Carry `x-omniface-pii` into the generated documentation.** A trait that stops at the server is
  not a trait, it is a comment.

What is *not* built yet is proof. `omniface conformance` drives the app's own four facets in
process; it has no way to reach a Python package. Backlog 5.4 is exactly that gap — a generated
SDK in a second language, run against the same error and pagination checks the TypeScript client
passes — and until it exists, the agreement between an outside generator's output and facet's own
is argued from the document rather than demonstrated.
