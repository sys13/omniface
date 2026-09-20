#!/usr/bin/env node
// Publish the packed packages to npm with provenance, then tag the release.
//
// Provenance needs npm (>= 9.5) running in a workflow with `id-token: write`; pnpm's own publish
// has no equivalent flag today. So: `pnpm pack` builds the tarballs — it is what resolves
// `workspace:` ranges to real versions — and npm publishes those tarballs.
//
// Usage: node scripts/publish.mjs [--dry-run] [--tag <dist-tag>]

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, pack, publishedPackages } from './pack.mjs'

const dryRun = process.argv.includes('--dry-run')
const tag = process.argv[process.argv.indexOf('--tag') + 1] ?? 'latest'
const tarballs = pack(mkdtempSync(join(tmpdir(), 'facet-publish-')))

function alreadyPublished(name, version) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const published = []
for (const { pkg } of publishedPackages()) {
  if (alreadyPublished(pkg.name, pkg.version)) {
    process.stdout.write(`skipping ${pkg.name}@${pkg.version}: already on the registry\n`)
    continue
  }
  const args = ['publish', tarballs[pkg.name], '--provenance', '--access', 'public', '--tag', tag, ...(dryRun ? ['--dry-run'] : [])]
  try {
    execFileSync('npm', args, { cwd: ROOT, stdio: 'inherit' })
  } catch {
    process.stderr.write(`\nFailed to publish ${pkg.name}@${pkg.version}. If the name is taken on the registry, see docs/RELEASING.md.\n`)
    process.exitCode = 1
    break
  }
  published.push(pkg)
  // The line changesets/action reads to create the git tag and GitHub release.
  process.stdout.write(`New tag: ${pkg.name}@${pkg.version}\n`)
}

if (published.length && !dryRun) execFileSync('pnpm', ['exec', 'changeset', 'tag'], { cwd: ROOT, stdio: 'inherit' })
if (!published.length) process.stdout.write('Nothing to publish.\n')
