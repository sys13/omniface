import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '@omniface/cli'
import { buildManifest, createServer } from 'omniface'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTasksApp, DEV_KEYS } from '../src/app.ts'

function setup() {
  const app = createTasksApp({ logSink: () => {} })
  const server = createServer(app)
  const manifest = buildManifest(app)
  const configDir = mkdtempSync(join(tmpdir(), 'facet-cli-'))
  const run = async (argv: string[], opts: { tty?: boolean; env?: Record<string, string>; answer?: string } = {}) => {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      manifest,
      argv,
      configDir,
      retries: 0,
      env: { TASKS_API_KEY: DEV_KEYS.admin, TASKS_BASE_URL: 'http://facet.test', ...opts.env },
      fetch: async (i, init) => server.fetch(new Request(i, init)),
      io: {
        stdout: { write: (s) => void (stdout += s), isTTY: opts.tty ?? false },
        stderr: { write: (s) => void (stderr += s) },
        stdinIsTTY: opts.tty ?? false,
        prompt: async () => opts.answer ?? '',
      },
    })
    return { code, stdout, stderr }
  }
  return { run, configDir }
}

describe('generated CLI', () => {
  let cli: ReturnType<typeof setup>
  beforeEach(() => {
    cli = setup()
  })

  it('lists commands from the manifest, including plugin commands and login', async () => {
    const { code, stdout } = await cli.run(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('tasks create <title>')
    expect(stdout).toContain('tasks get <id>')
    expect(stdout).toContain('api-keys create')
    expect(stdout).toContain('login')
  })

  it('shows group help and op help from the schema', async () => {
    expect((await cli.run(['tasks'])).stdout).toContain('tasks complete <id>')
    const { stdout } = await cli.run(['tasks', 'create', '--help'])
    expect(stdout).toContain('Usage: tasks tasks create <title> [flags]')
    expect(stdout).toContain('--priority <low|normal|high>')
    expect(stdout).toContain('--assignee-email <string>')
  })

  it('takes positionals, kebab-case flags and coerces types', async () => {
    const created = await cli.run(['tasks', 'create', 'Ship it', '--priority', 'high', '--assignee-email', 'a@b.co'])
    expect(created.code).toBe(0)
    expect(JSON.parse(created.stdout)).toMatchObject({ id: 'task_1', title: 'Ship it', priority: 'high', assigneeEmail: 'a@b.co' })
    await cli.run(['tasks', 'complete', 'task_1'])
    const listed = await cli.run(['tasks', 'list', '--done', '--limit', '5'])
    expect(JSON.parse(listed.stdout).items).toHaveLength(1)
    const none = await cli.run(['tasks', 'list', '--no-done'])
    expect(JSON.parse(none.stdout).items).toHaveLength(0)
  })

  it('renders tables in a terminal and JSON when piped', async () => {
    await cli.run(['tasks', 'create', 'First'])
    await cli.run(['tasks', 'create', 'Second'])
    const table = await cli.run(['tasks', 'list'], { tty: true })
    expect(table.stdout.split('\n')[0]).toMatch(/^ID\s+TITLE\s+DONE\s+PRIORITY$/)
    expect(table.stdout).toContain('Second')
    const json = await cli.run(['tasks', 'get', 'task_1'])
    expect(JSON.parse(json.stdout)).toMatchObject({ title: 'First' })
    const forced = await cli.run(['tasks', 'get', 'task_1', '-o', 'json'], { tty: true })
    expect(JSON.parse(forced.stdout)).toMatchObject({ title: 'First' })
  })

  it('pages with --all and hints at the next cursor otherwise', async () => {
    for (let i = 1; i <= 5; i++) await cli.run(['tasks', 'create', `T${i}`])
    const page = await cli.run(['tasks', 'list', '--limit', '2'], { tty: true })
    expect(page.stdout).toMatch(/More results: tasks tasks list --cursor \S+ {2}\(or --all\)/)
    const all = await cli.run(['tasks', 'list', '--limit', '2', '--all'])
    expect(JSON.parse(all.stdout).items).toHaveLength(5)
  })

  it('refuses destructive commands without --yes when not interactive', async () => {
    await cli.run(['tasks', 'create', 'Doomed'])
    const refused = await cli.run(['tasks', 'delete', 'task_1'])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('is destructive. Re-run with --yes')
    const aborted = await cli.run(['tasks', 'delete', 'task_1'], { tty: true, answer: 'n' })
    expect(aborted.code).toBe(1)
    const confirmed = await cli.run(['tasks', 'delete', 'task_1'], { tty: true, answer: 'y' })
    expect(confirmed.code).toBe(0)
  })

  it('maps errors to exit codes with actionable messages', async () => {
    const missing = await cli.run(['tasks', 'get', 'task_404'])
    expect(missing).toMatchObject({ code: 5 })
    expect(missing.stderr).toContain('Error (not_found): No task "task_404"')

    const unauth = await cli.run(['tasks', 'list'], { env: { TASKS_API_KEY: '' } })
    expect(unauth.code).toBe(3)
    expect(unauth.stderr).toContain('Run `tasks login` or set TASKS_API_KEY.')

    const forbidden = await cli.run(['tasks', 'create', 'x'], { env: { TASKS_API_KEY: DEV_KEYS.reader } })
    expect(forbidden.code).toBe(4)

    const invalid = await cli.run(['tasks', 'create', 'x', '--priority', 'urgent'])
    expect(invalid.code).toBe(2)
    expect(invalid.stderr).toContain('--priority')

    const usage = await cli.run(['tasks', 'create', 'x', '--colour', 'red'])
    expect(usage).toMatchObject({ code: 2, stderr: expect.stringContaining('Unknown flag --colour') })
    expect((await cli.run(['tasks', 'create'])).stderr).toContain('Missing required <title>')
    expect((await cli.run(['nope'])).code).toBe(2)
  })

  it('logs in by verifying the key, then uses the saved credentials', async () => {
    const bad = await cli.run(['login', '--api-key', 'wrong'], { env: { TASKS_API_KEY: '' } })
    expect(bad.code).toBe(3)
    const ok = await cli.run(['login', '--api-key', DEV_KEYS.reader], { env: { TASKS_API_KEY: '' } })
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('Logged in as user_reader')
    const file = join(cli.configDir, 'credentials.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ apiKey: DEV_KEYS.reader })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const me = await cli.run(['auth', 'whoami'], { env: { TASKS_API_KEY: '' } })
    expect(JSON.parse(me.stdout)).toMatchObject({ id: 'user_reader' })
  })
})
