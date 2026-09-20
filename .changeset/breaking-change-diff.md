---
'omniface': minor
---

`omniface diff <before> <after>` — what changed between two versions of an app, and which facets it
breaks.

One definition projects onto four interfaces, and they disagree about almost every change, so the
report is per facet rather than a single verdict: a renamed output type breaks a generated SDK and
an OpenAPI component and is invisible to MCP and the CLI; a newly `destructive` op breaks CLI
scripts, which now stop at a prompt, and nothing else; widening an output enum breaks callers with
an exhaustive switch while widening an input enum breaks nobody. Each change carries a level
(`breaking`, `additive`, `neutral`), the facets it lands on, and a line saying why. The report ends
in one sentence — "Breaks rest and cli, not mcp and sdk." — and a suggested version bump.

- Either side may be a `manifest.json` written by `omniface build` or an app module, so the normal
  invocation is `omniface diff .omniface/manifest.json src/app.ts`: released against about-to-be-released.
- `--strict` turns a breaking change into an exit code, `--quiet` hides the neutral changes, and
  `--json` is the same data for a bot. Without `--strict` the command exits 0: breaking on purpose
  is a release decision, and the command's job is only that nobody finds out afterwards.
- The engine is `diffManifests(before, after)`, with `formatDiff()` and `verdict()` beside it,
  exported from `facet`. It compares manifests rather than definitions, so anything a facet's
  projection starts publishing is diffed the moment it reaches the manifest.
