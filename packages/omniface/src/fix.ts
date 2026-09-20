import type { App } from './app.ts'
import type { LintFinding } from './lint.ts'
import { definitionSite } from './op.ts'

/**
 * `omniface lint --fix` — inserting the `t.named()` the named-type rules ask for.
 *
 * Every other part of facet reads the definition as values: schemas are compared by instance, ops
 * by id. A fix has to write source, which means finding the text the author wrote, and the only
 * bridge from a value back to a line is the stack captured at the `op({...})` call
 * (`captureDefinitionSites` in op.ts). From there this is a text edit, done by scanner rather than
 * by parser: facet has no TypeScript parser at runtime and will not grow one for this.
 *
 * A scanner is a guess, so nothing here trusts itself. Every edit is checked by re-linting the app
 * in a fresh process — the caller supplies the check — and a file whose findings did not go away,
 * or that no longer loads at all, is restored byte for byte. The worst outcome is "could not fix
 * this one, here is the edit to make by hand", which is the outcome for every shape the scanner
 * does not recognise anyway.
 */

export type FixPlan = {
  finding: LintFinding
  file: string
  /** The name the schema will be given. */
  name: string
  /** What was rewritten, for the report: `const Task` or `tasks.create output`. */
  target: string
  apply: (text: string) => string
}

export type Unfixable = { finding: LintFinding; reason: string }

// ---------------------------------------------------------------------------------------------
// Scanning
//
// Enough of a lexer to not be fooled by a brace in a string, a colon in a URL inside a comment, or
// a regex literal's delimiters. It does not need to understand TypeScript, only to count
// delimiters correctly while walking past the parts that do not count.

type Scan = { i: number; depth: number }

const OPENERS = '([{'
const CLOSERS = ')]}'

/** Advance past a string, template, comment or regex literal starting at `i`. Returns the new index, or `i`. */
function skipAtom(text: string, i: number): number {
  const c = text[i]!
  const next = text[i + 1]
  if (c === '/' && next === '/') {
    const end = text.indexOf('\n', i)
    return end === -1 ? text.length : end
  }
  if (c === '/' && next === '*') {
    const end = text.indexOf('*/', i + 2)
    return end === -1 ? text.length : end + 2
  }
  if (c === '"' || c === "'" || c === '`') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === c) return j + 1
    }
    return text.length
  }
  return i
}

/** Walk forward from `from` until `stop` says so, tracking bracket depth and skipping atoms. */
function walk(text: string, from: string | number, stop: (s: Scan, text: string) => boolean): Scan {
  const scan: Scan = { i: typeof from === 'number' ? from : 0, depth: 0 }
  while (scan.i < text.length) {
    const skipped = skipAtom(text, scan.i)
    if (skipped !== scan.i) {
      scan.i = skipped
      continue
    }
    const c = text[scan.i]!
    if (OPENERS.includes(c)) scan.depth++
    else if (CLOSERS.includes(c)) scan.depth--
    if (stop(scan, text)) return scan
    scan.i++
  }
  return scan
}

/** Byte offset of a 1-based line and column. */
function offsetOf(text: string, line: number, column: number): number | undefined {
  let offset = 0
  for (let l = 1; l < line; l++) {
    const end = text.indexOf('\n', offset)
    if (end === -1) return undefined
    offset = end + 1
  }
  const at = offset + column - 1
  return at <= text.length ? at : undefined
}

/**
 * The `input:` or `output:` property of the op config literal whose call starts at `callAt`.
 *
 * V8's column for a call frame points at the callee, so the scan starts there and takes the first
 * `(`, then the first `{` inside it — the config object — and matches the key at that object's own
 * depth, so an `output:` nested in a sub-object is not mistaken for the op's.
 */
function configProperty(text: string, callAt: number, key: string): { start: number; end: number } | undefined {
  const open = text.indexOf('(', callAt)
  if (open === -1) return undefined
  const brace = walk(text, open, (s) => s.depth === 2 && text[s.i] === '{')
  if (brace.i >= text.length) return undefined

  // The inner walk counts from the brace, so the config object's own properties are at depth 0.
  let found: number | undefined
  walk(text, brace.i + 1, (s) => {
    if (s.depth < 0) return true // left the config object
    if (s.depth !== 0) return false
    if (!text.startsWith(key, s.i)) return false
    // A key, not a suffix of a longer identifier or a value.
    const before = text.slice(0, s.i).trimEnd()
    if (!/[{,]$/.test(before)) return false
    const after = text.slice(s.i + key.length)
    if (!/^\s*:/.test(after)) return false
    found = s.i + key.length + after.indexOf(':') + 1
    return true
  })
  if (found === undefined) return undefined

  const start = found + (/^\s*/.exec(text.slice(found))?.[0].length ?? 0)
  // The value ends at the comma or closing brace that belongs to the config object itself.
  const end = walk(text, start, (s) => (s.depth === 0 && text[s.i] === ',') || s.depth < 0)
  return { start, end: end.i }
}

/** Where a top-level `const <name> =` initializer begins and ends. */
function constInitializer(text: string, name: string): { start: number; end: number } | undefined {
  const declaration = new RegExp(`(^|\\n)(export\\s+)?const\\s+${name}\\b[^=\\n]*=`, 'm').exec(text)
  if (!declaration) return undefined
  const afterEquals = declaration.index + declaration[0].length
  const start = afterEquals + (/^\s*/.exec(text.slice(afterEquals))?.[0].length ?? 0)
  // The initializer ends at the first newline reached at depth 0 that is not a line continuation —
  // a leading `.`, an operator, or a closing delimiter all mean the expression keeps going.
  const end = walk(text, start, (s) => {
    if (s.depth < 0) return true
    if (s.depth !== 0) return false
    if (text[s.i] === ';') return true
    if (text[s.i] !== '\n') return false
    const rest = text.slice(s.i + 1)
    return !/^\s*([.?)\]},|&+\-*/=<>:]|as\b|satisfies\b)/.test(rest)
  })
  return { start, end: end.i }
}

/** `import { t } from 'omniface/zod'`, or whatever else binds `t` in this file. */
function bindsT(text: string): boolean {
  return /(^|\n)\s*import\s*\{[^}]*\bt\b[^}]*\}\s*from|(^|\n)\s*const\s*\{[^}]*\bt\b[^}]*\}\s*=/.test(text)
}

function withTImport(text: string): string {
  if (bindsT(text)) return text
  const lastImport = [...text.matchAll(/(^|\n)import\s[^\n]*\n/g)].pop()
  const line = "import { t } from 'omniface/zod'\n"
  if (!lastImport) return line + text
  const at = lastImport.index + lastImport[0].length
  return text.slice(0, at) + line + text.slice(at)
}

const wrap = (expression: string, name: string) => `t.named('${name}', ${expression})`

// ---------------------------------------------------------------------------------------------
// Planning

/**
 * What `--fix` would do for each finding that carries a `fix`, and why it would not for the rest.
 * Planning is separate from applying so the same code answers `--fix` and a dry run, and so the
 * reasons a fix is declined can be printed next to the finding that wanted it.
 */
export function planNamedTypeFixes(app: App, findings: LintFinding[]): { plans: FixPlan[]; unfixable: Unfixable[] } {
  const plans: FixPlan[] = []
  const unfixable: Unfixable[] = []
  const claimed = new Set<string>()

  for (const finding of findings) {
    if (!finding.fix || !finding.op) continue
    const registered = app.ops.get(finding.op)
    if (!registered) {
      unfixable.push({ finding, reason: `${finding.op} is not in this app` })
      continue
    }
    const site = definitionSite(registered.op)
    if (!site) {
      unfixable.push({
        finding,
        reason: `no definition site for ${finding.op}; call captureDefinitionSites() before importing the app`,
      })
      continue
    }
    const match = /^(.*):(\d+):(\d+)$/.exec(site)
    if (!match) {
      unfixable.push({ finding, reason: `unreadable definition site "${site}"` })
      continue
    }
    const [, file, line, column] = match as unknown as [string, string, string, string]

    // `apply` is a closure over the site rather than a precomputed edit: the file may already have
    // been rewritten by an earlier plan, so offsets are resolved against the text as it stands.
    const plan: FixPlan = {
      finding,
      file,
      name: finding.fix.suggestedName,
      target: `${finding.op} ${finding.fix.io}`,
      apply: () => '',
    }
    plan.apply = (text) => {
      const at = offsetOf(text, Number(line), Number(column))
      if (at === undefined) throw new FixError(`${file}:${line}:${column} is past the end of the file`)
      const property = configProperty(text, at, finding.fix!.io)
      if (!property) throw new FixError(`could not find \`${finding.fix!.io}:\` in the op at ${file}:${line}`)
      const expression = text.slice(property.start, property.end).trim()
      if (expression.startsWith('t.named(')) throw new FixError('already named')
      // `Comment as z.ZodObject<any>` is still the `Comment` declaration: an assertion says
      // something about the type, not about which schema the op was handed.
      const named = /^([A-Za-z_$][\w$]*)(?:\s+(?:as|satisfies)\s+[\s\S]+)?$/.exec(expression)?.[1]

      if (named) {
        // The common shape: `const Task = z.object({...})`, used by several ops. The identifier is
        // a better name than anything derived, and fixing the declaration fixes every op at once.
        const initializer = constInitializer(text, named)
        if (!initializer) {
          throw new FixError(
            // `constInitializer` only finds a declaration at the top level of the file, so this
            // fires for an imported schema *and* for one declared inside a function — the shape
            // an app that generates its ops in a loop always has (examples/expressibility).
            // Naming that one automatically would be wrong anyway: one declaration inside a
            // factory becomes a distinct schema per call, and they cannot all be `${named}`.
            `\`${named}\` has no top-level \`const\` declaration in ${file} — it is imported, or ` +
              `declared inside a function. Wrap it where it is defined: const ${named} = t.named('${named}', …). ` +
              `If it is built per call by a factory, give each one its own name instead.`,
          )
        }
        if (claimed.has(`${file}:${named}`)) throw new FixError('already named')
        claimed.add(`${file}:${named}`)
        plan.name = named
        plan.target = `const ${named}`
        const body = text.slice(initializer.start, initializer.end).trimEnd()
        if (body.startsWith('t.named(')) throw new FixError('already named')
        return withTImport(text.slice(0, initializer.start) + wrap(body, named) + text.slice(initializer.start + body.length))
      }

      // Written inline, so it belongs to this op alone and gets the name it would have been given.
      return withTImport(text.slice(0, property.start) + wrap(expression, finding.fix!.suggestedName) + text.slice(property.end))
    }
    plans.push(plan)
  }
  return { plans, unfixable }
}

export class FixError extends Error {}

// ---------------------------------------------------------------------------------------------
// Applying

export type FixIO = {
  read: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  /**
   * Re-lint the app in a fresh process. Returns the findings that remain, or throws if the app no
   * longer loads. Without one, edits are written unverified, which is only acceptable for a test.
   */
  verify?: () => Promise<LintFinding[]>
}

export type FixResult = {
  fixed: { file: string; target: string; name: string; rule: string }[]
  unfixable: Unfixable[]
  /** Set when the verification failed and every file was restored. */
  rolledBack?: string
}

/**
 * Apply every plan, then check. The check is the point: the edits are made by a scanner, and a
 * scanner that was wrong about one file must not leave the tree half-rewritten. Files are restored
 * byte for byte if the app stops loading, or if a finding a fix claimed to resolve is still there.
 */
export async function applyNamedTypeFixes(app: App, findings: LintFinding[], io: FixIO): Promise<FixResult> {
  const { plans, unfixable } = planNamedTypeFixes(app, findings)
  return applyFixPlans(plans, unfixable, io)
}

/** The write-and-check half, separated from planning so either can be driven on its own. */
export async function applyFixPlans(plans: FixPlan[], unfixable: Unfixable[], io: FixIO): Promise<FixResult> {
  unfixable = [...unfixable]
  const original = new Map<string, string>()
  const fixed: FixResult['fixed'] = []

  for (const plan of plans) {
    // Read from disk every time: an earlier plan may have rewritten this same file already.
    let text: string
    try {
      text = await io.read(plan.file)
    } catch {
      unfixable.push({ finding: plan.finding, reason: `could not read ${plan.file}` })
      continue
    }
    if (!original.has(plan.file)) original.set(plan.file, text)
    try {
      const next = plan.apply(text)
      if (next === text) continue
      await io.write(plan.file, next)
      fixed.push({ file: plan.file, target: plan.target, name: plan.name, rule: plan.finding.rule })
    } catch (err) {
      if (err instanceof FixError && err.message === 'already named') continue
      unfixable.push({ finding: plan.finding, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  if (!fixed.length || !io.verify) return { fixed, unfixable }

  const restore = async (reason: string): Promise<FixResult> => {
    for (const [file, text] of original) await io.write(file, text)
    return { fixed: [], unfixable: [...unfixable, ...plans.map((p) => ({ finding: p.finding, reason }))], rolledBack: reason }
  }

  let remaining: LintFinding[]
  try {
    remaining = await io.verify()
  } catch (err) {
    return restore(`the app no longer loads after the edit (${err instanceof Error ? err.message : String(err)})`)
  }
  const stillThere = remaining.filter((f) => fixed.some((x) => x.rule === f.rule))
  if (stillThere.length) {
    return restore(`the edit did not resolve ${stillThere.length} finding(s) it was meant to (${stillThere[0]!.rule})`)
  }
  return { fixed, unfixable }
}
