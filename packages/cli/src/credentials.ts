import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Where a CLI credential lives between runs.
 *
 * `login` used to write the key into `credentials.json` in the clear, mode 0600. That is the right
 * floor and the wrong ceiling: file permissions stop another account reading it and stop nothing
 * that already runs as this one — a shell history grep, a backup, a stray `cat` in a screen share.
 * The OS keyrings exist for exactly this and cost nothing but a subprocess.
 *
 * What is *not* here is any opinion about what the credential means. The store holds bytes the
 * server issued and the server verifies; 2.6 is about how a credential is presented per facet, and
 * the `AuthAdapter` contract is untouched by this file.
 */
export type StoredCredentials = { baseUrl?: string; apiKey?: string }

export type CredentialStore = {
  /** Where the secret ends up, for the sentence `login` prints. Not a path to parse. */
  readonly where: string
  read(): Promise<StoredCredentials>
  write(creds: StoredCredentials): Promise<void>
}

/** Run a program. Injected so the keyring backends are testable without a keyring. */
export type RunCommand = (file: string, args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>

export const execCommand: RunCommand = (file, args, stdin) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { encoding: 'utf8' }, (error, stdout) => {
      // A missing binary and a non-zero exit are the same answer here: this keyring cannot serve us.
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout: stdout || '' })
    })
    if (stdin !== undefined) child.stdin?.end(stdin)
  })

// ---------------------------------------------------------------------------------------------
// The file

/**
 * `credentials.json`, mode 0600 in a 0700 directory. Still the fallback on any platform whose
 * keyring we cannot reach, and still the home of `baseUrl`, which is not a secret and is a
 * nuisance to keep in a keyring.
 */
export function fileStore(dir: string): CredentialStore {
  const path = join(dir, 'credentials.json')
  return {
    where: path,
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as StoredCredentials
      } catch {
        return {}
      }
    },
    async write(creds) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(path, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The keyrings

/** One secret, by name. The two backends below differ only in which program says it. */
type Keyring = {
  readonly where: string
  get(account: string): Promise<string | undefined>
  set(account: string, secret: string): Promise<boolean>
  clear(account: string): Promise<void>
}

function macKeyring(service: string, run: RunCommand): Keyring {
  const id = ['-a', service, '-s', service]
  return {
    where: 'the macOS keychain',
    async get() {
      const { code, stdout } = await run('security', ['find-generic-password', ...id, '-w'])
      return code === 0 && stdout.trim() ? stdout.trim() : undefined
    },
    async set(_account, secret) {
      // -U updates in place; without it a second login stacks a duplicate entry that `find` may
      // answer with the older of the two.
      const { code } = await run('security', ['add-generic-password', ...id, '-U', '-w', secret])
      return code === 0
    },
    async clear() {
      await run('security', ['delete-generic-password', ...id])
    },
  }
}

function libsecretKeyring(service: string, run: RunCommand): Keyring {
  const id = ['service', service, 'account', service]
  return {
    where: 'the login keyring',
    async get() {
      const { code, stdout } = await run('secret-tool', ['lookup', ...id])
      return code === 0 && stdout.trim() ? stdout.trim() : undefined
    },
    async set(_account, secret) {
      // secret-tool reads the secret from stdin, which is the point: it never reaches argv, where
      // `ps` would show it to every other process on the machine.
      const { code } = await run('secret-tool', ['store', '--label', service, ...id], secret)
      return code === 0
    },
    async clear() {
      await run('secret-tool', ['clear', ...id])
    },
  }
}

/** The keyring for a platform, or undefined where we have no way in and the file has to do. */
export function keyringFor(platform: string, service: string, run: RunCommand): Keyring | undefined {
  if (platform === 'darwin') return macKeyring(service, run)
  if (platform === 'linux') return libsecretKeyring(service, run)
  // Windows has a credential manager, and no shipped command that will read a secret back out of
  // it — `cmdkey` writes and lists but never prints. Reaching it means DPAPI through PowerShell,
  // which is a bigger surface than this slice, so Windows keeps the 0600 file and says so.
  return undefined
}

// ---------------------------------------------------------------------------------------------
// The two together

/**
 * The secret in the keyring, everything else in the file, and the file as the whole answer when
 * there is no keyring to reach.
 *
 * A key already sitting in `credentials.json` from before this existed is still read, so nobody is
 * logged out by an upgrade. It moves into the keyring the next time `login` runs — writing it there
 * is what strips it from the file.
 */
export function credentialStore(options: {
  dir: string
  service: string
  platform?: string
  run?: RunCommand
}): CredentialStore {
  const file = fileStore(options.dir)
  const keyring = keyringFor(options.platform ?? process.platform, options.service, options.run ?? execCommand)
  if (!keyring) return file
  return {
    where: `${keyring.where}, with the rest in ${file.where}`,
    async read() {
      const stored = await file.read()
      const secret = await keyring.get(options.service)
      return { ...stored, ...(secret ? { apiKey: secret } : {}) }
    },
    async write(creds) {
      const { apiKey, ...rest } = creds
      if (apiKey === undefined) {
        await keyring.clear(options.service)
        await file.write(rest)
        return
      }
      // If the keyring refuses — locked, no daemon, no binary — the credential still has to land
      // somewhere the next command can read, so fall back rather than fail the login.
      if (await keyring.set(options.service, apiKey)) await file.write(rest)
      else await file.write(creds)
    },
  }
}
