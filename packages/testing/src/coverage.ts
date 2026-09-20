import { buildManifest } from 'omniface'
import { conformanceCases, type Check, type ConformanceOptions, type OpConformanceOptions } from './conformance.ts'

/**
 * Which generated cases an app actually gets, and which ones a hand-written input would add.
 *
 * `ops[id].input` and `ops[id].setup` are the only things the definition cannot know (a valid
 * title, a row to read), so they are also the only way the suite silently shrinks: an op with no
 * input quietly loses its happy-path and idempotency cases and nothing says so. This reports that
 * gap rather than leaving it to be noticed.
 *
 * The "would add" half is not a second copy of the gating rules — it re-runs case generation with a
 * placeholder input for every op and diffs the two. Whatever `conformanceCases` decides an input
 * unlocks, this reports, including rules added later.
 */

export type OpCoverage = {
  op: string
  /** Checks generated as the app stands. */
  checks: Check[]
  /** Checks that would appear if `ops[op].input` were supplied. Empty when nothing is missing. */
  unlockedByInput: Check[]
}

export type ConformanceCoverage = {
  ops: OpCoverage[]
  /** Ops where supplying an input would generate at least one more case. */
  needInput: string[]
  /** Total cases now, and with an input for every op. */
  cases: { generated: number; possible: number }
}

/** A placeholder that only flips the `input !== undefined` gates; it is never called with. */
const PLACEHOLDER: Record<string, unknown> = {}

export function conformanceCoverage(options: ConformanceOptions): ConformanceCoverage {
  const manifest = buildManifest(options.app())

  const withPlaceholders: Record<string, OpConformanceOptions> = {}
  for (const op of manifest.ops) {
    const perOp = options.ops?.[op.id] ?? {}
    // Keep skip and setup as they are: a skipped op stays skipped, and a missing setup is a
    // separate gap from a missing input.
    withPlaceholders[op.id] = { ...perOp, input: perOp.input ?? PLACEHOLDER }
  }

  const actual = conformanceCases(options)
  const possible = conformanceCases({ ...options, ops: withPlaceholders })

  const checksOf = (cases: { op: string; check: Check }[], id: string): Check[] =>
    cases.filter((c) => c.op === id).map((c) => c.check)

  const ops: OpCoverage[] = []
  for (const op of manifest.ops) {
    const checks = checksOf(actual, op.id)
    const unlockedByInput = checksOf(possible, op.id).filter((c) => !checks.includes(c))
    ops.push({ op: op.id, checks, unlockedByInput })
  }

  return {
    ops,
    needInput: ops.filter((o) => o.unlockedByInput.length > 0).map((o) => o.op),
    cases: { generated: actual.length, possible: possible.length },
  }
}
