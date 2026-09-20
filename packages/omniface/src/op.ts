import type { ErrorCode } from './errors.ts'
import { emptyInput, type AnySchema, type InferIn, type InferOut } from './standard.ts'
import type { OpTraits } from './traits.ts'

export type FacetName = 'rest' | 'mcp' | 'cli' | 'sdk' | 'internal' | (string & {})

export type Principal = {
  id: string
  kind: 'user' | 'service' | 'agent' | 'anonymous'
  scopes: string[]
  name?: string
}

export const anonymous: Principal = Object.freeze({ id: 'anonymous', kind: 'anonymous', scopes: [] }) as Principal

export type HandlerArgs<I, Ctx> = {
  input: I
  ctx: Ctx
  principal: Principal
  facet: FacetName
  requestId: string
}

export interface Op<I extends AnySchema = AnySchema, O extends AnySchema = AnySchema> {
  readonly kind: 'omniface.op'
  readonly input: I
  readonly output: O
  readonly description?: string
  readonly traits: OpTraits
  readonly errors: readonly ErrorCode[]
  readonly handler: (args: HandlerArgs<InferOut<I>, any>) => unknown
}

export type OpsTree = { readonly [key: string]: Op<any, any> | OpsTree }

export type OpConfig<I extends AnySchema, O extends AnySchema> = {
  input?: I
  output: O
  description?: string
  errors?: readonly ErrorCode[]
}

export interface OpBuilder<I extends AnySchema, O extends AnySchema, Ctx> {
  traits(traits: OpTraits): OpBuilder<I, O, Ctx>
  handle(
    handler: (args: HandlerArgs<InferOut<I>, Ctx>) => InferIn<O> | Promise<InferIn<O>>,
  ): Op<I, O>
}

export type OpFactory<Ctx> = <O extends AnySchema, I extends AnySchema = typeof emptyInput>(
  config: OpConfig<I, O>,
) => OpBuilder<I, O, Ctx>

// ---------------------------------------------------------------------------------------------
// Where an op was written
//
// `omniface lint --fix` edits source, so it has to know which file to open. Nothing else in facet
// does — schemas are compared by instance, never by location — so the only place the definition
// site is available is the stack at the `op({...})` call itself. Capturing one per op is pure cost
// to an app that is only going to run, so it is off until something asks: `omniface lint --fix` turns
// it on before importing the entry.

const sites = new WeakMap<object, string>()
let capturing = false

/** Record `file:line:column` for every op defined from now on. Off by default. */
export function captureDefinitionSites(on = true): void {
  capturing = on
}

/** Where an op's `op({...})` call is written, if it was captured. */
export function definitionSite(op: Op): string | undefined {
  return sites.get(op)
}

const OWN_DIR = import.meta.url.replace(/^file:\/\//, '').replace(/\/[^/]+$/, '')

/** The first stack frame outside this package: the line the app author wrote. */
function callerSite(): string | undefined {
  const stack = new Error().stack
  if (!stack) return undefined
  for (const line of stack.split('\n').slice(1)) {
    const match = /\(?((?:file:\/\/)?\/[^\s()]+):(\d+):(\d+)\)?$/.exec(line.trim())
    if (!match) continue
    const file = match[1]!.replace(/^file:\/\//, '')
    if (file.startsWith(OWN_DIR)) continue
    return `${file}:${match[2]}:${match[3]}`
  }
  return undefined
}

export function createOpFactory<Ctx>(): OpFactory<Ctx> {
  return <O extends AnySchema, I extends AnySchema = typeof emptyInput>(config: OpConfig<I, O>) => {
    // Captured here, not in `handle`: this is the call whose `input:` and `output:` a fix rewrites.
    const site = capturing ? callerSite() : undefined
    const build = (traits: OpTraits): OpBuilder<I, O, Ctx> => ({
      traits: (more) => build({ ...traits, ...more }),
      handle: (handler) => {
        const built = Object.freeze({
          kind: 'omniface.op',
          input: (config.input ?? emptyInput) as I,
          output: config.output,
          description: config.description,
          traits,
          errors: config.errors ?? [],
          handler: handler as Op<I, O>['handler'],
        })
        if (site) sites.set(built, site)
        return built
      },
    })
    return build({})
  }
}

/** An op factory with an untyped context, for plugins that contribute operations. */
export const op: OpFactory<Record<string, unknown>> = createOpFactory()

export function isOp(value: unknown): value is Op {
  return typeof value === 'object' && value !== null && (value as Op).kind === 'omniface.op'
}
