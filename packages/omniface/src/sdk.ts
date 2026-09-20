import type { JSONSchema } from './jsonschema.ts'
import type { Manifest, ManifestOp } from './manifest.ts'
import { hoistNamedSchemas, type HoistedSchemas } from './schemas.ts'

/**
 * The generated SDK package: `@acme/sdk`, for consumers who do not have the app's source.
 *
 * The inferred client (`createClient<typeof app>()`) is the better tool inside the repo that
 * defines the app — it needs no build step and can never be stale. It is also unavailable to
 * anyone else, because it infers its types from the server module. This emits the same client,
 * with the types written down instead of inferred, on top of the same `@omniface/client` runtime.
 *
 * What is generated is types and a constructor, never per-method request code (docs/DX.md): the
 * methods are a proxy over the manifest, so there is no generated body for a hand edit to drift.
 */
export type SdkFiles = Record<string, string>

const PREFIX = '#/'

// ---------------------------------------------------------------------------------------------
// Names

function pascal(text: string): string {
  return text.replace(/(?:^|[^A-Za-z0-9])([A-Za-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '')
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A property key as it is written in a type literal: bare when it can be, quoted when it cannot. */
function key(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** A method name that is a reserved word is still fine as a member; only bare bindings are not. */
function member(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

// ---------------------------------------------------------------------------------------------
// JSON Schema → TypeScript

const SCALARS: Record<string, string> = { string: 'string', number: 'number', integer: 'number', boolean: 'boolean', null: 'null' }

function literal(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'null'
}

/**
 * Documentation is read through union wrappers, because `.nullable()` and `.optional()` put the
 * traits on a branch: a `pii` email that can be null is `anyOf: [{…, x-omniface-pii}, {null}]`, and
 * reading only the outer node would silently drop every note on every nullable field.
 */
function annotations(schema: JSONSchema, depth = 0): JSONSchema {
  if (depth > 4) return schema
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])] as JSONSchema[]
  if (!branches.length) return schema
  const merged: JSONSchema = { ...schema }
  for (const branch of branches) {
    for (const [k, v] of Object.entries(annotations(branch, depth + 1))) {
      if ((k === 'description' || k === 'deprecated' || k === 'examples' || k.startsWith('x-omniface-')) && merged[k] === undefined) merged[k] = v
    }
  }
  return merged
}

function docComment(node: JSONSchema, indent: string): string {
  const schema = annotations(node)
  const lines: string[] = []
  if (typeof schema.description === 'string') lines.push(...schema.description.split('\n'))
  if (Array.isArray(schema.examples) && schema.examples.length) lines.push(`@example ${JSON.stringify(schema.examples[0])}`)
  if (schema.deprecated) lines.push(`@deprecated${typeof schema['x-omniface-deprecated'] === 'string' ? ` ${schema['x-omniface-deprecated']}` : ''}`)
  // Traits a consumer can act on. `pii` and `sensitive` change how a value may be logged, which is
  // the consumer's problem too, so they are said out loud rather than left in the OpenAPI document.
  const notes = ['pii', 'sensitive'].filter((trait) => schema[`x-omniface-${trait}`])
  if (notes.length) lines.push(`Personal data (${notes.join(', ')}): do not log or cache this value.`)
  if (!lines.length) return ''
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`
  // Blank lines between, or a renderer runs the description and the notes into one paragraph.
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join(`\n${indent} *\n`)}\n${indent} */\n`
}

/**
 * The TypeScript for one schema node. References resolve to the type name they were hoisted
 * under, so a named type is written once and mentioned everywhere.
 */
function tsType(schema: JSONSchema | undefined, indent: string): string {
  if (!schema) return 'unknown'
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith(PREFIX)) return schema.$ref.slice(PREFIX.length)
  if ('const' in schema) return literal(schema.const)
  if (Array.isArray(schema.enum)) return schema.enum.length ? schema.enum.map(literal).join(' | ') : 'never'

  const branches = schema.anyOf ?? schema.oneOf
  if (Array.isArray(branches) && branches.length) {
    const parts = [...new Set(branches.map((b: JSONSchema) => tsType(b, indent)))]
    return parts.length === 1 ? parts[0]! : parts.map((p) => (p.includes(' ') && !p.endsWith('}') ? `(${p})` : p)).join(' | ')
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.map((b: JSONSchema) => tsType(b, indent)).join(' & ')
  }

  const type = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (type.length > 1) return type.map((t: string) => tsType({ ...schema, type: t }, indent)).join(' | ')
  const only = type[0]
  if (only === 'array') return `${wrap(tsType(schema.items, indent))}[]`
  if (only === 'object' || (!only && schema.properties)) return objectType(schema, indent)
  if (only && SCALARS[only]) return SCALARS[only]!
  return 'unknown'
}

/** `A | B` needs brackets before `[]`; a single name or object literal does not. */
function wrap(type: string): string {
  return /[|&]/.test(type) ? `(${type})` : type
}

function objectType(schema: JSONSchema, indent: string): string {
  const properties = (schema.properties ?? {}) as Record<string, JSONSchema>
  const entries = Object.entries(properties)
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
  if (!entries.length) {
    const extra = schema.additionalProperties
    if (extra && typeof extra === 'object') return `Record<string, ${tsType(extra as JSONSchema, indent)}>`
    // A closed object with no properties takes nothing, which is what an op with no input is.
    return extra === false ? 'Record<string, never>' : 'Record<string, unknown>'
  }
  const inner = indent + '  '
  const body = entries
    .map(([name, value]) => `${docComment(value, inner)}${inner}${key(name)}${required.has(name) ? '' : '?'}: ${tsType(value, inner)}`)
    .join('\n')
  return `{\n${body}\n${indent}}`
}

// ---------------------------------------------------------------------------------------------
// The type table: every named type, plus one per op input and output that is not already named

type TypeTable = { order: string[]; schemas: Record<string, JSONSchema>; opTypes: Record<string, { input: string; output: string }> }

function typeTable(manifest: Manifest, hoisted: HoistedSchemas): TypeTable {
  const schemas: Record<string, JSONSchema> = { ...hoisted.schemas }
  const order = Object.keys(schemas).sort()
  const opTypes: TypeTable['opTypes'] = {}

  const add = (base: string, schema: JSONSchema): string => {
    let name = base
    for (let n = 2; schemas[name]; n++) name = `${base}${n}`
    schemas[name] = schema
    order.push(name)
    return name
  }

  for (const op of manifest.ops) {
    const io = hoisted.ops[op.id]!
    const named = (side: JSONSchema, suffix: string) =>
      typeof side.$ref === 'string' && side.$ref.startsWith(PREFIX) ? side.$ref.slice(PREFIX.length) : add(pascal(`${op.id} ${suffix}`), side)
    opTypes[op.id] = { input: named(io.input, 'input'), output: named(io.output, 'output') }
  }
  return { order, schemas, opTypes }
}

function declarations(table: TypeTable): string {
  return table.order
    .map((name) => {
      const schema = table.schemas[name]!
      const doc = docComment(schema, '')
      const body = tsType(schema, '')
      // An object type is an interface so a consumer can extend or augment it; anything else has
      // no members to extend, so an alias is the honest shape. A union of objects renders as
      // `{…} | {…}`, which also starts with `{` but is not a single object: emitted as an
      // interface it produces a .d.ts that does not parse, so the branch keys decide, not the text.
      const isUnion = Boolean(schema.anyOf ?? schema.oneOf ?? schema.allOf)
      return !isUnion && body.startsWith('{')
        ? `${doc}export interface ${name} ${body}\n`
        : `${doc}export type ${name} = ${body}\n`
    })
    .join('\n')
}

// ---------------------------------------------------------------------------------------------
// The method tree

type MethodNode = { ops: Record<string, ManifestOp>; children: Record<string, MethodNode> }

function methodTree(ops: ManifestOp[]): MethodNode {
  const root: MethodNode = { ops: {}, children: {} }
  for (const op of ops) {
    if (!op.sdk) continue
    const path = op.sdk.method
    let node = root
    for (const segment of path.slice(0, -1)) node = node.children[segment] ??= { ops: {}, children: {} }
    node.ops[path[path.length - 1]!] = op
  }
  return root
}

/** Whether the call can be made with no argument at all: nothing in the input is required. */
function inputOptional(schema: JSONSchema, table: TypeTable): boolean {
  const resolved = typeof schema.$ref === 'string' ? table.schemas[schema.$ref.slice(PREFIX.length)] : schema
  return !Array.isArray(resolved?.required) || resolved.required.length === 0
}

function methodDoc(op: ManifestOp, indent: string): string {
  const lines: string[] = []
  if (op.description) lines.push(op.description)
  const facets: string[] = []
  if (op.rest) facets.push(`\`${op.rest.method} ${op.rest.path}\``)
  if (op.cli) facets.push(`\`${op.cli.command.join(' ')}\``)
  if (op.mcp && 'tool' in op.mcp) facets.push(`MCP \`${op.mcp.tool}\``)
  if (facets.length) lines.push(`The same operation as ${facets.join(', ')}.`)
  if (op.traits.destructive) lines.push('Irreversible.')
  if (op.errors.length) lines.push(`Throws \`FacetClientError\` with code: ${op.errors.map((e) => `\`${e}\``).join(', ')}.`)
  if (!lines.length) return ''
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join(`\n${indent} *\n`)}\n${indent} */\n`
}

function methodSignatures(node: MethodNode, table: TypeTable, indent: string): string {
  const parts: string[] = []
  for (const [name, op] of Object.entries(node.ops).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const { input, output } = table.opTypes[op.id]!
    if (op.traits.paginated) {
      parts.push(`${methodDoc(op, indent)}${indent}readonly ${member(name)}: ${pascal(op.id)}Method`)
    } else {
      const arg = `input${inputOptional({ $ref: PREFIX + input }, table) ? '?' : ''}: ${input}`
      parts.push(`${methodDoc(op, indent)}${indent}${member(name)}(${arg}): Promise<${output}>`)
    }
  }
  for (const [name, child] of Object.entries(node.children).sort(([a], [b]) => (a < b ? -1 : 1))) {
    parts.push(`${indent}readonly ${member(name)}: {\n${methodSignatures(child, table, indent + '  ')}\n${indent}}`)
  }
  return parts.join('\n')
}

/**
 * A paginated method is callable *and* has members, so it gets an interface of its own. The item
 * type is read off the page shape rather than assumed, so an op whose page is not `{ items }`
 * simply does not get the iterators.
 */
function paginatedInterfaces(manifest: Manifest, table: TypeTable): string {
  const out: string[] = []
  for (const op of manifest.ops) {
    if (!op.sdk || !op.traits.paginated) continue
    const { input, output } = table.opTypes[op.id]!
    const page = table.schemas[output]
    const items = (page?.properties?.items ?? {}) as JSONSchema
    const item = items.type === 'array' ? tsType(items.items, '') : 'unknown'
    const optional = inputOptional({ $ref: PREFIX + input }, table) ? '?' : ''
    out.push(
      [
        `export interface ${pascal(op.id)}Method {`,
        `  /** One page. */`,
        `  (input${optional}: ${input}): Promise<${output}>`,
        `  /** Every page, one item at a time, fetching as it goes. */`,
        `  iterate(input${optional}: ${input}): AsyncIterable<${item}>`,
        `  /** Every page, collected into one array. Fetches all of them, so mind the size. */`,
        `  autoPaginate(input${optional}: ${input}): Promise<${item}[]>`,
        `}`,
        '',
      ].join('\n'),
    )
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------
// The package

function optionDocs(manifest: Manifest): { types: string; specs: string } {
  const specs = manifest.adapters.flatMap((a) => (a.sdk?.options ?? []).map((o) => ({ ...o, plugin: a.plugin })))
  const types = specs
    .map((o) => `  /** ${o.summary} (from the \`${o.plugin}\` plugin) */\n  ${key(o.name)}?: ${o.type ?? 'string'}`)
    .join('\n')
  return { types, specs: JSON.stringify(specs.map(({ name, header, credential }) => ({ name, header, credential }))) }
}

export function buildSdk(manifest: Manifest, options: { clientImport?: string; facetVersion: string }): SdkFiles {
  const packageName = manifest.sdk?.packageName ?? `${manifest.name}-sdk`
  const clientImport = options.clientImport ?? '@omniface/client'
  const hoisted = hoistNamedSchemas(manifest, PREFIX)
  const table = typeTable(manifest, hoisted)
  const tree = methodTree(manifest.ops)
  const methods = methodSignatures(tree, table, '  ')
  const clientType = `${pascal(manifest.name)}Client`
  const optionsType = `${clientType}Options`
  const factory = `create${clientType}`
  const { types: pluginOptionTypes, specs } = optionDocs(manifest)

  const dts = [
    `// Generated by \`omniface build\`. Do not edit: change the app definition and rebuild.`,
    `// ${manifest.name} v${manifest.version}`,
    '',
    `import type { Caller, ClientOptions } from '${clientImport}'`,
    `export { FacetClientError } from '${clientImport}'`,
    `export type { Caller, ClientErrorCode } from '${clientImport}'`,
    '',
    '// --- Types -----------------------------------------------------------------------------',
    '',
    declarations(table),
    '// --- Methods ---------------------------------------------------------------------------',
    '',
    paginatedInterfaces(manifest, table),
    `/**`,
    ` * ${manifest.description ?? `${manifest.name} API`}`,
    ` *`,
    ` * Every method is the same operation the REST API, the CLI and the MCP server expose.`,
    ` */`,
    `export interface ${clientType} {`,
    `  /** The manifest-driven transport underneath, for an op this SDK does not name. */`,
    `  readonly $caller: Caller`,
    methods,
    `}`,
    '',
    `export type ${optionsType} = Omit<ClientOptions, 'manifest' | 'via'>${pluginOptionTypes ? ` & {\n${pluginOptionTypes}\n}` : ''}`,
    '',
    `/** Connect to a deployed \`${manifest.name}\`. */`,
    `export declare function ${factory}(options: ${optionsType}): ${clientType}`,
    `export default ${factory}`,
    '',
  ].join('\n')

  const mjs = [
    `// Generated by \`omniface build\`. Do not edit: change the app definition and rebuild.`,
    `import { createClient } from '${clientImport}'`,
    `import manifest from './manifest.json' with { type: 'json' }`,
    '',
    `export { FacetClientError } from '${clientImport}'`,
    '',
    `// What plugins declared for this facet (manifest.adapters[].sdk.options). A constructor option`,
    `// is either the caller's credential or a header — a plugin cannot add behaviour to the SDK,`,
    `// because the SDK does not run in the server's process.`,
    `const PLUGIN_OPTIONS = ${specs}`,
    '',
    `export function ${factory}(options) {`,
    `  const { headers, ...rest } = options`,
    `  const extra = { ...headers }`,
    `  let apiKey = options.apiKey`,
    `  for (const spec of PLUGIN_OPTIONS) {`,
    `    const value = rest[spec.name]`,
    `    delete rest[spec.name]`,
    `    if (value === undefined) continue`,
    `    if (spec.header) extra[spec.header] = String(value)`,
    `    else if (spec.credential) apiKey ??= String(value)`,
    `  }`,
    `  return createClient({ ...rest, apiKey, headers: extra, manifest, clientName: ${JSON.stringify(`${packageName}/${manifest.version}`)} })`,
    `}`,
    '',
    `export default ${factory}`,
    '',
  ].join('\n')

  const pkg =
    JSON.stringify(
      {
        name: packageName,
        version: manifest.version,
        description: `${manifest.name} TypeScript SDK (generated by facet)`,
        type: 'module',
        main: './index.mjs',
        types: './index.d.ts',
        exports: { '.': { types: './index.d.ts', default: './index.mjs' }, './package.json': './package.json' },
        files: ['index.mjs', 'index.d.ts', 'manifest.json'],
        dependencies: { '@omniface/client': `^${options.facetVersion}` },
      },
      null,
      2,
    ) + '\n'

  const readme = [
    `# ${packageName}`,
    '',
    manifest.description ?? `The ${manifest.name} API as a TypeScript SDK.`,
    '',
    'Generated by [omniface](https://github.com/sys13/omniface) from the app definition. Do not edit:',
    'every method here is the same operation the REST API, the CLI and the MCP server expose, and',
    '`omniface conformance` proves they agree.',
    '',
    '```ts',
    `import { ${factory} } from '${packageName}'`,
    '',
    `const client = ${factory}({ baseUrl: 'https://api.example.com', apiKey: process.env.API_KEY })`,
    '```',
    '',
    'Errors are `FacetClientError`, carrying the same `code` every other facet reports. Paginated',
    'methods add `.iterate()` (one item at a time) and `.autoPaginate()` (all of them at once).',
    '',
  ].join('\n')

  return {
    'sdk/package.json': pkg,
    'sdk/manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'sdk/index.mjs': mjs,
    'sdk/index.d.ts': dts,
    'sdk/README.md': readme,
  }
}
