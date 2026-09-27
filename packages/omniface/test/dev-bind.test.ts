import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createNetServer, connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// `omniface dev` is a development server: it listens on loopback unless it is told otherwise, the
// same closed-by-default posture CORS, CSRF and the security headers ship with.

const ROOT = resolve(import.meta.dirname, '../../..')
const BIN = resolve(ROOT, 'packages/omniface/bin/omniface.mjs')
const ENTRY = resolve(ROOT, 'examples/tasks/src/app.ts')

/** A port nothing is listening on, found by asking the OS for one and giving it back. */
const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createNetServer().once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => done(port))
    })
  })

/** Whether a TCP connection to `host:port` is accepted. */
const reachable = (host: string, port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect({ host, port })
    socket.setTimeout(2000)
    socket.once('connect', () => (socket.destroy(), done(true)))
    socket.once('error', () => done(false))
    socket.once('timeout', () => (socket.destroy(), done(false)))
  })

/** A non-loopback IPv4 address of this machine — what another host on the network would dial. */
const lanAddress = () =>
  Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address

let child: ChildProcess | undefined
afterEach(() => {
  child?.kill()
  child = undefined
})

async function dev(...args: string[]): Promise<{ port: number; banner: string }> {
  const port = await freePort()
  child = spawn(process.execPath, [BIN, 'dev', ENTRY, '--port', String(port), ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  let banner = ''
  await new Promise<void>((done, fail) => {
    child!.stderr!.on('data', (chunk: Buffer) => {
      banner += chunk.toString()
      if (banner.includes('inspector')) done()
    })
    child!.once('exit', (code) => fail(new Error(`omniface dev exited with ${code}:\n${banner}`)))
  })
  // The banner is written as the server starts listening, not once it has: wait for loopback.
  const deadline = Date.now() + 10_000
  while (!(await reachable('127.0.0.1', port))) {
    if (Date.now() > deadline) throw new Error(`omniface dev never listened on 127.0.0.1:${port}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  return { port, banner }
}

describe('omniface dev', () => {
  it('listens on loopback only unless told otherwise', async () => {
    const { port, banner } = await dev()
    expect(banner).toContain(`http://localhost:${port}`)
    const lan = lanAddress()
    if (lan) expect(await reachable(lan, port)).toBe(false)
  }, 20_000)

  it('binds wider only when --host asks for it', async () => {
    const lan = lanAddress()
    if (!lan) return // A machine with no network interface has nothing to be reachable from.
    const { port } = await dev('--host', '0.0.0.0')
    // Proves the refusal above was the bind address, not a network that refuses everything.
    expect(await reachable(lan, port)).toBe(true)
  }, 20_000)
})
