import type { WebConfig } from './app.ts'
import type { OpTraits } from './traits.ts'

/**
 * What a browser agent may do, said once (docs/BACKLOG.md 12.7, and the proposal's W4).
 *
 * The page's registration list is client-side data. An XSS, a curious user, or anyone with the
 * browser's dev tools can call the endpoint a tool was not registered for, so a filter in the page
 * is presentation and never enforcement. The rule, from the proposal: **advertise from a
 * declaration, refuse from the pipeline, and derive both from the same source.** This is that
 * source — `buildManifest` reads it to decide what the page registers, and `app.invoke` reads it
 * to decide what it refuses.
 *
 * The default is `readonly`, because the credential a browser agent carries today is the person's
 * own session (the proposal's §4): until 12.8 mints something weaker, "whatever Alice can do" is
 * one sentence away from the agent, and a write is the part of that worth refusing by default.
 */
export type AgentAllow = 'readonly' | 'none' | 'all'

export type WebAgentConfig<Id extends string = string> = {
  /** The rule for an op the app does not name. Default `readonly`. */
  allow?: AgentAllow
  /** Per op, overriding `allow`. */
  ops?: Partial<Record<Id, boolean>>
  /**
   * What the page's tools carry.
   *
   * - `attenuated` — the page mints a short-lived, scope-narrowed token (the `agentTokens()`
   *   plugin) and the tools send that. The agent then holds strictly less than the person whose
   *   tab it is in, which is the whole point of 12.8. The default when the plugin is installed.
   * - `session` — the tools lean on the ambient cookie, so the agent holds everything the person
   *   holds. Honest, occasionally what a demo wants, and never what traffic wants.
   */
  credential?: 'attenuated' | 'session'
}

/** The op `agentTokens()` contributes. The page looks for it to know whether it can attenuate. */
export const MINT_OP = 'agentToken.mint'

/**
 * Whether a browser agent may call this op. `false` means both "not registered on the page" and
 * "refused if called anyway" — one answer, two readers, which is the whole point of the story.
 */
export function agentMayCall(web: WebConfig | null | undefined, id: string, traits: OpTraits): boolean {
  if (!web?.agent) return false
  // A tool comes from the generated page, so an op with no screen has no tool either.
  if (web.ops?.[id] === false) return false
  if (traits.internal) return false
  const config = web.agent === true ? {} : web.agent
  const named = config.ops?.[id]
  if (named !== undefined) return named
  switch (config.allow ?? 'readonly') {
    case 'all':
      return true
    case 'none':
      return false
    default:
      return Boolean(traits.readonly)
  }
}
