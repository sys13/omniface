#!/usr/bin/env node
// The bin has to exist when `pnpm install` runs, or pnpm declines to create the shim
// ("Failed to create bin ... ENOENT") and never revisits it — `pnpm build` fills dist/
// afterwards, but nothing re-links. In this repo that made `facet` missing on every
// clean checkout, which is exactly where CI runs the example app's `omniface lint &&
// omniface conformance` (backlog 4.1). So the bin is this committed launcher, always
// present at install time, and dist/ is loaded at run time instead.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = new URL('../dist/devcli.js', import.meta.url)
if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write('omniface: not built. Run `pnpm build` (or reinstall the package).\n')
  process.exit(1)
}
await import(entry.href)
