# Releasing

Four packages ship to npm: `omniface`, `@omniface/client`, `@omniface/cli`, `@omniface/testing`. They version
in lockstep, so one release moves all four and their cross-dependencies always point at the same
number. `examples/tasks` is private and never published.

> **Why `omniface` and not `facet`.** The npm package `facet` belongs to an unrelated project
> (`qualiancy/facet`, 0.5.0, still ~1.4k downloads/week), so the name-dispute process was never
> realistic; and `@facet` was no better, because an npm scope is an account name and that account
> already exists. The names here are claimed: the **`omniface`** org was created 2026-09-20 and
> owns `@omniface/*`, with **`sys13`** as the publishing account. The unscoped `omniface` needs no
> org — any account may publish it.
>
> Nothing has been published yet, so the first release is still the one that proves the name: npm
> can reject a new name as too similar to an existing one, and `scripts/publish.mjs --dry-run`
> does not test for that. The first real `npm publish` is where it surfaces.

## The loop

1. **On the PR:** `pnpm changeset` — pick the packages that changed, pick `major`/`minor`/`patch`,
   write the line that will appear in the changelog. Commit the generated file in `.changeset/`.
   A change with no user-visible effect (tests, docs, refactors) needs no changeset.
2. **On merge to `main`:** the release workflow opens or updates a **Version Packages** PR that
   applies every pending changeset: versions bumped, `CHANGELOG.md` written per package, changeset
   files consumed, the lockfile refreshed.
3. **Merge the Version Packages PR:** the same workflow publishes. Each package is packed with
   `pnpm pack` (which resolves `workspace:` ranges to real versions), published with
   `npm publish --provenance`, and tagged `<name>@<version>`; GitHub releases are created from the
   changelog entries.

Nothing is published from a laptop. Provenance requires the OIDC token that only the workflow has.

## Moving parts

| Piece | Where | What it does |
| --- | --- | --- |
| Changesets | `.changeset/config.json` | `fixed` keeps the four packages in lockstep; `ignore` drops the example |
| Version step | `pnpm version-packages` | `changeset version` plus a lockfile refresh |
| Publish step | `pnpm release` | `pnpm build`, then `scripts/publish.mjs` |
| Publish script | `scripts/publish.mjs` | packs, skips versions already on the registry, `npm publish --provenance --access public`, `changeset tag` |
| Pack helper | `scripts/pack.mjs` | the one place that knows which packages publish and how they are packed |
| Workflow | `.github/workflows/release.yml` | `id-token: write` for provenance, `NPM_TOKEN` for the registry |

## Checks before a release

CI already runs them on every PR, and the release workflow runs them again before publishing:

- `pnpm build` — ESM plus declarations for all four packages
- `pnpm exec tsc -p tsconfig.json --noEmit` — the workspace, against the *built* declarations
- `pnpm test:only` — the suite, including `test/packaging.test.ts`, which fails if an entry point
  in an `exports` map is missing, if a declaration file still imports a `.ts` path, or if the
  public API surface changed without the list in that file changing with it
- `pnpm smoke` — the quickstart from a fresh directory, on every runtime in
  [RUNTIMES.md](RUNTIMES.md)

## Dry runs

```sh
pnpm build
node scripts/pack.mjs /tmp/facet-tarballs      # exactly what would be uploaded
node scripts/publish.mjs --dry-run --tag next  # npm's view of each tarball, nothing uploaded
pnpm smoke --keep                              # install those tarballs into a throwaway project
```

## What a version number means

Pre-1.0, `minor` is the breaking-change bump and `patch` is everything else — the public surface is
still moving. The surface itself is spelled out in [API.md](API.md): names re-exported from a
package entry point are covered, everything else is internal. `test/packaging.test.ts` holds the
list, so widening the surface is a deliberate diff rather than an accident.

That is facet's own surface. An app built *with* facet has four surfaces, and they break
independently, so the question "is this release breaking?" has four answers:

```sh
omniface build src/app.ts --out .facet            # on the released commit, or from the published package
omniface diff .omniface/manifest.json src/app.ts     # …then, on the working tree
```

Each change is reported at the level a caller would feel it — `breaking`, `additive` or `neutral` —
tagged with the facets it lands on, and the report ends in one sentence: *"Breaks rest and cli, not
mcp and sdk."* `--strict` makes a breaking change an exit code, `--quiet` hides the neutral ones,
and `--json` is the same data for a bot. The suggested bump follows the rule above: breaking →
`minor` pre-1.0. The diff reads manifests, not source, so it sees exactly what the four facets
publish — a renamed output type is breaking for the SDK and OpenAPI and invisible to MCP; a newly
`destructive` op breaks CLI scripts, which now stop at a prompt, and nothing else.
