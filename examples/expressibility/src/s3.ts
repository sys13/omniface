/**
 * Study subject: S3-style object storage.
 *
 * Why this one: facet's core assumption is that an operation is a JSON value in and a JSON value
 * out. Object storage is the cleanest counterexample — the payload *is* opaque bytes, the content
 * type is the caller's, and the interesting operations are about ranges and redirects rather than
 * fields. This is the subject that does not fit, and it is included to mark the boundary
 * precisely rather than to argue it.
 */
import { errors, facet, paginate } from 'omniface'
import { apiKeys, logging, scopes } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'

const Bucket = t.named(
  'Bucket',
  z.object({
    name: t.id({ example: 'my-bucket' }),
    region: z.string(),
    createdAt: t.datetime(),
  }),
)
type Bucket = z.infer<typeof Bucket>

/**
 * FRICTION 7 — keys are paths.
 *
 * An S3 key is `photos/2026/cat.jpg`: it contains slashes. A REST path override of
 * `/{bucket}/{key}` binds `key` to one path segment, so the *literal* form S3 itself uses —
 * `GET /b/photos/2026/cat.jpg` — 404s. Percent-encoded, `GET /b/photos%2F2026%2Fcat.jpg`
 * answers 200, and facet's own SDK, CLI and MCP clients all encode, so the four facets do agree
 * (probe-agreement.mjs checks exactly this). What is lost is compatibility with the wire format
 * an existing S3 client or a hand-written curl already speaks: a wildcard path segment is not
 * expressible in `RestOverride` (`{ method, path, status }`), and the router underneath would
 * need `:key{.+}` to match one.
 */
const ObjectMeta = t.named(
  'ObjectMeta',
  z.object({
    bucket: t.id(),
    key: t(z.string().min(1), { example: 'photos/2026/cat.jpg' }),
    size: z.number().int(),
    contentType: z.string(),
    etag: z.string(),
    updatedAt: t.datetime(),
  }),
)
type ObjectMeta = z.infer<typeof ObjectMeta>

export function createStorageApp() {
  const f = facet({
    plugins: [
      logging(),
      apiKeys({ prefix: 'akia_', keys: [{ key: 'akia_admin', principalId: 'root', scopes: ['*'] }] }),
      scopes(),
    ],
  })

  const buckets = new Map<string, Bucket>()
  const objects = new Map<string, ObjectMeta & { body: string }>()
  const objectKey = (bucket: string, key: string) => `${bucket}/${key}`

  const findObject = (bucket: string, key: string) => {
    const found = objects.get(objectKey(bucket, key))
    if (!found) throw errors.notFound(`No object "${key}" in "${bucket}"`)
    return found
  }

  const ops = {
    buckets: {
      create: f
        .op({ description: 'Create a bucket', input: Bucket.pick({ name: true, region: true }).partial({ region: true }), output: Bucket, errors: ['conflict'] })
        .traits({ scope: 'storage:write' })
        .handle(({ input }) => {
          if (buckets.has(input.name)) throw errors.conflict(`Bucket "${input.name}" already exists`)
          const bucket: Bucket = { name: input.name, region: input.region ?? 'us-east-1', createdAt: new Date().toISOString() }
          buckets.set(bucket.name, bucket)
          return bucket
        }),

      list: f
        .op({ description: 'List buckets', input: t.pageInput(), output: t.page(Bucket) })
        .traits({ readonly: true, paginated: true, scope: 'storage:read' })
        .handle(({ input }) => paginate([...buckets.values()], input)),
    },

    objects: {
      /**
       * FRICTION 8 — the body is not a field.
       *
       * The real `PutObject` takes raw bytes with the caller's own `Content-Type`. The only way to
       * say that here is to declare the body as a *field* — base64 in a JSON envelope — which is
       * expressible but is a different API: it forbids streaming, inflates the payload by a third
       * and puts a whole object in memory on both sides. Nothing in the trait vocabulary marks a
       * field as "this is the request body, sent raw".
       */
      put: f
        .op({
          description: 'Upload an object (body base64-encoded — see FRICTION 8)',
          input: z.object({
            bucket: t.id(),
            key: z.string().min(1),
            contentType: z.string().default('application/octet-stream'),
            body: t(z.base64(), { description: 'The object’s bytes, base64-encoded' }),
          }),
          output: ObjectMeta,
          errors: ['not_found'],
        })
        .traits({ idempotent: true, scope: 'storage:write' })
        .handle(({ input }) => {
          if (!buckets.has(input.bucket)) throw errors.notFound(`No bucket "${input.bucket}"`)
          const meta = {
            bucket: input.bucket,
            key: input.key,
            size: Buffer.from(input.body, 'base64').byteLength,
            contentType: input.contentType,
            etag: `"${Buffer.from(input.key).toString('hex').slice(0, 16)}"`,
            updatedAt: new Date().toISOString(),
            body: input.body,
          }
          objects.set(objectKey(meta.bucket, meta.key), meta)
          const { body, ...rest } = meta
          return rest
        }),

      /**
       * `GetObject` has the same problem in reverse, plus one more: a real GET answers with the
       * object's own content type and supports `Range`. Here every facet gets JSON with a base64
       * string in it, and a range request has nowhere to live — `RestOverride` cannot add a
       * request header, and a `range` *field* would be a different protocol from the one every
       * S3 client already speaks.
       */
      get: f
        .op({
          description: 'Download an object (body base64-encoded — see FRICTION 8)',
          input: z.object({ bucket: t.id(), key: z.string().min(1) }),
          output: ObjectMeta.extend({ body: z.base64() }),
          errors: ['not_found'],
        })
        .traits({ readonly: true, scope: 'storage:read' })
        .handle(({ input }) => findObject(input.bucket, input.key)),

      /** Metadata alone fits perfectly: it is a JSON value. This is the half of S3 facet is for. */
      head: f
        .op({
          description: 'Get an object’s metadata without its bytes',
          input: z.object({ bucket: t.id(), key: z.string().min(1) }),
          output: ObjectMeta,
          errors: ['not_found'],
        })
        .traits({ readonly: true, scope: 'storage:read' })
        .handle(({ input }) => {
          const { body, ...rest } = findObject(input.bucket, input.key)
          return rest
        }),

      list: f
        .op({
          description: 'List objects under a prefix',
          input: t.pageInput({ bucket: t.id(), prefix: z.string().optional() }),
          output: t.page(ObjectMeta),
        })
        .traits({ readonly: true, paginated: true, scope: 'storage:read' })
        .handle(({ input }) => {
          const all = [...objects.values()]
            .filter((o) => o.bucket === input.bucket && (!input.prefix || o.key.startsWith(input.prefix)))
            .map(({ body, ...rest }) => rest)
          return paginate(all, input)
        }),

      delete: f
        .op({
          description: 'Delete an object permanently',
          input: z.object({ bucket: t.id(), key: z.string().min(1) }),
          output: z.object({ bucket: z.string(), key: z.string(), deleted: z.literal(true) }),
          errors: ['not_found'],
        })
        .traits({ destructive: true, idempotent: true, scope: 'storage:write' })
        .handle(({ input }) => {
          findObject(input.bucket, input.key)
          objects.delete(objectKey(input.bucket, input.key))
          return { bucket: input.bucket, key: input.key, deleted: true as const }
        }),

      /**
       * FITS, and it is the interesting answer. A presigned URL is a JSON value that *describes*
       * a byte transfer without performing one — so the bytes leave facet's world entirely and
       * the operation stays a normal op on all four facets. If facet never grows a binary
       * payload, this is the idiom that makes object storage expressible anyway.
       */
      presign: f
        .op({
          description: 'Get a short-lived URL to upload or download an object directly',
          input: z.object({
            bucket: t.id(),
            key: z.string().min(1),
            method: z.enum(['get', 'put']),
            expiresInSeconds: z.number().int().min(1).max(604800).default(900),
          }),
          output: z.object({ url: t.url(), method: z.enum(['get', 'put']), expiresAt: t.datetime() }),
          errors: ['not_found'],
        })
        .traits({ readonly: true, scope: 'storage:read' })
        .handle(({ input }) => {
          if (!buckets.has(input.bucket)) throw errors.notFound(`No bucket "${input.bucket}"`)
          return {
            url: `https://storage.test/${input.bucket}/${input.key}?sig=stub&expires=${input.expiresInSeconds}`,
            method: input.method,
            expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
          }
        }),
    },
  }

  return f.app({
    name: 'storage',
    version: '0.1.0',
    description: 'S3-shaped object storage, as far as an op-shaped core reaches',
    ops,
    facets: {
      rest: {
        ops: {
          // The closest the override vocabulary gets to S3's real routes. `{key}` matches one
          // segment, so a nested key has to arrive percent-encoded; facet's own clients do that,
          // an existing S3 client does not.
          'objects.get': { path: '/{bucket}/{key}' },
          'objects.head': { method: 'GET', path: '/{bucket}/{key}/head' },
          'objects.delete': { path: '/{bucket}/{key}' },
        },
      },
      sdk: true,
      cli: {
        binName: 'st',
        ops: { 'objects.list': { columns: ['key', 'size', 'contentType'] } },
      },
      mcp: {
        // An agent should never be handed a megabyte of base64. Turning the byte-moving ops off
        // for MCP is a one-word decision, and the presign op is the one it should use instead.
        ops: { 'objects.get': false, 'objects.put': false },
      },
    },
  })
}

const app = createStorageApp()
export default app
