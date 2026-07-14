import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE_PACKAGE_PATH = path.join(ROOT, 'packages', 'core', 'package.json')
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const COMMAND_TIMEOUT_MS = 5 * 60_000

function exactVersion(value, packageName) {
  if (typeof value !== 'string' || !/^\^?\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Expected an exact release version for ${packageName}.`)
  }
  return value.replace(/^\^/, '')
}

function npxArguments(packages) {
  return [
    '-y',
    ...packages.flatMap((packageName) => ['--package', packageName]),
    'electron-stagewright',
    'doctor',
    '--json',
  ]
}

function assertDoctorReport(stdout) {
  let report
  try {
    report = JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `The warmed npx command did not emit a single doctor JSON document: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (report === null || typeof report !== 'object' || report.ok !== true) {
    throw new Error(`The warmed npx doctor check failed: ${JSON.stringify(report)}`)
  }
  const checks = report.checks
  if (!Array.isArray(checks)) throw new Error('The warmed npx doctor output omitted checks.')
  for (const id of ['playwright', 'electron']) {
    if (!checks.some((check) => check?.id === id && check?.status === 'pass')) {
      throw new Error(`The warmed npx doctor output did not pass the ${id} check.`)
    }
  }
}

async function main() {
  const core = JSON.parse(await readFile(CORE_PACKAGE_PATH, 'utf8'))
  const packages = [
    `${core.name}@${exactVersion(core.version, 'core')}`,
    `playwright@${exactVersion(core.devDependencies?.playwright, 'playwright')}`,
    `electron@${exactVersion(core.devDependencies?.electron, 'electron')}`,
  ]
  const scratch = await mkdtemp(path.join(tmpdir(), 'stagewright-published-npx-'))
  const home = path.join(scratch, 'home')
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(scratch, 'xdg-cache'),
    ELECTRON_CACHE: path.join(scratch, 'electron-cache'),
    NPM_CONFIG_CACHE: path.join(scratch, 'npm-cache'),
    npm_config_cache: path.join(scratch, 'npm-cache'),
    NO_COLOR: '1',
  }
  try {
    // Electron's first postinstall can write a binary-download progress line to stdout. This command
    // runs outside an MCP transport and is intentionally discarded; it warms the same npx cache the
    // host will subsequently use.
    await execFile(NPX, npxArguments(packages), {
      cwd: scratch,
      env,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    const { stdout } = await execFile(NPX, npxArguments(packages), {
      cwd: scratch,
      env,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    assertDoctorReport(stdout)
    process.stderr.write(
      `published npx smoke passed after a clean-cache bootstrap: ${packages.join(', ')}\n`,
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(
    `published npx smoke failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exitCode = 1
})
