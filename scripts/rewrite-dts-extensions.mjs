#!/usr/bin/env node
// Rewrite relative `.ts` specifiers to their JavaScript equivalent in emitted declaration files.
//
// `rewriteRelativeImportExtensions` does this for the .js emit but not (yet) for .d.ts, so a
// published package would hand consumers `import type { App } from './app.ts'` — a file that isn't
// shipped, and an extension tsc rejects unless the consumer also enables allowImportingTsExtensions.
//
// Usage: node scripts/rewrite-dts-extensions.mjs <dist-dir>

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const EXT = { ts: 'js', mts: 'mjs', cts: 'cjs', tsx: 'jsx' }
// `from '…'`, `import '…'`, `import('…')` — single or double quoted.
const SPECIFIER = /((?:from|import)\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\2/g

function rewrite(source) {
  return source.replace(SPECIFIER, (match, head, quote, path) => {
    const m = /^(.*?)(?:\.d)?\.(ts|mts|cts|tsx)$/.exec(path)
    if (!m || /\.d\.(ts|mts|cts)$/.test(path)) return match
    return `${head}${quote}${m[1]}.${EXT[m[2]]}${quote}`
  })
}

async function* declarations(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* declarations(path)
    else if (entry.name.endsWith('.d.ts')) yield path
  }
}

const dist = resolve(process.argv[2] ?? 'dist')
let changed = 0
for await (const file of declarations(dist)) {
  const before = await readFile(file, 'utf8')
  const after = rewrite(before)
  if (after !== before) {
    await writeFile(file, after)
    changed++
  }
}
process.stdout.write(`rewrote .ts specifiers in ${changed} declaration file(s) under ${dist}\n`)
