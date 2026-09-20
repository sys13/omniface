# facet

Define an app's operations once, in code. Get every interface — REST, SDK, CLI, MCP — as a *facet*
of that one definition. Cross-cutting concerns (auth, rate limiting, logging, audit) are plugins,
not per-interface rework.

```sh
npm install facet zod
```

```ts
import { facet } from 'omniface'
import { t } from 'omniface/zod'
import { z } from 'zod'

const f = facet()
const Task = t.named('Task', z.object({ id: t.id(), title: z.string().min(1) }))

export default f.app({
  name: 'acme',
  ops: {
    tasks: {
      create: f.op({ description: 'Create a task', input: Task.pick({ title: true }), output: Task }).handle(({ input }) => save(input)),
    },
  },
  facets: { rest: true, sdk: true, cli: true, mcp: true },
})
```

```sh
omniface dev app.ts      # REST on :3000, MCP at /mcp, the inspector at /_omniface
omniface build app.ts    # .omniface/: manifest, openapi.json, llms.txt and a CLI package
omniface inspect app.ts tasks.create
omniface lint app.ts
```

Subpaths: `omniface/zod` (schema adapter and traits), `omniface/plugins` (logging, apiKeys, scopes,
rateLimit, idempotency, audit), `omniface/rest`, `omniface/mcp`.

Companion packages: [`@omniface/client`](https://www.npmjs.com/package/@omniface/client) (the SDK runtime),
[`@omniface/cli`](https://www.npmjs.com/package/@omniface/cli) (the engine a generated CLI runs on),
[`@omniface/testing`](https://www.npmjs.com/package/@omniface/testing) (cross-omniface conformance).

Full documentation: https://github.com/sys13/omniface
