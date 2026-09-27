import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// A test that imports `omniface` or `@omniface/*` by name would otherwise resolve through the
// workspace link to `dist`, and exercise the last build rather than the tree — a src edit could
// pass the generated suite without reaching it. Each export is pointed at its source instead,
// read off the package's own `exports` map so the two cannot drift. Publishing is untouched, and
// `test/packaging.test.ts` reads `dist` off disk, so the built artifact is still checked.
const packages = fileURLToPath(new URL('./packages/', import.meta.url))
const alias = readdirSync(packages).flatMap((dir) => {
  const pkg = JSON.parse(readFileSync(`${packages}${dir}/package.json`, 'utf8')) as { name: string; exports: Record<string, string> }
  return Object.entries(pkg.exports)
    .filter(([, target]) => target.startsWith('./dist/') && target.endsWith('.js'))
    .map(([subpath, target]) => ({
      find: new RegExp(`^${`${pkg.name}${subpath.slice(1)}`.replace(/[/.]/g, '\\$&')}$`),
      replacement: `${packages}${dir}/${target.slice(2).replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')}`,
    }))
})

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
  },
})
