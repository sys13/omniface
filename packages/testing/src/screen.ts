import {
  MASK,
  objectProperties,
  presentFields,
  presentValue,
  tableColumns,
  type FieldPresentation,
  type JSONSchema,
  type ManifestOp,
} from 'omniface'

/**
 * What reached the page, checked against what the record said and what the rules allow.
 *
 * `outcomesAgree` deliberately does not compare a screen to a record field for field — a rendering
 * and a document are not the same kind of thing, and the reasoning is written down at
 * `harness.ts:18-26`. That comment also names the gap this file closes: *a test that cares what
 * reached the page reads the HTML.* Until now no generated test did, so the web facet's only
 * generated assertion was that the screen was not a 500.
 *
 * This is not a second interpretation of the trait rules. It asks `presentation.ts` — the same
 * table the web facet renders from and the CLI's output layer reads — what the op should show for
 * this call, and diffs that against the screen and against the REST payload for the same call. A
 * third restatement of the rules is the drift the project exists to stop; there isn't one here.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name]!)
}

/** The text a person actually sees in one cell: no markup, and not the reveal button's label. */
function visibleText(fragment: string): string {
  return decode(
    fragment
      .replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, '')
      .replace(/<[^>]+>/g, ''),
  ).trim()
}

/** The screen renders an absent value as an em dash; the rules render it as nothing. */
const EMPTY = '—'

function cellsOf(fragment: string, tag: 'td' | 'dd'): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of fragment.matchAll(new RegExp(`<${tag} data-field="([^"]+)">([\\s\\S]*?)</${tag}>`, 'g'))) {
    out.set(decode(m[1]!), m[2]!)
  }
  return out
}

/** Every `<th>`/`<dt>` by the field it heads, so a deprecated mark can be looked for on it. */
function headersOf(html: string, tag: 'th' | 'dt'): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*\\bdata-field="([^"]+)"[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))) {
    out.set(decode(m[1]!), m[2]!)
  }
  return out
}

function tableBodyRows(html: string): Map<string, string>[] {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? ''
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => cellsOf(row[1]!, 'td'))
}

/** The row schema of a paginated output, or undefined when the op does not return a page. */
function rowSchema(op: ManifestOp): JSONSchema | undefined {
  const items = objectProperties(op.output)['items']
  return (items?.items ?? undefined) as JSONSchema | undefined
}

function compareRecord(
  where: string,
  cells: Map<string, string>,
  expected: readonly string[],
  fields: Map<string, FieldPresentation>,
  record: Record<string, unknown>,
  problems: string[],
): void {
  // The field set, which is also the internal check: `presentFields` drops `internal` fields, so a
  // screen showing one shows a field the rules did not list. It cannot fail today — the pipeline
  // strips internal before any facet sees it, and the manifest's schemas never carried it — and it
  // is here for the day someone renders from a raw schema instead of the manifest.
  const on = [...cells.keys()]
  if (JSON.stringify(on) !== JSON.stringify([...expected])) {
    problems.push(`${where}: shows [${on.join(', ')}], the rules say [${expected.join(', ')}]`)
    return
  }
  for (const name of expected) {
    const field = fields.get(name)!
    const shown = visibleText(cells.get(name)!)
    const want = presentValue(record[name], field)
    if (field.sensitive) {
      // Masked rather than absent: the field is on screen, and what is on it is the mask. That the
      // field is present at all is the field-set check above; this is what is written in it.
      if (shown === MASK) continue
      const clear = presentValue(record[name])
      problems.push(
        clear && shown.includes(clear)
          ? `${where}.${name}: the sensitive value is on screen in the clear`
          : `${where}.${name}: sensitive field shows "${shown}", expected the mask`,
      )
      continue
    }
    const normalised = shown === EMPTY ? '' : shown
    if (normalised === want) continue
    // pii is not masked on a person-facing facet: it is the caller's own data, answered by the same
    // pipeline that answered REST. So the rule for pii is the ordinary one, and it is named here
    // only so a screen that quietly redacts it says which rule it broke.
    problems.push(
      field.pii
        ? `${where}.${name}: pii shows "${shown}", REST says "${want}"`
        : `${where}.${name}: shows "${shown}", REST says "${want}"`,
    )
  }
}

function checkDeprecatedMarks(
  where: string,
  headers: Map<string, string>,
  fields: Map<string, FieldPresentation>,
  problems: string[],
): void {
  for (const [name, fragment] of headers) {
    const field = fields.get(name)
    if (field?.deprecated === undefined) continue
    if (!fragment.includes('class="dep"')) problems.push(`${where}.${name}: deprecated, but the screen does not say so`)
  }
}

/**
 * The generated web check: every disagreement between the screen, the rules and the REST payload
 * for the same call. Empty means the page says exactly what the record said, the way the rules say
 * to say it.
 */
export function screenProblems(op: ManifestOp, html: string, restValue: unknown): string[] {
  const problems: string[] = []
  const kind = op.web?.kind
  if (kind !== 'table' && kind !== 'detail') return problems

  const schema = kind === 'table' ? rowSchema(op) : op.output
  const fields = new Map(presentFields(schema, op.output).map((f) => [f.name, f]))

  if (kind === 'detail') {
    const record = (restValue ?? {}) as Record<string, unknown>
    const expected = op.web!.fields.filter((name) => fields.has(name))
    const cells = cellsOf(html, 'dd')
    if (!expected.length) return problems
    if (!cells.size && !Object.keys(record).length) {
      problems.push('the screen and REST both showed nothing; this case proved nothing — give the op a setup')
      return problems
    }
    compareRecord('detail', cells, expected, fields, record, problems)
    checkDeprecatedMarks('detail', headersOf(html, 'dt'), fields, problems)
    return problems
  }

  const page = (restValue ?? {}) as { items?: Record<string, unknown>[] }
  const items = page.items ?? []
  const rows = tableBodyRows(html)
  if (!items.length && !rows.length) {
    problems.push('the screen and REST both returned no rows; this case proved nothing — give the op a setup')
    return problems
  }
  if (rows.length !== items.length) {
    problems.push(`the table shows ${rows.length} row(s), REST returned ${items.length}`)
    return problems
  }
  const expected = tableColumns(schema, op.output, op.web!.fields)
  const headers = headersOf(html, 'th')
  const onHead = [...headers.keys()]
  if (JSON.stringify(onHead) !== JSON.stringify(expected)) {
    problems.push(`table head: shows [${onHead.join(', ')}], the rules say [${expected.join(', ')}]`)
    return problems
  }
  checkDeprecatedMarks('table', headers, fields, problems)
  rows.forEach((cells, i) => compareRecord(`row ${i}`, cells, expected, fields, items[i]!, problems))
  return problems
}
