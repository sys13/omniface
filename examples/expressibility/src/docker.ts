/**
 * Study subject: Docker's container engine.
 *
 * Why this one: it is CLI-first rather than REST-first, and its defining operations are *not*
 * request/response — `logs -f`, `exec -it`, `build`, `stats`, `events` are all streams, and
 * `pull` and `build` are long-running with progress. facet's README lists streaming and
 * long-running ops as unbuilt; this subject measures how much of a real tool that excludes.
 *
 * The verdict, written out below op by op: the *nouns* fit and the *verbs* split cleanly in two.
 */
import { errors, facet, paginate } from 'omniface'
import { logging, scopes } from 'omniface/plugins'
import { t } from 'omniface/zod'
import { z } from 'zod'

const Container = t.named(
  'Container',
  z.object({
    id: t.id({ example: 'c0ffee' }),
    name: z.string(),
    image: z.string(),
    state: z.enum(['created', 'running', 'paused', 'exited']),
    exitCode: z.number().int().nullable(),
    ports: z.array(z.object({ container: z.number().int(), host: z.number().int().nullable(), protocol: z.enum(['tcp', 'udp']) })),
    /** `docker run -e`: another open string→string map, the same shape as Stripe's metadata. */
    env: z.record(z.string(), z.string()),
    createdAt: t.datetime(),
  }),
)
type Container = z.infer<typeof Container>

const Image = t.named(
  'Image',
  z.object({
    id: t.id(),
    tags: z.array(z.string()),
    sizeBytes: z.number().int(),
    createdAt: t.datetime(),
  }),
)
type Image = z.infer<typeof Image>

const LogLine = t.named(
  'LogLine',
  z.object({
    stream: z.enum(['stdout', 'stderr']),
    at: t.datetime(),
    text: z.string(),
  }),
)
type LogLine = z.infer<typeof LogLine>

export function createDockerApp() {
  const f = facet({ plugins: [logging(), scopes()] })

  const containers = new Map<string, Container>()
  const images = new Map<string, Image>()
  const logs = new Map<string, LogLine[]>()
  let seq = 0

  const find = (id: string) => {
    const found = containers.get(id)
    if (!found) throw errors.notFound(`No such container: ${id}`)
    return found
  }

  const ops = {
    containers: {
      /**
       * FITS. `docker run` is `create` + `start`, and both are ordinary ops. Note that `run`'s
       * *blocking* form (`docker run` without `-d`, which attaches and waits) is the streaming
       * variant and is not expressible; the detached form is, and it is the one a script uses.
       */
      create: f
        .op({
          description: 'Create a container without starting it',
          input: z.object({
            image: z.string().min(1),
            name: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
            ports: z.array(z.object({ container: z.number().int(), host: z.number().int().nullable(), protocol: z.enum(['tcp', 'udp']) })).optional(),
          }),
          output: Container,
        })
        .traits({ scope: 'containers:write' })
        .handle(({ input }) => {
          const container: Container = {
            id: `c${++seq}`,
            name: input.name ?? `container_${seq}`,
            image: input.image,
            state: 'created',
            exitCode: null,
            ports: input.ports ?? [],
            env: input.env ?? {},
            createdAt: new Date().toISOString(),
          }
          containers.set(container.id, container)
          logs.set(container.id, [])
          return container
        }),

      list: f
        .op({
          description: 'List containers',
          input: t.pageInput({ all: z.boolean().optional() }),
          output: t.page(Container),
        })
        .traits({ readonly: true, paginated: true, scope: 'containers:read' })
        .handle(({ input }) =>
          paginate([...containers.values()].filter((c) => input.all || c.state === 'running'), input),
        ),

      get: f
        .op({ description: 'Inspect a container', input: z.object({ id: t.id() }), output: Container, errors: ['not_found'] })
        .traits({ readonly: true, scope: 'containers:read' })
        .handle(({ input }) => find(input.id)),

      start: f
        .op({ description: 'Start a container', input: z.object({ id: t.id() }), output: Container, errors: ['not_found'] })
        .traits({ idempotent: true, scope: 'containers:write' })
        .handle(({ input }) => {
          const next: Container = { ...find(input.id), state: 'running', exitCode: null }
          containers.set(next.id, next)
          logs.get(next.id)?.push({ stream: 'stdout', at: new Date().toISOString(), text: `started ${next.name}` })
          return next
        }),

      stop: f
        .op({
          description: 'Stop a container',
          input: z.object({ id: t.id(), timeoutSeconds: z.number().int().min(0).default(10) }),
          output: Container,
          errors: ['not_found'],
        })
        .traits({ idempotent: true, scope: 'containers:write' })
        .handle(({ input }) => {
          const next: Container = { ...find(input.id), state: 'exited', exitCode: 0 }
          containers.set(next.id, next)
          return next
        }),

      remove: f
        .op({
          description: 'Remove a container',
          input: z.object({ id: t.id(), force: z.boolean().default(false) }),
          output: z.object({ id: z.string(), deleted: z.literal(true) }),
          errors: ['not_found', 'conflict'],
        })
        .traits({ destructive: true, scope: 'containers:write' })
        .handle(({ input }) => {
          const container = find(input.id)
          if (container.state === 'running' && !input.force) throw errors.conflict('Container is running; stop it or pass force')
          containers.delete(input.id)
          logs.delete(input.id)
          return { id: input.id, deleted: true as const }
        }),

      /**
       * FRICTION 9 — a stream, degraded to a page.
       *
       * `docker logs` is a one-shot read and `docker logs -f` is a subscription. Only the first
       * is expressible, and the honest way to say it is as a paginated read where the cursor is
       * a position in the log. A client can poll it, which is a worse `-f` but a real one: no
       * push, a latency floor of the poll interval, and no way to say "the container exited, the
       * stream is over" other than a field. Every long-lived-output tool lands here.
       */
      logs: f
        .op({
          description: 'Read a container’s logs. Poll with the cursor for new lines (no streaming — see FRICTION 9)',
          input: t.pageInput({ id: t.id(), stream: z.enum(['stdout', 'stderr']).optional() }),
          output: t.page(LogLine).extend({ containerExited: z.boolean() }),
          errors: ['not_found'],
        })
        .traits({ readonly: true, paginated: true, scope: 'containers:read' })
        .handle(({ input }) => {
          const container = find(input.id)
          const lines = (logs.get(input.id) ?? []).filter((l) => !input.stream || l.stream === input.stream)
          return { ...paginate(lines, input), containerExited: container.state === 'exited' }
        }),

      /**
       * FRICTION 10 — `exec` without a terminal.
       *
       * `docker exec -it` is a bidirectional byte stream: stdin goes up while stdout comes down,
       * for as long as the process lives. Nothing in an op can express that. What *is*
       * expressible is the batch form — run a command, wait, return the output — which is what
       * CI actually uses. The interactive form has no projection on any of the four facets, and
       * would not gain one from a streaming *response* alone: it needs a streaming request too.
       */
      exec: f
        .op({
          description: 'Run a command in a container and wait for it to finish (no interactive TTY — see FRICTION 10)',
          input: z.object({ id: t.id(), command: z.array(z.string()).min(1), timeoutSeconds: z.number().int().default(60) }),
          output: z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() }),
          errors: ['not_found', 'conflict'],
        })
        .traits({ scope: 'containers:exec' })
        .handle(({ input }) => {
          const container = find(input.id)
          if (container.state !== 'running') throw errors.conflict('Container is not running')
          return { exitCode: 0, stdout: `${input.command.join(' ')}\n`, stderr: '' }
        }),
    },

    images: {
      list: f
        .op({ description: 'List images', input: t.pageInput(), output: t.page(Image) })
        .traits({ readonly: true, paginated: true, scope: 'images:read' })
        .handle(({ input }) => paginate([...images.values()], input)),

      /**
       * FRICTION 11 — long-running, with progress.
       *
       * `docker pull` streams layer-by-layer progress for minutes. Modelled as a blocking op it
       * holds an HTTP request open past every sane timeout and tells the caller nothing while it
       * works. The workaround that *is* expressible is the one every REST API reaches for: make
       * the job a resource, return it immediately, and let the caller poll it. That is three ops
       * (`pull`, `jobs.get`, `jobs.list`) where the tool has one verb, and the async-ness is now
       * the API consumer's problem rather than the framework's.
       */
      pull: f
        .op({
          description: 'Start pulling an image. Returns a job; poll jobs.get for progress (see FRICTION 11)',
          input: z.object({ image: z.string().min(1), tag: z.string().default('latest') }),
          output: z.object({ jobId: t.id(), status: z.literal('running') }),
        })
        .traits({ idempotent: true, scope: 'images:write' })
        .handle(({ input }) => {
          const image: Image = {
            id: `img_${++seq}`,
            tags: [`${input.image}:${input.tag}`],
            sizeBytes: 10_000_000,
            createdAt: new Date().toISOString(),
          }
          images.set(image.id, image)
          return { jobId: `job_${seq}`, status: 'running' as const }
        }),

      /**
       * NOT EXPRESSIBLE, and left out on purpose. `docker build` uploads a tar of the build
       * context — bytes, like S3's PutObject — and streams back the output of every layer. It is
       * the intersection of FRICTION 8 and FRICTION 9, and neither half has a projection.
       */
    },

    jobs: {
      get: f
        .op({
          description: 'Check a long-running job',
          input: z.object({ id: t.id() }),
          output: z.object({
            id: t.id(),
            kind: z.enum(['pull', 'build']),
            status: z.enum(['running', 'succeeded', 'failed']),
            progressPercent: z.number().int().min(0).max(100),
            message: z.string().nullable(),
          }),
          errors: ['not_found'],
        })
        .traits({ readonly: true, scope: 'containers:read' })
        .handle(({ input }) => ({ id: input.id, kind: 'pull' as const, status: 'succeeded' as const, progressPercent: 100, message: null })),
    },
  }

  return f.app({
    name: 'docker',
    version: '0.1.0',
    description: 'The request/response half of a container engine',
    ops,
    facets: {
      rest: true,
      sdk: true,
      cli: {
        // The CLI facet is the closest fit of the four here, which is the right result for a
        // CLI-first tool — but note the shape it lands on: `docker containers list`, not
        // `docker ps`. Aliases are expressible one at a time; a tool's whole idiomatic surface
        // (`ps`, `rm`, `rmi`, `exec`) is a pile of overrides the lint will object to.
        binName: 'docker',
        ops: {
          'containers.list': { command: 'ps', columns: ['id', 'name', 'image', 'state'] },
          'containers.remove': { command: 'rm', args: ['id'] },
          'containers.exec': { args: ['id', 'command'] },
          'containers.logs': { args: ['id'] },
        },
      },
      mcp: {
        ops: {
          'containers.exec': { description: 'Run a command inside a running container and return its output. Not interactive.' },
        },
      },
    },
  })
}

const app = createDockerApp()
export default app
