---
'omniface': minor
'@omniface/testing': minor
---

Contract safety: the drift proof as a command, a coverage report for the two inputs it cannot
generate, and two lints that keep traits and overrides honest.

- `omniface conformance <entry>` runs the generated suite from a terminal or CI. The checks divide by
  what they need, so the command has a zero-setup mode: the contract checks read the manifest and
  call nothing, and run against any app with no credential and no fixtures. The rest wait for a
  `conformance.fixtures.ts` beside the entry, which is the same object the vitest suite passes — so
  the command and the suite run the same cases rather than two drifting copies. `@omniface/testing` is
  an optional peer, resolved from the app's own `node_modules`.
- `conformanceCoverage()` in `@omniface/testing` reports which cases an app gets and which ones a
  hand-written `ops[id].input` would add. It is a diff, not a restatement of the rules: cases are
  generated twice, once as the app stands and once with a placeholder input for every op, so
  whatever `conformanceCases` decides an input unlocks is what gets reported. `--strict` turns a
  gap into an exit code.
- `override-budget` lint: warns when more than a third of a facet's ops carry a per-op override,
  which is the ladder's step 3 having stopped being an exception. Turning a projection off is step
  2 and is not counted.
- `unused-trait` lint: traits set on a schema no op reaches, so a `pii` that redacts nothing or an
  `internal` that strips nothing is visible rather than silent. Opt-in via `lint(app, manifest,
  { unusedTraits: true })`, because the trait registry is process-wide and an orphan belongs to no
  app; `omniface lint` turns it on. Note that schema methods do *not* strand traits — zod's clones stay
  visible to the adapter's conversion callback, and that behaviour is now pinned by tests.
- Generated conformance gives a destructive, non-idempotent op a fresh app per facet. Driving four
  facets at one app meant the first delete consumed the row and the other three answered
  `not_found`, so the case could never pass; now `tasks.delete` is proven to agree across facets.
