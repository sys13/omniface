import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// The bare `omniface` is the first thing a new user runs, and its usage block once named
// `facet --version` — a binary that no longer existed — because nothing read it. This reads it.
//
// The bin loads `dist/devcli.js`, so this needs a build. `pnpm test` builds first; `pnpm test:only`
// and a bare `vitest run` do not, and an unbuilt tree should say that rather than fail on a spawn.

const PKG = join(import.meta.dirname, '..')
const BIN = join(PKG, 'bin', 'omniface.mjs')
const BUILD_HINT = 'Run `pnpm build` and try again.'

const BUILT = existsSync(join(PKG, 'dist', 'devcli.js'))

beforeAll(() => {
  if (!BUILT) throw new Error(`Not built: packages/omniface/dist/devcli.js. ${BUILD_HINT}`)
})

const usage = () => execFileSync(process.execPath, [BIN], { encoding: 'utf8' })

/** Every word the usage block offers as a command: the one after `omniface` on each usage line. */
function commandsNamed(text: string): string[] {
  return text
    .split('\n')
    .map((line) => /^\s+omniface\s+(\S+)/.exec(line)?.[1])
    .filter((c): c is string => c !== undefined)
}

/** The `case` labels in the dispatch, which is what actually decides whether a command exists. */
function dispatched(): Set<string> {
  const source = readFileSync(join(PKG, 'src', 'devcli.ts'), 'utf8')
  return new Set([...source.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]!))
}

describe('omniface usage block', () => {
  it('names only commands the dispatch handles', () => {
    const named = commandsNamed(usage())
    // A parse that finds nothing would make the check below vacuous.
    expect(named.length).toBeGreaterThan(3)
    const cases = dispatched()
    expect(named.filter((c) => !cases.has(c)), `named in the usage block, with no \`case\` in src/devcli.ts. The usage is read from dist; if you just edited it, ${BUILD_HINT}`).toEqual([])
  })
})

/** The flags a command's `case` reads, whether through `flag(rest, 'x')` or a literal `'--x'`. */
function flagsRead(command: string): string[] {
  const source = readFileSync(join(PKG, 'src', 'devcli.ts'), 'utf8')
  const start = source.indexOf(`case '${command}':`)
  const end = source.slice(start + 1).search(/\n {4}(case |default:)/)
  const body = source.slice(start, end === -1 ? undefined : start + 1 + end)
  const names = [...body.matchAll(/flag\(rest, '([a-z-]+)'\)|'--([a-z-]+)'/g)].map((m) => `--${m[1] ?? m[2]}`)
  return [...new Set(names)]
}

describe('omniface <command> --help', () => {
  // Collected before `beforeAll` runs, so an unbuilt tree yields no cases here and the hint above.
  const commands = BUILT ? commandsNamed(usage()).filter((c) => !c.startsWith('-')) : []

  it.each(commands)('%s --help lists every flag its case reads', (command) => {
    const help = execFileSync(process.execPath, [BIN, command, '--help'], { encoding: 'utf8' })
    expect(help).toContain(`omniface ${command} `)
    const listed = help.split('\n').map((l) => /^\s+(--[a-z-]+)/.exec(l)?.[1])
    expect(flagsRead(command).filter((f) => !listed.includes(f))).toEqual([])
  })

  it('answers -h after an entry too, without loading it', () => {
    const help = execFileSync(process.execPath, [BIN, 'lint', 'does-not-exist.ts', '-h'], { encoding: 'utf8' })
    expect(help).toContain('--fix')
  })
})
