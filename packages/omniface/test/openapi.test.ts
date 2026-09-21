import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildManifest, facet, paginate } from '../src/index.ts'
import { buildOpenApi } from '../src/facets/openapi.ts'
import { hoistNamedSchemas } from '../src/schemas.ts'
import type { JSONSchema } from '../src/jsonschema.ts'
import { t } from '../src/zod/index.ts'

type Folder = { id: string; children: Folder[] }
const Folder: z.ZodType<Folder> = t.named(
  'Folder',
  z.lazy(() => z.object({ id: t.id(), children: z.array(Folder) })),
)
const File = t.named('File', z.object({ id: t.id(), name: z.string(), owner: t(z.email(), { pii: true }).nullable() }))
const FileId = t.named('FileId', z.object({ id: t.id() }))

function driveApp() {
  const f = facet()
  const ops = {
    files: {
      get: f.op({ description: 'Get one file', input: FileId, output: File, errors: ['not_found'] }).traits({ readonly: true }).handle(() => file()),
      list: f
        .op({ input: t.pageInput({ folder: z.string().optional() }), output: t.page(File) })
        .traits({ readonly: true, paginated: true })
        .handle(({ input }) => paginate([file()], input)),
      rename: f.op({ input: FileId.extend({ name: z.string() }), output: File }).traits({ idempotent: true }).handle(() => file()),
      tree: f.op({ input: z.object({}), output: z.object({ root: Folder }) }).traits({ readonly: true }).handle(() => ({ root: { id: 'f1', children: [] } })),
    },
  }
  return f.app({ name: 'drive', version: '1.2.3', ops })
}

const file = () => ({ id: 'file_1', name: 'notes.md', owner: null })

/** Every `$ref` in a document, with the JSON pointer it was found at. */
function refs(node: unknown, at = '#'): { at: string; ref: string }[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => refs(n, `${at}/${i}`))
  if (!node || typeof node !== 'object') return []
  const out: { at: string; ref: string }[] = []
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') out.push({ at, ref: value })
    else out.push(...refs(value, `${at}/${key}`))
  }
  return out
}

function resolve(doc: JSONSchema, ref: string): unknown {
  if (!ref.startsWith('#/')) return ref === '#' ? doc : undefined
  let node: any = doc
  for (const part of ref.slice(2).split('/')) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  return node
}

describe('OpenAPI', () => {
  const manifest = buildManifest(driveApp())
  const doc = buildOpenApi(manifest)

  it('resolves every reference it emits', () => {
    // The regression this was written for: a recursive type comes out of zod as `{ $ref: "#" }`
    // or `{ $ref: "#/$defs/…" }`, rooted at the *op's* schema. Inlined into an OpenAPI document
    // those point at nothing, and nothing downstream notices until a generator falls over.
    const found = refs(doc)
    expect(found.length).toBeGreaterThan(0)
    for (const { at, ref } of found) {
      expect(resolve(doc, ref), `dangling $ref "${ref}" at ${at}`).toBeDefined()
    }
    expect(found.every(({ ref }) => ref.startsWith('#/components/schemas/'))).toBe(true)
  })

  it('hoists named types into components, so one model is shared by every method', () => {
    expect(Object.keys(doc.components.schemas).sort()).toEqual(['File', 'FileId', 'Folder'])
    expect(doc.paths['/files/{id}'].get.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/File',
    })
    // A recursive type points at itself by name rather than at the document root.
    expect(doc.components.schemas.Folder.properties.children.items).toEqual({ $ref: '#/components/schemas/Folder' })
    // Field traits ride along on the hoisted model, which is how they reach another generator.
    expect(doc.components.schemas.File.properties.owner.anyOf[0]['x-omniface-pii']).toBe(true)
  })

  it('looks through a named input to find the path and query parameters', () => {
    // `files.get` takes `FileId`, which is a reference now; the path parameter still has to be
    // found, and with the field's own scalar trait rather than a guessed string.
    expect(doc.paths['/files/{id}'].get.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true, schema: expect.objectContaining({ 'x-omniface-scalar': 'id' }) }),
    ])
    expect(doc.paths['/files'].get.parameters.map((p: { name: string }) => p.name).sort()).toEqual(['cursor', 'folder', 'limit'])
  })

  it('keeps a body that is exactly a named type as a reference, and materialises one that is not', () => {
    // `files.rename` puts `id` in the path, so its body is `FileId & { name }` minus `id` — a
    // different type from anything the author named, so it is written out.
    const body = doc.paths['/files/{id}/rename'].post.requestBody.content['application/json'].schema
    expect(Object.keys(body.properties)).toEqual(['name'])
  })

  it('carries every facet’s view of an op as x-omniface-*', () => {
    const get = doc.paths['/files/{id}'].get
    expect(get['x-omniface-op']).toBe('files.get')
    expect(get['x-omniface-traits']).toEqual({ readonly: true })
    expect(get['x-omniface-errors']).toEqual(['not_found'])
    expect(get['x-omniface-sdk']).toEqual({ method: ['files', 'get'] })
    expect(get['x-omniface-cli']).toEqual({ command: ['files', 'get'], args: ['id'] })
    expect(get['x-omniface-mcp']).toMatchObject({ tool: 'files_get' })
    // Pagination is what a generator needs to offer auto-pagination of its own.
    expect(doc.paths['/files'].get['x-omniface-pagination']).toEqual({
      style: 'cursor',
      cursor: 'cursor',
      limit: 'limit',
      items: 'items',
      nextCursor: 'nextCursor',
    })
    expect(get['x-omniface-pagination']).toBeUndefined()
    expect(doc['x-facet']).toMatchObject({ manifest: 2, facets: ['rest', 'mcp', 'cli', 'sdk'] })
  })

  it('reports one name used for two different shapes instead of silently picking one', () => {
    const f = facet()
    const ops = {
      a: { one: f.op({ input: z.object({}), output: t.named('Thing', z.object({ id: z.string() })) }).traits({ readonly: true }).handle(() => ({ id: 'x' })) },
      b: { two: f.op({ input: z.object({}), output: t.named('Thing', z.object({ label: z.number() })) }).traits({ readonly: true }).handle(() => ({ label: 1 })) },
    }
    const hoisted = hoistNamedSchemas(buildManifest(f.app({ name: 'clash', version: '0.0.1', ops })))
    expect(hoisted.conflicts).toEqual([{ name: 'Thing', ops: ['a.one', 'b.two'] }])
    // The first shape keeps the name: renaming around a conflict would make the document depend
    // on the order ops happen to be declared in.
    expect(Object.keys(hoisted.schemas.Thing!.properties)).toEqual(['id'])
  })
})
