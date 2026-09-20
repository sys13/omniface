import { redact } from '../jsonschema.ts'
import { definePlugin, type Invocation } from '../plugin.ts'
import { toFacetError } from '../errors.ts'

export type LogLine = {
  level: 'info' | 'warn' | 'error'
  msg: string
  requestId: string
  facet: string
  op: string
  actor: string
  actorKind: string
  client?: string
  durationMs?: number
  outcome?: string
  input?: unknown
  [key: string]: unknown
}

export type LoggingOptions = {
  /** Where lines go. Default: JSON to stderr (safe for MCP over stdio). */
  sink?: (line: LogLine) => void
  /** Include the (redacted) input on request lines. Default true. */
  input?: boolean
}

const stderrSink = (line: LogLine) => process.stderr.write(JSON.stringify(line) + '\n')

function base(inv: Invocation) {
  return {
    requestId: inv.requestId,
    facet: inv.facet,
    op: inv.op.id,
    actor: inv.principal.id,
    actorKind: inv.principal.kind,
    ...(inv.client?.name ? { client: [inv.client.name, inv.client.version].filter(Boolean).join('/') } : {}),
  }
}

export function logging(options: LoggingOptions = {}) {
  const sink = options.sink ?? stderrSink
  return definePlugin<{ log: (msg: string, data?: Record<string, unknown>) => void }>({
    name: 'logging',
    async wrap(inv, next) {
      inv.ctx.log = (msg: string, data?: Record<string, unknown>) =>
        sink({ level: 'info', msg, ...base(inv), ...data })
      try {
        const output = await next()
        sink({
          level: 'info',
          msg: 'op completed',
          ...base(inv),
          durationMs: Date.now() - inv.startedAt,
          outcome: 'ok',
          ...(options.input !== false ? { input: redact(inv.input ?? inv.rawInput, inv.op.inputSchema) } : {}),
        })
        return output
      } catch (raw) {
        const err = toFacetError(raw)
        sink({
          level: err.code === 'internal' ? 'error' : 'warn',
          msg: err.code === 'internal' ? `op failed: ${String((err.cause as Error)?.message ?? err.message)}` : 'op rejected',
          ...base(inv),
          durationMs: Date.now() - inv.startedAt,
          outcome: err.code,
          ...(options.input !== false ? { input: redact(inv.input ?? inv.rawInput, inv.op.inputSchema) } : {}),
        })
        throw err
      }
    },
  })
}
