import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { App } from './app.ts'
import { diffManifests, type ManifestDiff } from './diff.ts'
import { MANIFEST_VERSION, buildManifest, type Manifest } from './manifest.ts'

/**
 * Loading the two sides of `omniface diff`. Either side may be a manifest written by `omniface build`
 * or an app module, because the two things a release is compared against are a published artefact
 * (a file) and the working tree (a module), and a diff between two working trees — a rebase, a
 * worktree, `git stash` — is useful enough to be worth not forbidding.
 */
export type ManifestSource = { manifest: Manifest; from: string; kind: 'manifest' | 'app' }

function assertManifest(value: unknown, from: string): Manifest {
  const m = value as Partial<Manifest> | undefined
  if (!m || typeof m !== 'object' || !Array.isArray(m.ops) || typeof m.name !== 'string') {
    throw new Error(`${from} is not a facet manifest. \`omniface build\` writes one to .omniface/manifest.json.`)
  }
  if (typeof m.facet !== 'number') throw new Error(`${from} has no manifest version; it was not written by \`omniface build\`.`)
  if (m.facet > MANIFEST_VERSION) {
    throw new Error(`${from} is manifest v${m.facet}; this facet reads v${MANIFEST_VERSION}. Upgrade omniface to diff against it.`)
  }
  return m as Manifest
}

export async function loadManifestSource(path: string): Promise<ManifestSource> {
  const full = resolve(path)
  if (/\.json$/.test(full)) {
    let text: string
    try {
      text = await readFile(full, 'utf8')
    } catch {
      throw new Error(`No manifest at ${full}. Write one with \`omniface build --out <dir>\`.`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`${full} is not valid JSON: ${(err as Error).message}`)
    }
    return { manifest: assertManifest(parsed, full), from: full, kind: 'manifest' }
  }
  const mod = (await import(pathToFileURL(full).href)) as { default?: App }
  if (mod.default?.kind !== 'omniface.app') throw new Error(`${path} does not default-export a facet app`)
  return { manifest: buildManifest(mod.default), from: full, kind: 'app' }
}

export type DiffRunResult = ManifestDiff & { sources: { before: ManifestSource; after: ManifestSource } }

export async function runDiff(beforePath: string, afterPath: string): Promise<DiffRunResult> {
  const [before, after] = await Promise.all([loadManifestSource(beforePath), loadManifestSource(afterPath)])
  return { ...diffManifests(before.manifest, after.manifest), sources: { before, after } }
}
