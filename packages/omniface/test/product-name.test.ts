import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { facet } from '../src/index.ts'

// The product was called `facet` before it was published as `omniface`. A facet is still the
// domain noun — one surface such as REST or MCP — so "a facet app" is right and stays. What
// must not survive is the old name used as the product: the bin, or the prefix on an error a
// user reads. Nothing asserted these strings, which is how they outlived the rename.

const PKG = resolve(import.meta.dirname, '..')
const PACKAGES = resolve(PKG, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  )
}

describe('the product is called omniface wherever a user reads it', () => {
  it('the bare CLI documents only commands that exist', () => {
    const usage = execFileSync(process.execPath, [join(PKG, 'bin/omniface.mjs')], { encoding: 'utf8' })
    const commands = usage
      .split('\n')
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
    expect(commands.length).toBeGreaterThan(0)
    expect(new Set(commands)).toEqual(new Set(['omniface']))
  })

  it('a configuration error is prefixed with the product name', () => {
    const plugin = { name: 'twice' } as never
    expect(() => facet({ plugins: [plugin, plugin] })).toThrow(/^omniface: plugin "twice" is installed twice$/)
  })

  it('no string literal in a published package uses the old name as a prefix or a command', () => {
    const oldName = /['"`]facet(?: web)?: |['"`]facet (?:dev|mcp|inspect|build|lint|conformance|diff|--version)\b/
    const offenders = readdirSync(PACKAGES)
      .flatMap((pkg) => {
        try {
          return sources(join(PACKAGES, pkg, 'src'))
        } catch {
          return []
        }
      })
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, i) => (oldName.test(line) ? [`${file.slice(PACKAGES.length + 1)}:${i + 1}`] : [])),
      )
    expect(offenders).toEqual([])
  })
})
