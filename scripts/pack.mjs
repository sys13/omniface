#!/usr/bin/env node
// Pack the published packages into tarballs, the way `pnpm publish` would: `workspace:` ranges
// resolved to real versions, `files` applied, `publishConfig` folded in.
//
// Usage: node scripts/pack.mjs [out-dir]   (prints one JSON object: { "<name>": "<tarball>" })

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..')

/** The workspace packages that get published, in dependency order. */
export function publishedPackages() {
  return readdirSync(join(ROOT, 'packages'))
    .map((dir) => ({ dir: join(ROOT, 'packages', dir), pkg: JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')) }))
    .filter(({ pkg }) => !pkg.private)
}

export function pack(outDir) {
  mkdirSync(outDir, { recursive: true })
  const tarballs = {}
  for (const { dir, pkg } of publishedPackages()) {
    const out = execFileSync('pnpm', ['pack', '--pack-destination', outDir], { cwd: dir, encoding: 'utf8' })
    const tarball = out.split('\n').map((l) => l.trim()).find((l) => l.endsWith('.tgz'))
    if (!tarball) throw new Error(`pnpm pack printed no tarball for ${pkg.name}:\n${out}`)
    tarballs[pkg.name] = tarball
  }
  return tarballs
}

if (process.argv[1] === import.meta.filename) {
  process.stdout.write(JSON.stringify(pack(resolve(process.argv[2] ?? join(ROOT, 'dist-tarballs'))), null, 2) + '\n')
}
