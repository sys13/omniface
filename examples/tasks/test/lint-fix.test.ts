import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFixPlans, type FixPlan, type LintFinding } from 'omniface'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Backlog 4.4: `omniface lint --fix`. The fixtures live under this package so `facet` and `zod`
// resolve the way they would in a real app, and the command is driven through the installed bin
// rather than in process: the fix captures definition sites from the stack, so the app and the
// linter have to be looking at the same copy of facet, exactly as they are for a user.

const DIR = join(import.meta.dirname, '.lint-fix')
const bin = fileURLToPath(new URL('devcli.js', import.meta.resolve('omniface')))

const write = (name: string, source: string) => {
  writeFileSync(join(DIR, name), source)
  return join(DIR, name)
}

/** The command, with its exit code, whether it succeeded or not. */
function lint(file: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: execFileSync('node', [bin, 'lint', file, ...args], { encoding: 'utf8' }), stderr: '' }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { status: e.status, stdout: e.stdout, stderr: e.stderr }
  }
}

const SHARED = `import { facet } from 'omniface'
import { z } from 'zod'

const Widget = z.object({
  id: z.string(),
  label: z.string(),
})

const f = facet()

export default f.app({
  name: 'widgets',
  ops: {
    widgets: {
      get: f
        .op({ description: 'Get a widget', input: z.object({ id: z.string() }), output: Widget })
        .traits({ readonly: true })
        .handle(() => ({ id: 'w1', label: 'one' })),
      create: f
        .op({ description: 'Create a widget', input: z.object({ label: z.string() }), output: Widget })
        .handle(() => ({ id: 'w1', label: 'one' })),
    },
  },
})
`

beforeEach(() => mkdirSync(DIR, { recursive: true }))
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('omniface lint --fix', () => {
  it('names a shared schema after the const that already holds it, and imports t', () => {
    const file = write('shared.ts', SHARED)
    expect(lint(file).stdout).toContain('name-shared-types')

    const fixed = lint(file, '--fix')
    expect(fixed.status).toBe(0)
    expect(fixed.stdout).toContain("const Widget → t.named('Widget', …)")
    // The check ran and came back clean, which is the only reason the edit was kept.
    expect(fixed.stdout).toContain('1 fix(es) applied and checked.')
    expect(fixed.stdout).toContain('No findings.')

    const source = readFileSync(file, 'utf8')
    expect(source).toContain("import { t } from 'omniface/zod'")
    expect(source).toContain("const Widget = t.named('Widget', z.object({")
    // The ops were not touched: fixing the declaration fixes every op that shares it.
    expect(source).toContain('output: Widget })')
    expect(lint(file).stdout).toContain('No findings.')
  })

  it('is idempotent: a second run has nothing to do', () => {
    const file = write('shared.ts', SHARED)
    lint(file, '--fix')
    const before = readFileSync(file, 'utf8')
    const again = lint(file, '--fix')
    expect(again.stdout).toContain('No findings.')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('names a recursive schema, which is the error-level rule', () => {
    const file = write('recursive.ts', `import { facet } from 'omniface'
import { z } from 'zod'

const Comment: z.ZodType<any> = z.object({
  id: z.string(),
  get replies() {
    return z.array(Comment)
  },
})

const f = facet()

export default f.app({
  name: 'threads',
  ops: {
    comments: {
      get: f
        .op({ description: 'Get a thread', input: z.object({ id: z.string() }), output: Comment as z.ZodObject<any> })
        .traits({ readonly: true })
        .handle(() => ({ id: 'c1', replies: [] })),
    },
  },
})
`)
    // The rule fires on the shape zod actually emits for recursion — a bare `$ref: '#'`, no $defs.
    const before = lint(file)
    expect(before.status).toBe(1)
    expect(before.stdout).toContain('name-recursive-types')
    expect(before.stdout).toContain('refers to itself')

    const fixed = lint(file, '--fix')
    expect(fixed.status).toBe(0)
    // `Comment as z.ZodObject<any>` is still the Comment declaration: the assertion is seen through.
    expect(fixed.stdout).toContain("const Comment → t.named('Comment', …)")
    expect(readFileSync(file, 'utf8')).toContain("const Comment: z.ZodType<any> = t.named('Comment', z.object({")
  })

  it('names an inline schema after the op it belongs to', () => {
    const file = write('inline.ts', `import { facet } from 'omniface'
import { z } from 'zod'

const f = facet()
const shape = { id: z.string(), get self() { return z.array(shape2) } }
const shape2: any = z.object(shape)

export default f.app({
  name: 'inline',
  ops: {
    nodes: {
      get: f
        .op({ description: 'Get a node', input: z.object({ id: z.string() }), output: z.object(shape) })
        .traits({ readonly: true })
        .handle(() => ({ id: 'n1', self: [] })),
    },
  },
})
`)
    const fixed = lint(file, '--fix')
    expect(fixed.stdout).toContain("nodes.get output → t.named('NodesGetOutput', …)")
    expect(readFileSync(file, 'utf8')).toContain("output: t.named('NodesGetOutput', z.object(shape))")
  })

  it('declines a schema it cannot reach, and says where to make the edit by hand', () => {
    write('types.ts', `import { z } from 'zod'
export const Widget = z.object({ id: z.string(), label: z.string() })
`)
    const file = write('imported.ts', `import { facet } from 'omniface'
import { z } from 'zod'
import { Widget } from './types.ts'

const f = facet()

export default f.app({
  name: 'widgets',
  ops: {
    widgets: {
      get: f
        .op({ description: 'Get a widget', input: z.object({ id: z.string() }), output: Widget })
        .traits({ readonly: true })
        .handle(() => ({ id: 'w1', label: 'one' })),
      create: f
        .op({ description: 'Create a widget', input: z.object({ label: z.string() }), output: Widget })
        .handle(() => ({ id: 'w1', label: 'one' })),
    },
  },
})
`)
    const before = readFileSync(file, 'utf8')
    const fixed = lint(file, '--fix')
    expect(fixed.stdout).toContain('has no top-level `const` declaration')
    expect(fixed.stdout).toContain("const Widget = t.named('Widget', …)")
    // Declining is not editing: the file is exactly as it was, and the finding is still reported.
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(fixed.stdout).toContain('name-shared-types')
  })

  it('leaves a clean app alone', () => {
    const entry = join(import.meta.dirname, '../src/app.ts')
    const result = lint(entry, '--fix')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('No findings.\n')
  })

  it('reports findings as JSON, with the fix each one carries', () => {
    const file = write('shared.ts', SHARED)
    const findings = JSON.parse(lint(file, '--json').stdout) as LintFinding[]
    expect(findings).toHaveLength(1)
    expect(findings[0]!.op).toBe('widgets.get')
    expect(findings[0]!.fix).toEqual({ io: 'output', suggestedName: 'WidgetsGetOutput' })
  })
})

describe('the check around a fix', () => {
  // The edits are made by a scanner, not a parser, so the guarantee is not that the scanner is
  // always right — it is that a wrong edit never survives. Both failure modes restore every file.
  const plan = (file: string): FixPlan => ({
    finding: { level: 'warn', rule: 'name-shared-types', message: 'x', op: 'a.b', fix: { io: 'output', suggestedName: 'X' } },
    file,
    name: 'X',
    target: 'const X',
    apply: () => 'rewritten',
  })

  const io = (files: Map<string, string>, verify: () => Promise<LintFinding[]>) => ({
    read: async (f: string) => files.get(f)!,
    write: async (f: string, text: string) => void files.set(f, text),
    verify,
  })

  it('restores every file when the app no longer loads', async () => {
    const files = new Map([['/a.ts', 'original']])
    const result = await applyFixPlans([plan('/a.ts')], [], io(files, () => Promise.reject(new Error('Unexpected token'))))
    expect(result.rolledBack).toContain('no longer loads')
    expect(result.fixed).toEqual([])
    expect(files.get('/a.ts')).toBe('original')
  })

  it('restores every file when the finding it was meant to resolve is still there', async () => {
    const files = new Map([['/a.ts', 'original']])
    const stillThere: LintFinding = { level: 'warn', rule: 'name-shared-types', message: 'x' }
    const result = await applyFixPlans([plan('/a.ts')], [], io(files, () => Promise.resolve([stillThere])))
    expect(result.rolledBack).toContain('did not resolve')
    expect(files.get('/a.ts')).toBe('original')
  })

  it('keeps the edit when the check comes back clean', async () => {
    const files = new Map([['/a.ts', 'original']])
    const result = await applyFixPlans([plan('/a.ts')], [], io(files, () => Promise.resolve([])))
    expect(result.rolledBack).toBeUndefined()
    expect(result.fixed).toEqual([{ file: '/a.ts', target: 'const X', name: 'X', rule: 'name-shared-types' }])
    expect(files.get('/a.ts')).toBe('rewritten')
  })
})
