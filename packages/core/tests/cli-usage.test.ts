import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function runCli(args: readonly string[], input?: string) {
  const home = mkdtempSync(path.join(tmpdir(), 'stagewright-cli-usage-'))
  homes.push(home)
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 10_000,
    ...(input !== undefined ? { input } : {}),
  })
}

function runHeldServer(
  preload: string,
  endStdin: boolean,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const home = mkdtempSync(path.join(tmpdir(), 'stagewright-cli-usage-'))
  homes.push(home)
  const preloadPath = path.join(home, 'hold.mjs')
  writeFileSync(preloadPath, preload)
  const child = spawn(process.execPath, ['--import', pathToFileURL(preloadPath).href, cli], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const timer = setTimeout(() => child.kill('SIGKILL'), 4_000)
  if (endStdin) child.stdin.end()
  return new Promise((resolve) => {
    child.on('close', (status) => {
      clearTimeout(timer)
      child.stdin.destroy()
      resolve({ status, stdout, stderr })
    })
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
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(message)
    expect(result.stderr).toContain('Run electron-stagewright --help')
    expect(result.stderr).not.toMatch(/\n\s+at /)
  })

  it('reports a misspelled --plugin as one typed line without a stack', () => {
    const result = runCli(['--plugin', 'stagewright-no-such-plugin'], '')
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^fatal: PLUGIN_LOAD_FAILED: Could not import plugin /)
    expect(result.stderr).not.toMatch(/\n\s+at /)
  })

  // The preload's interval stands in for a launched app holding the event loop open.
  it.each([
    ['the host closes stdin', 'setInterval(() => {}, 1_000)', true],
    [
      'stdin is destroyed without EOF',
      'setInterval(() => {}, 1_000); setTimeout(() => process.stdin.destroy(), 200)',
      false,
    ],
  ])('shuts down when %s while the event loop is held', async (_case, preload, endStdin) => {
    const result = await runHeldServer(preload, endStdin)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Shutting down {"reason":"stdin closed"}')
  })

  it('exits 1 when teardown fails during a stdin-close shutdown', async () => {
    // The SDK stdio transport pauses stdin while closing, so a throwing pause fails the MCP close.
    const preload = [
      'setInterval(() => {}, 1_000)',
      "process.stdin.pause = () => { throw new Error('pause failed') }",
    ].join('\n')
    const result = await runHeldServer(preload, true)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Error during shutdown {"error":"pause failed"}')
  })
})
