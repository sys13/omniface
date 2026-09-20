/** Every generated SDK's declarations have to parse and typecheck. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SUBJECTS = ['linear', 'stripe', 'github', 's3', 'docker', 'kubernetes']
const tsc = fileURLToPath(new URL('../../node_modules/.bin/tsc', import.meta.url))

let failed = 0
for (const subject of SUBJECTS) {
  const file = fileURLToPath(new URL(`./.out/${subject}/sdk/index.d.ts`, import.meta.url))
  const { code, out } = await new Promise((resolve) => {
    const child = spawn(tsc, ['--ignoreConfig', '--noEmit', '--skipLibCheck', '--target', 'es2022', '--module', 'preserve', '--moduleResolution', 'bundler', file])
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })
  const errors = (out.match(/error TS/g) ?? []).length
  if (code !== 0) failed++
  console.log(`${subject.padEnd(12)}${errors} error(s)${errors ? `\n${out}` : ''}`)
}
process.exit(failed ? 1 : 0)
