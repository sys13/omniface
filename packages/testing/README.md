# @omniface/testing

Proof that a [omniface](https://github.com/sys13/omniface) app's interfaces agree. `createHarness` drives
one operation through REST, the SDK, the CLI and MCP and compares the outcomes;
`conformanceCases` reads the definition and generates the suite — for every op, on every facet it
reaches, the contract checks and the call-based checks its traits imply.

```sh
npm install -D @omniface/testing
```

```ts
const cases = conformanceCases({ app: () => createApp(), ops: { 'tasks.create': { input: { title: 'Conformance' } } } })
for (const c of cases) it(c.name, async () => expect((await c.run()).problems).toEqual([]))
```

Full documentation: https://github.com/sys13/omniface
