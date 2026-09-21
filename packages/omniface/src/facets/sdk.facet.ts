import type { App, SdkConfig } from '../app.ts'
import { defineFacet, registerFacet, projectionOf, settingsOf, type FacetChange } from '../facet.ts'
import type { Manifest, ManifestOp } from '../manifest.ts'

/** What the SDK facet does with one op: the method path a generated client exposes it under. */
export type SdkProjection = { method: string[] }

export type SdkSettings = { packageName: string }

export const sdkOf = (op: ManifestOp): SdkProjection | null => projectionOf<SdkProjection>(op, 'sdk')
export const sdkSettings = (manifest: Manifest): SdkSettings | null => settingsOf<SdkSettings>(manifest, 'sdk')

/**
 * The SDK facet. Like the CLI it is not served: a generated package is the output, and the only
 * thing that reaches it at runtime is the manifest. Two of the five facets are not servers, which
 * is why `serve` is optional in the contract rather than assumed.
 */
export const sdkFacet = defineFacet<SdkConfig, SdkProjection, SdkSettings>({
  name: 'sdk',
  order: 3,
  defaultOn: true,
  normalize: (value) => (value === undefined || value === false ? null : value === true ? {} : (value as SdkConfig)),

  // Every exposed op is in the SDK. There is no per-op override, because an SDK with holes in it
  // is worse than one method nobody calls.
  project: ({ op }) => ({ method: op.path }),

  settings: (app: App, config) => ({ packageName: config.packageName ?? `${app.name}-sdk` }),

  // A generated SDK exports the schema's type under its published name, so a rename is breaking
  // here even when every field inside is identical.
  observes: { typeNames: true },

  diff(before, after, { op }): FacetChange[] {
    if (before.method.join('.') === after.method.join('.')) return []
    return [
      {
        level: 'breaking',
        rule: 'sdk-method-renamed',
        message: `${op}: SDK method ${before.method.join('.')}() → ${after.method.join('.')}().`,
      },
    ]
  },

  diffSettings(before, after): FacetChange[] {
    if (before.packageName === after.packageName) return []
    return [
      {
        level: 'breaking',
        rule: 'sdk-package-renamed',
        message: `The SDK package was renamed ${before.packageName} → ${after.packageName}.`,
        detail: `Every \`import … from '${before.packageName}'\` stops resolving, and the old name keeps installing the old version.`,
      },
    ]
  },

  present({ op, example }, projection) {
    const hasInput = Object.keys(example).length > 0
    const snippet = op.traits.paginated
      ? `for await (const item of client.${projection.method.join('.')}.iterate(${hasInput ? JSON.stringify(example) : ''})) {\n  console.log(item)\n}`
      : `const result = await client.${projection.method.join('.')}(${hasInput ? JSON.stringify(example, null, 2) : ''})`
    return { label: 'SDK', short: `${projection.method.join('.')}()`, snippet, line: `- SDK: \`${snippet.split('\n')[0]}\`` }
  },

  summary: () => 'a TypeScript SDK',

  contract({ op }, projection) {
    if (!projection) return ['no SDK binding']
    return projection.method.join('.') === op.path.join('.') ? [] : ['SDK method path differs from the op id']
  },
})

// Registered here rather than in a list elsewhere: a facet module that is imported is a facet the
// app has. It also keeps the import cycle with this facet's server module harmless.
registerFacet(sdkFacet)
