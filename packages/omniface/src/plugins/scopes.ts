import { errors } from '../errors.ts'
import { definePlugin } from '../plugin.ts'

/** `*` grants everything; `tasks:*` grants every `tasks:` scope. */
export function hasScope(held: readonly string[], required: string): boolean {
  return held.some((s) => s === '*' || s === required || (s.endsWith(':*') && required.startsWith(s.slice(0, -1))))
}

export type ScopesOptions = {
  /** Require an authenticated principal for every op not marked `public`. Default true. */
  requireAuth?: boolean
}

/** Enforces the `scope` and `public` op traits, for every facet, in the authorize stage. */
export function scopes(options: ScopesOptions = {}) {
  const requireAuth = options.requireAuth ?? true
  return definePlugin({
    name: 'scopes',
    traits: ['scope', 'public'],
    hooks: {
      authorize(inv) {
        const { traits } = inv.op.op
        if (traits.public) return
        if (inv.principal.kind === 'anonymous' && (requireAuth || traits.scope)) {
          throw errors.unauthenticated('Authentication required')
        }
        if (traits.scope && !hasScope(inv.principal.scopes, traits.scope)) {
          throw errors.forbidden(`Missing required scope "${traits.scope}"`)
        }
      },
    },
  })
}
