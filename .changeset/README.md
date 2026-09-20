# Changesets

Every user-visible change to a published package ships with a changeset: a small markdown file
saying which packages changed, how much (`major` / `minor` / `patch`), and why. `pnpm changeset`
writes one interactively.

Release, in full:

1. On the PR, run `pnpm changeset` and commit the generated file.
2. Merging to `main` makes the release workflow open (or update) a "Version Packages" PR that
   applies the pending changesets: versions bumped, `CHANGELOG.md` written, changeset files deleted.
3. Merging that PR publishes to npm with provenance and pushes a git tag per package.

The four published packages version in lockstep (`fixed` in `config.json`), so a release moves
`facet`, `@omniface/client`, `@omniface/cli` and `@omniface/testing` together and their cross-dependencies
stay on the same number. `example-tasks` is private and ignored.

See [docs/RELEASING.md](../docs/RELEASING.md).
