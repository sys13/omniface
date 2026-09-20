/**
 * Study subject: Kubernetes.
 *
 * Why this one: every other subject has an operation set the author knows when they write the
 * file. Kubernetes does not — a cluster's API surface depends on which CRDs are installed, and
 * the same six verbs (get, list, create, apply, delete, watch) apply uniformly to whatever
 * resources exist. This is the test of whether facet's "everything is code" holds when the code
 * has to *compute* the operations rather than write them out.
 *
 * The answer, demonstrated below: ops generate fine at runtime — `f.app({ ops })` takes a plain
 * object, so a loop builds it — and the type layer follows as long as the resource table is
 * `as const`. What does not follow is the *facet override keys*, which are checked against the
 * generated ids, and `watch`, which is a stream.
 */
import { errors, facet, paginate } from 'omniface'
import { apiKeys, logging, scopes } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'

/** Every Kubernetes object shares this envelope; the spec is what differs. */
const ObjectMeta = t.named(
  'ObjectMeta',
  z.object({
    name: t.id({ example: 'web-7d9f' }),
    namespace: t.id({ example: 'default' }),
    labels: z.record(z.string(), z.string()),
    resourceVersion: z.string(),
    createdAt: t.datetime(),
  }),
)

const DeploymentSpec = t.named(
  'DeploymentSpec',
  z.object({ replicas: z.number().int().min(0), image: z.string().min(1) }),
)
const ServiceSpec = t.named(
  'ServiceSpec',
  z.object({ port: z.number().int(), targetPort: z.number().int(), type: z.enum(['ClusterIP', 'NodePort', 'LoadBalancer']) }),
)
const ConfigMapSpec = t.named('ConfigMapSpec', z.object({ data: z.record(z.string(), z.string()) }))

/**
 * The resource table. In a real cluster this is discovery output, not a literal — which is the
 * point: the shape below is what the generated app is built from either way.
 */
const RESOURCES = {
  deployments: DeploymentSpec,
  services: ServiceSpec,
  configMaps: ConfigMapSpec,
} as const

type ResourceName = keyof typeof RESOURCES

type Stored = { meta: z.infer<typeof ObjectMeta>; spec: unknown; kind: ResourceName }

export function createKubernetesApp() {
  const f = facet({
    plugins: [
      logging(),
      apiKeys({
        prefix: 'kube_',
        keys: [
          { key: 'kube_admin', principalId: 'cluster-admin', scopes: ['*'] },
          { key: 'kube_view', principalId: 'viewer', scopes: ['cluster:read'] },
        ],
      }),
      scopes(),
    ],
  })

  const store = new Map<string, Stored>()
  let version = 0
  const key = (kind: string, namespace: string, name: string) => `${kind}/${namespace}/${name}`

  /**
   * One resource's worth of ops. Called once per entry in the table — so adding a CRD to the
   * cluster adds five operations across four facets with no new code, which is the strongest
   * result in this whole study.
   */
  /**
   * FRICTION 14 — input inference does not survive a generic schema.
   *
   * Written as `resourceOps<Spec extends z.ZodType>(kind, spec: Spec)`, the handler's `input` is
   * inferred from a *type parameter* rather than a concrete schema, and tsc cannot see that
   * `input.spec` exists: `Property 'spec' does not exist on type '{ [K in keyof …] }'`. The op
   * still runs, and every facet still projects it — this is a type-level limit, not a runtime
   * one — but the handler of a generated op loses exactly the typing that is facet's pitch.
   *
   * The workaround is the one below: take the schema as the erased `z.ZodType` and narrow the
   * handler's view of it by hand. That is honest about what is known, and it is the price of
   * generating ops rather than writing them out.
   */
  function resourceOps(kind: ResourceName, spec: z.ZodType) {
    const Resource = t.named(`${kind}Resource`, z.object({ kind: z.literal(kind), metadata: ObjectMeta, spec }))
    // Named per kind, not once: a schema built inside a factory is a new instance per call, so a
    // single shared name would put three different shapes under one OpenAPI component. This is
    // also why `omniface lint --fix` cannot repair the unnamed version automatically.
    const Ref = t.named(`${kind}Ref`, z.object({ namespace: t.id().default('default'), name: t.id() }))

    const find = (namespace: string, name: string) => {
      const found = store.get(key(kind, namespace, name))
      if (!found) throw errors.notFound(`${kind} "${name}" not found in namespace "${namespace}"`)
      return found
    }
    const render = (stored: Stored) => ({ kind, metadata: stored.meta, spec: stored.spec })

    return {
      get: f
        .op({ description: `Get one ${kind} resource`, input: Ref, output: Resource, errors: ['not_found'] })
        .traits({ readonly: true, scope: 'cluster:read' })
        .handle(({ input }) => render(find(input.namespace, input.name))),

      list: f
        .op({
          description: `List ${kind} in a namespace`,
          input: t.pageInput({ namespace: t.id().default('default'), labelSelector: z.string().optional() }),
          output: t.page(Resource),
        })
        .traits({ readonly: true, paginated: true, scope: 'cluster:read' })
        .handle(({ input }) => {
          const all = [...store.values()].filter((s) => s.kind === kind && s.meta.namespace === input.namespace).map(render)
          return paginate(all, input)
        }),

      /**
       * FITS, and unusually well. `kubectl apply` is declarative upsert — the caller sends the
       * desired state and the server reconciles — which is exactly what the `idempotent` trait
       * means. One trait gives it an Idempotency-Key over REST, an MCP idempotentHint, and SDK
       * retry safety, all of which are correct for apply and would be wrong for create.
       */
      apply: f
        .op({
          description: `Create or update a ${kind} resource to match the desired state`,
          input: z.object({ namespace: t.id().default('default'), name: t.id(), labels: z.record(z.string(), z.string()).optional(), spec }),
          output: Resource,
        })
        .traits({ idempotent: true, scope: 'cluster:write' })
        .handle(({ input }) => {
          const existing = store.get(key(kind, input.namespace, input.name))
          const stored: Stored = {
            kind,
            meta: {
              name: input.name,
              namespace: input.namespace,
              labels: input.labels ?? existing?.meta.labels ?? {},
              resourceVersion: String(++version),
              createdAt: existing?.meta.createdAt ?? new Date().toISOString(),
            },
            spec: input.spec,
          }
          store.set(key(kind, input.namespace, input.name), stored)
          return render(stored)
        }),

      delete: f
        .op({
          description: `Delete a ${kind} resource`,
          input: Ref,
          output: z.object({ kind: z.literal(kind), name: z.string(), namespace: z.string(), deleted: z.literal(true) }),
          errors: ['not_found'],
        })
        .traits({ destructive: true, idempotent: true, scope: 'cluster:write' })
        .handle(({ input }) => {
          find(input.namespace, input.name)
          store.delete(key(kind, input.namespace, input.name))
          return { kind, name: input.name, namespace: input.namespace, deleted: true as const }
        }),

      /**
       * FRICTION 12 — `watch` is the API, not an extra.
       *
       * Every controller in Kubernetes is a watch loop, and a watch is a long-lived stream of
       * add/update/delete events with a `resourceVersion` to resume from. Polling a list is not
       * a substitute at cluster scale, so unlike `docker logs` this one does not degrade into
       * something usable — it is the one operation in this study that a workaround does not
       * rescue. What is expressible is the resumption token, so the op below is a *page* of
       * changes since a version: correct, and nothing a controller would be built on.
       */
      changesSince: f
        .op({
          description: `List ${kind} changes since a resource version (a poll, not a watch — see FRICTION 12)`,
          input: t.pageInput({ namespace: t.id().default('default'), sinceResourceVersion: z.string().default('0') }),
          output: t.page(z.object({ type: z.enum(['added', 'modified', 'deleted']), resource: Resource })),
        })
        .traits({ readonly: true, paginated: true, scope: 'cluster:read' })
        .handle(({ input }) => {
          const since = Number(input.sinceResourceVersion) || 0
          const changed = [...store.values()]
            .filter((s) => s.kind === kind && s.meta.namespace === input.namespace && Number(s.meta.resourceVersion) > since)
            .map((s) => ({ type: 'modified' as const, resource: render(s) }))
          return paginate(changed, input)
        }),
    }
  }

  /**
   * The generated tree. `Object.fromEntries` loses the literal keys, so the cast is what pays
   * for building ops in a loop: the op ids are still correct at runtime and still appear on
   * every facet, but `facets.*.ops` override keys are no longer checked against them by tsc.
   * Writing the three entries out by hand keeps the checking and loses the generality — and for
   * a CRD-driven cluster, writing them out is not available at all.
   */
  const ops = Object.fromEntries(
    Object.entries(RESOURCES).map(([kind, spec]) => [kind, resourceOps(kind as ResourceName, spec)]),
  ) as unknown as { [K in ResourceName]: ReturnType<typeof resourceOps> }

  return f.app({
    name: 'kubernetes',
    version: '0.1.0',
    description: 'A cluster API whose operations are generated from its resource table',
    ops,
    facets: {
      rest: true,
      sdk: true,
      cli: { binName: 'kubectl' },
      mcp: {
        /**
         * FRICTION 13 — the tool budget does not survive generation.
         *
         * Three resources × five verbs is 15 tools, which is exactly `MCP_TOOL_BUDGET`; a fourth
         * CRD breaks it. Grouping is the documented escape, but a group is a hand-written literal
         * naming op ids — so the one place that cannot be generated is the one that has to grow
         * with the generated surface. The groups below are written by hand from the same table
         * the ops came from, which works and is exactly the duplication the generation avoided.
         */
        tools: Object.fromEntries(
          Object.keys(RESOURCES).map((kind) => [
            `${kind}_admin`,
            { description: `Manage ${kind}: get, list, apply and delete`, ops: [`${kind}.get`, `${kind}.list`, `${kind}.apply`, `${kind}.delete`] },
          ]),
        ) as never,
      },
    },
  })
}

const app = createKubernetesApp()
export default app
