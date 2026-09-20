import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildManifest, createServer, definePlugin, facet } from 'omniface'
import { runCli } from '../src/index.ts'

// What a plugin adds to the CLI facet through `definePlugin({ adapters: { cli } })`. The CLI runs
// from a manifest in another process, so the declaration travels as data and the engine renders it.

const demo = definePlugin({
  name: 'demo',
  hooks: {
    authenticate(inv) {
      if (inv.credential?.token === 'demo-token') inv.principal = { id: 'user_demo', kind: 'user', scopes: ['*'] }
    },
  },
  adapters: {
    cli: {
      flags: [{ name: 'demo-token', summary: 'A demo credential', env: 'DEMO_TOKEN', credential: true }],
      commands: [{ command: 'ping', summary: 'Who am I', op: 'notes.whoami' }],
    },
  },
})

function demoApp() {
  const f = facet({ plugins: [demo] })
  return f.app({
    name: 'notes',
    ops: {
      notes: {
        whoami: f
          .op({ output: z.object({ id: z.string() }) })
          .traits({ readonly: true, public: true })
          .handle(({ principal }) => ({ id: principal.id })),
      },
    },
  })
}

async function run(argv: string[], env: Record<string, string> = {}) {
  const app = demoApp()
  const server = createServer(app)
  let stdout = ''
  let stderr = ''
  const code = await runCli({
    manifest: buildManifest(app),
    argv: [...argv, '--base-url', 'http://facet.test', '--output', 'json'],
    binName: 'notes',
    env,
    configDir: '/nonexistent-facet-config',
    fetch: async (input, init) => server.fetch(new Request(input as string, init)),
    io: {
      stdout: { write: (s) => void (stdout += s), isTTY: false },
      stderr: { write: (s) => void (stderr += s) },
      stdinIsTTY: false,
    },
  })
  return { code, stdout, stderr }
}

describe('CLI adapters', () => {
  it('runs a contributed command as an alias for the op it names', async () => {
    const alias = await run(['ping'])
    const canonical = await run(['notes', 'whoami'])
    expect(alias.code).toBe(0)
    expect(alias.stdout).toBe(canonical.stdout)
    expect(JSON.parse(alias.stdout)).toEqual({ id: 'anonymous' })
  })

  it('accepts a contributed credential flag, and its environment variable', async () => {
    expect(JSON.parse((await run(['ping', '--demo-token', 'demo-token'])).stdout)).toEqual({ id: 'user_demo' })
    expect(JSON.parse((await run(['ping'], { DEMO_TOKEN: 'demo-token' })).stdout)).toEqual({ id: 'user_demo' })
  })

  it('lets the built-in --api-key win when both are given', async () => {
    const { stdout } = await run(['ping', '--api-key', 'nonsense', '--demo-token', 'demo-token'])
    expect(JSON.parse(stdout)).toEqual({ id: 'anonymous' })
  })

  it('lists contributed commands and flags in help', async () => {
    const { stdout } = await run(['--help'])
    expect(stdout).toContain('ping')
    expect(stdout).toContain('Who am I')
    expect(stdout).toContain('--demo-token <value>')
    expect(stdout).toContain('(or DEMO_TOKEN)')
  })

  it('still rejects a flag no plugin and no op declares', async () => {
    const { code, stderr } = await run(['ping', '--nope', 'x'])
    expect(code).toBe(2)
    expect(stderr).toContain('Unknown flag --nope')
  })
})
