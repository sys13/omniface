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
  return { port, banner }
}

describe('omniface dev', () => {
  it('listens on loopback only unless told otherwise', async () => {
    const { port, banner } = await dev()
    expect(banner).toContain(`http://localhost:${port}`)
    // No polling: the banner is written once the server is listening, so it can be dialled at once.
    expect(await reachable('127.0.0.1', port)).toBe(true)
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

  it('says the port is taken, and prints no banner, when it cannot bind', async () => {
    const port = await freePort()
    const holder = createNetServer()
    await new Promise<void>((done) => holder.listen(port, '127.0.0.1', done))
    try {
      child = spawn(process.execPath, [BIN, 'dev', ENTRY, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      const code = await new Promise<number | null>((done) => child!.once('exit', done))
      expect(code).not.toBe(0)
      expect(stderr).toContain(String(port))
      expect(stderr).not.toContain('omniface dev:')
      expect(stderr.trim().split('\n')).toHaveLength(1)
    } finally {
      await new Promise((done) => holder.close(done))
    }
  }, 20_000)
})
