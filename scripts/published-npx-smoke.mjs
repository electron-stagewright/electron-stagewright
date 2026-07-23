import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { execPackageCommand } from './package-command.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE_PACKAGE_PATH = path.join(ROOT, 'packages', 'core', 'package.json')
const COMMAND_TIMEOUT_MS = 5 * 60_000
const EVIDENCE_LIMIT = 2000

/**
 * Checks this smoke owns. They prove the published CLI resolved its own dependencies and produced a
 * report.
 *
 * `electron` is excluded deliberately. This smoke bootstraps into an isolated, cold Electron cache to
 * prove a clean install, and that sandbox does not provision Electron's binary on every platform —
 * on the Linux runner it does not, so nothing lands under `dist/`. Requiring the check would assert a
 * property of the sandbox rather than of the published package. Real-Electron coverage belongs to the
 * e2e job, which provisions the binary deterministically before driving an app. The check's status is
 * still reported below so a maintainer sees it.
 */
const REQUIRED_PASSING_CHECKS = ['node', 'playwright', 'eval_policy']

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

function evidence(label, value) {
  const text = (value ?? '').toString().trim()
  if (text === '') return `${label}: <empty>`
  const clipped = text.length > EVIDENCE_LIMIT ? `${text.slice(0, EVIDENCE_LIMIT)}…` : text
  return `${label}:\n${clipped}`
}

/**
 * Run the published command and return its outcome without throwing. `doctor` exits non-zero when a
 * check fails, which is a report about the environment rather than a crash, so the exit code alone
 * must not end the smoke — the JSON on stdout is the contract.
 */
async function runPublishedDoctor(packages, options) {
  try {
    const { stdout, stderr } = await execPackageCommand('npx', npxArguments(packages), options)
    return { stdout, stderr, code: 0 }
  } catch (error) {
    return { stdout: error?.stdout ?? '', stderr: error?.stderr ?? '', code: error?.code ?? 1 }
  }
}

/**
 * Assert the contract this smoke owns: the published CLI emits exactly one valid doctor JSON
 * document on stdout (an MCP host would otherwise fail to parse the stream) and every check in
 * {@link REQUIRED_PASSING_CHECKS} passes. Returns the parsed report for reporting.
 */
export function assertDoctorReport(outcome) {
  const { stdout, stderr, code } = outcome
  let report
  try {
    report = JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `The warmed npx command did not emit a single doctor JSON document (exit ${code}): ${
        error instanceof Error ? error.message : String(error)
      }\n${evidence('stdout', stdout)}\n${evidence('stderr', stderr)}`,
    )
  }
  if (report === null || typeof report !== 'object' || !Array.isArray(report.checks)) {
    throw new Error(
      `The warmed npx doctor output is not a report with checks (exit ${code}).\n${evidence(
        'stdout',
        stdout,
      )}`,
    )
  }
  for (const id of REQUIRED_PASSING_CHECKS) {
    const check = report.checks.find((candidate) => candidate?.id === id)
    if (check?.status !== 'pass') {
      throw new Error(
        `The warmed npx doctor output did not pass the ${id} check: ${JSON.stringify(
          check ?? null,
        )}\n${evidence('stdout', stdout)}`,
      )
    }
  }
  return report
}

function summarize(report, packages) {
  const status = (id) => report.checks.find((check) => check?.id === id)?.status ?? 'absent'
  return [
    `published npx smoke passed after a clean-cache bootstrap: ${packages.join(', ')}`,
    `  doctor.ok=${report.ok} node=${status('node')} playwright=${status('playwright')} electron=${status('electron')}`,
    status('electron') === 'pass'
      ? ''
      : "  note: this sandbox's cold Electron cache provisioned no binary, so the electron check is\n" +
        '  expected to fail here. Driving a real Electron app is the e2e job, not this smoke.',
  ]
    .filter((line) => line !== '')
    .join('\n')
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
  const options = {
    cwd: scratch,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: path.join(scratch, 'xdg-cache'),
      ELECTRON_CACHE: path.join(scratch, 'electron-cache'),
      NPM_CONFIG_CACHE: path.join(scratch, 'npm-cache'),
      npm_config_cache: path.join(scratch, 'npm-cache'),
      NO_COLOR: '1',
    },
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  }
  try {
    // Electron's install can write binary-download progress to stdout on the first run. This command
    // exists only to absorb that outside an MCP transport and to warm the npx cache the measured run
    // reuses, so its output AND its exit code are both discarded.
    await runPublishedDoctor(packages, options)
    const report = assertDoctorReport(await runPublishedDoctor(packages, options))
    process.stderr.write(`${summarize(report, packages)}\n`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `published npx smoke failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
