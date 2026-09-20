import { toFacetError } from '../errors.ts'
import { redact } from '../jsonschema.ts'
import { definePlugin } from '../plugin.ts'

export type AuditEntry = {
  at: string
  requestId: string
  op: string
  facet: string
  /** Who acted. On MCP, `via` names the agent acting for this principal. */
  actor: { id: string; kind: string; via?: string }
  outcome: string
  input: unknown
}

export type AuditOptions = {
  sink: (entry: AuditEntry) => void | Promise<void>
  /** Also record readonly ops. Default false. */
  includeReadonly?: boolean
}

/** An append-only record of who changed what, through which facet. PII is redacted. */
export function audit(options: AuditOptions) {
  return definePlugin({
    name: 'audit',
    async wrap(inv, next) {
      const record = async (outcome: string) => {
        if (inv.op.op.traits.readonly && !options.includeReadonly) return
        const via = inv.facet === 'mcp' ? `mcp:${inv.client?.name ?? 'unknown-client'}` : undefined
        await options.sink({
          at: new Date().toISOString(),
          requestId: inv.requestId,
          op: inv.op.id,
          facet: inv.facet,
          actor: { id: inv.principal.id, kind: via ? 'agent' : inv.principal.kind, ...(via ? { via } : {}) },
          outcome,
          input: redact(inv.input ?? inv.rawInput, inv.op.inputSchema),
        })
      }
      try {
        const output = await next()
        await record('ok')
        return output
      } catch (err) {
        await record(toFacetError(err).code)
        throw err
      }
    },
  })
}
