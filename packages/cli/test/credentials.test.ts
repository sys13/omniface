import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialStore, fileStore, type RunCommand } from '@omniface/cli'
import { describe, expect, it } from 'vitest'

/** A keyring made of a Map, driven through the same argv the real backends build. */
function fakeKeyring(options: { refuse?: boolean } = {}) {
  const secrets = new Map<string, string>()
  const calls: { file: string; args: string[]; stdin?: string }[] = []
  const run: RunCommand = async (file, args, stdin) => {
    calls.push({ file, args, stdin })
    if (options.refuse) return { code: 1, stdout: '' }
    const key = args.includes('-s') ? args.indexOf('-s') : args.indexOf('service')
    const service = args[key + 1]!
    if (args[0] === 'find-generic-password' || args[0] === 'lookup') {
      const found = secrets.get(service)
      return found ? { code: 0, stdout: found + '\n' } : { code: 44, stdout: '' }
    }
    if (args[0] === 'add-generic-password') {
      secrets.set(service, args[args.indexOf('-w') + 1]!)
      return { code: 0, stdout: '' }
    }
    if (args[0] === 'store') {
      secrets.set(service, stdin!)
      return { code: 0, stdout: '' }
    }
    secrets.delete(service)
    return { code: 0, stdout: '' }
  }
  return { run, secrets, calls }
}

const dir = () => mkdtempSync(join(tmpdir(), 'facet-creds-'))
const fileAt = (d: string) => JSON.parse(readFileSync(join(d, 'credentials.json'), 'utf8')) as Record<string, unknown>

describe('the credential store', () => {
  it('keeps the secret out of the file on every platform that has a keyring', async () => {
    for (const platform of ['darwin', 'linux']) {
      const d = dir()
      const keyring = fakeKeyring()
      const store = credentialStore({ dir: d, service: 'tasks', platform, run: keyring.run })
      await store.write({ baseUrl: 'http://facet.test', apiKey: 'sk_live' })

      // The whole point: what is on disk has the address and not the credential.
      expect(fileAt(d)).toEqual({ baseUrl: 'http://facet.test' })
      expect(readFileSync(join(d, 'credentials.json'), 'utf8')).not.toContain('sk_live')
      expect(keyring.secrets.get('tasks')).toBe('sk_live')
      expect(await store.read()).toEqual({ baseUrl: 'http://facet.test', apiKey: 'sk_live' })
    }
  })

  it('never puts the secret in argv on linux, where every process can read it', async () => {
    const keyring = fakeKeyring()
    const store = credentialStore({ dir: dir(), service: 'tasks', platform: 'linux', run: keyring.run })
    await store.write({ apiKey: 'sk_live' })
    const stored = keyring.calls.find((c) => c.args[0] === 'store')!
    expect(stored.args).not.toContain('sk_live')
    expect(stored.stdin).toBe('sk_live')
  })

  it('updates in place rather than stacking entries on a second login', async () => {
    const keyring = fakeKeyring()
    const store = credentialStore({ dir: dir(), service: 'tasks', platform: 'darwin', run: keyring.run })
    await store.write({ apiKey: 'one' })
    await store.write({ apiKey: 'two' })
    expect(keyring.calls.filter((c) => c.args[0] === 'add-generic-password').every((c) => c.args.includes('-U'))).toBe(true)
    expect(await store.read()).toMatchObject({ apiKey: 'two' })
  })

  it('falls back to the file rather than failing the login when the keyring refuses', async () => {
    const d = dir()
    const store = credentialStore({ dir: d, service: 'tasks', platform: 'darwin', run: fakeKeyring({ refuse: true }).run })
    await store.write({ baseUrl: 'http://facet.test', apiKey: 'sk_live' })
    // Worse than a keyring, better than being unable to log in at all.
    expect(fileAt(d)).toMatchObject({ apiKey: 'sk_live' })
    expect(await store.read()).toMatchObject({ apiKey: 'sk_live' })
  })

  it('uses the file alone where there is no keyring we can reach', async () => {
    const d = dir()
    const keyring = fakeKeyring()
    const store = credentialStore({ dir: d, service: 'tasks', platform: 'win32', run: keyring.run })
    await store.write({ apiKey: 'sk_live' })
    // Not "tried the keyring and failed" — never reached for one, so nothing was spawned.
    expect(keyring.calls).toEqual([])
    expect(fileAt(d)).toMatchObject({ apiKey: 'sk_live' })
    expect(store.where).toBe(join(d, 'credentials.json'))
  })

  it('still reads a key written before the keyring existed, so an upgrade logs nobody out', async () => {
    const d = dir()
    await fileStore(d).write({ baseUrl: 'http://facet.test', apiKey: 'sk_old' })
    const keyring = fakeKeyring()
    const store = credentialStore({ dir: d, service: 'tasks', platform: 'darwin', run: keyring.run })
    expect(await store.read()).toMatchObject({ apiKey: 'sk_old' })

    // And the next login is the migration: the keyring takes it and the file stops holding it.
    await store.write({ baseUrl: 'http://facet.test', apiKey: 'sk_old' })
    expect(fileAt(d)).toEqual({ baseUrl: 'http://facet.test' })
    expect(keyring.secrets.get('tasks')).toBe('sk_old')
  })

  it('clears the keyring on logout rather than only the file', async () => {
    const d = dir()
    const keyring = fakeKeyring()
    const store = credentialStore({ dir: d, service: 'tasks', platform: 'darwin', run: keyring.run })
    await store.write({ apiKey: 'sk_live' })
    await store.write({})
    expect(keyring.secrets.has('tasks')).toBe(false)
    expect(await store.read()).toEqual({})
  })
})
