import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { App } from './app.ts'

/**
 * `omniface conformance` — the drift proof as a command rather than a test file.
 *
 * The generated suite lives in `@omniface/testing`, which peer-depends on this package, so it is
 * imported dynamically: absent, the command says how to install it rather than failing to load.
 * That is the same optional-peer treatment `otel()` gives `@opentelemetry/api`.
 *
 * Two modes, because the checks divide cleanly by what they need:
 *
 * - **Contract only** (no fixtures): reads the manifest and checks nothing drifted between facets —
 *   projection, binding fields, name collisions, internal fields leaking into what is advertised.
 *   Needs no credential and calls nothing, so it runs against any app with no setup at all.
 * - **Full** (with fixtures): adds every case that has to call the app, which needs a credential
 *   and, for writes, a valid input. Those are the things the definition cannot know.
 */

// Structural mirrors of @omniface/testing's types. Importing them would make this package's build
// depend on a package that peer-depends on it, so the shapes are restated and checked at the edge.

type Check = string

type OpFixtures = {
  skip?: boolean | Check[]
  input?: Record<string, unknown>
  missingId?: string
  setup?: (harness: unknown) => void | Promise<void>
}

export type ConformanceFixtures = {
  app: () => App<any>
  apiKey: string
  unprivileged?: { apiKey: string; scopes: string[] }
  ops?: Record<string, OpFixtures>
}

type TestingModule = {
  conformanceCases: (options: ConformanceFixtures) => {
    name: string
    op: string
    check: Check
    run: () => Promise<{ problems: string[] }>
  }[]
  conformanceCoverage: (options: ConformanceFixtures) => {
    needInput: string[]
    ops: { op: string; checks: Check[]; unlockedByInput: Check[] }[]
    cases: { generated: number; possible: number }
  }
}

export const FIXTURE_FILES = ['conformance.fixtures.ts', 'conformance.fixtures.mts', 'conformance.fixtures.js', 'conformance.fixtures.mjs']

export type ConformanceRunResult = {
  mode: 'contract' | 'full'
  /** Where the fixtures came from, when there were any. */
  fixtures?: string
  total: number
  failures: { name: string; problems: string[] }[]
  coverage?: { needInput: string[]; generated: number; possible: number }
}

/** The fixtures beside an entry, if the convention was followed. */
export function findFixtures(entry: string): string | undefined {
  const dir = dirname(resolve(entry))
  return FIXTURE_FILES.map((f) => resolve(dir, f)).find((f) => existsSync(f))
}

/**
 * `@omniface/testing` from the app's own node_modules, not this package's. It peer-depends on facet,
 * so depending on it here would be a cycle; and the copy that matters is the one the app installed.
 */
async function importTesting(entry: string): Promise<TestingModule> {
  try {
    const require = createRequire(resolve(entry))
    return (await import(pathToFileURL(require.resolve('@omniface/testing')).href)) as unknown as TestingModule
  } catch {
    throw new Error(
      'omniface conformance needs @omniface/testing, which is not installed alongside the app.\n' +
        '  npm i -D @omniface/testing    (or pnpm add -D / yarn add -D)',
    )
  }
}

function assertFixtures(value: unknown, from: string): ConformanceFixtures {
  const f = value as Partial<ConformanceFixtures> | undefined
  if (!f || typeof f !== 'object') throw new Error(`${from} does not export conformance fixtures`)
  if (typeof f.app !== 'function') throw new Error(`${from}: fixtures need an \`app: () => App\` factory, so each case gets a fresh app`)
  if (typeof f.apiKey !== 'string') throw new Error(`${from}: fixtures need an \`apiKey\` holding every scope the app declares`)
  return f as ConformanceFixtures
}

async function loadFixtures(path: string): Promise<ConformanceFixtures> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown; conformance?: unknown }
  return assertFixtures(mod.default ?? mod.conformance, path)
}

export type ConformanceRunOptions = {
  /** An explicit fixtures module. Without one, the convention beside the entry is tried. */
  fixtures?: string
  /** Run only the cases for these ops. */
  only?: string[]
}

export async function runConformanceFor(
  entry: string,
  app: App<any>,
  options: ConformanceRunOptions = {},
): Promise<ConformanceRunResult> {
  const testing = await importTesting(entry)
  const path = options.fixtures ? resolve(options.fixtures) : findFixtures(entry)
  if (options.fixtures && !existsSync(path!)) throw new Error(`No fixtures at ${path}`)

  const fixtures = path ? await loadFixtures(path) : undefined
  // Contract cases read the manifest and call nothing, so the credential is never presented.
  const effective: ConformanceFixtures = fixtures ?? { app: () => app, apiKey: '' }

  let cases = testing.conformanceCases(effective)
  if (!fixtures) cases = cases.filter((c) => c.check === 'contract')
  if (options.only?.length) cases = cases.filter((c) => options.only!.includes(c.op))

  const failures: { name: string; problems: string[] }[] = []
  for (const c of cases) {
    const { problems } = await c.run()
    if (problems.length) failures.push({ name: c.name, problems })
  }

  const coverage = fixtures ? testing.conformanceCoverage(fixtures) : undefined
  return {
    mode: fixtures ? 'full' : 'contract',
    fixtures: path,
    total: cases.length,
    failures,
    coverage: coverage && { needInput: coverage.needInput, generated: coverage.cases.generated, possible: coverage.cases.possible },
  }
}
