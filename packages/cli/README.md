# @omniface/cli

The engine that runs a [omniface](https://github.com/sys13/omniface) manifest as a command-line
interface: flags derived from the schema, help, tables or JSON, `--yes` for destructive ops,
`--all` for paginated ones, `login`, and exit codes that match the error model.

`omniface build` writes a tiny package next to your app — a `bin.mjs` and the manifest — that calls
this engine, so the CLI is a facet of the definition rather than a hand-written client.

```sh
npm install @omniface/cli
```

Full documentation: https://github.com/sys13/omniface
