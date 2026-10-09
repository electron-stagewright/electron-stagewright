import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function runCli(args: readonly string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'stagewright-cli-usage-'))
  homes.push(home)
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 10_000,
  })
}

describe('built CLI usage recovery', () => {
  it.each(['--help', '--version'])('keeps %s successful and stdout-only', (flag) => {
    const result = runCli([flag])
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().length).toBeGreaterThan(0)
  })

  it.each([
    [['--not-a-real-option'], 'Unknown option: --not-a-real-option'],
    [['--app-root'], '--app-root expects a value'],
    [['unexpected'], 'Unexpected argument: unexpected'],
    [['doctor', '--help'], '--help must be used on its own'],
    [['--demo', '--app-root', '.'], '--demo cannot be combined with --app-root'],
  ])('explains %j without starting MCP or printing a stack', (args, message) => {
    const result = runCli(args)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(message)
    expect(result.stderr).toContain('Run electron-stagewright --help')
    expect(result.stderr).not.toMatch(/\n\s+at /)
  })
})
