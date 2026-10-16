import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { execPackageCommand } from './package-command.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE_PACKAGE_PATH = path.join(ROOT, 'packages', 'core', 'package.json')
const COMMAND_TIMEOUT_MS = 5 * 60_000
const EVIDENCE_LIMIT = 2000

/**
 * Checks this smoke owns. They prove the published CLI resolved its own dependencies, that the
 * documented `install-electron` step provisioned the binary the server launches with, and that
 * doctor produced a report.
 */
const REQUIRED_PASSING_CHECKS = ['node', 'playwright', 'electron', 'eval_policy']

function exactVersion(value, packageName) {
  if (typeof value !== 'string' || !/^\^?\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Expected an exact release version for ${packageName}.`)
  }
  return value.replace(/^\^/, '')
}

/** The documented `npx` invocation for one package list; only the trailing command differs. */
export function npxArguments(packages, command) {
  return [
    '-y',
    '--prefix',
    '~/',
    ...packages.flatMap((packageName) => ['--package', packageName]),
    ...command,
  ]
}

/**
 * Stand in for an Electron app project that already depends on the pinned launch peers. Without
 * `--prefix`, `npx` run from here leaves those peers out of its cache, where core cannot load them.
 */
export async function writeProjectFixture(directory, packages) {
  const peers = packages
    .map((specifier) => /^(playwright|electron)@(.+)$/.exec(specifier))
    .filter((match) => match !== null)
    .map(([, name, version]) => ({ name, version }))
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'published-npx-smoke-project',
        private: true,
        devDependencies: Object.fromEntries(peers.map(({ name, version }) => [name, version])),
      },
      null,
      2,
    )}\n`,
  )
  for (const { name, version } of peers) {
    const packageDirectory = path.join(directory, 'node_modules', name)
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(
      path.join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name, version })}\n`,
    )
  }
  return peers.map(({ name }) => name)
}

const INSTALL_ELECTRON = ['install-electron']
const DOCTOR_JSON = ['electron-stagewright', 'doctor', '--json']

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
    const { stdout, stderr } = await execPackageCommand(
      'npx',
      npxArguments(packages, DOCTOR_JSON),
      options,
    )
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
      `The npx doctor command did not emit a single doctor JSON document (exit ${code}): ${
        error instanceof Error ? error.message : String(error)
      }\n${evidence('stdout', stdout)}\n${evidence('stderr', stderr)}`,
    )
  }
  if (report === null || typeof report !== 'object' || !Array.isArray(report.checks)) {
    throw new Error(
      `The npx doctor output is not a report with checks (exit ${code}).\n${evidence(
        'stdout',
        stdout,
      )}`,
    )
  }
  for (const id of REQUIRED_PASSING_CHECKS) {
    const check = report.checks.find((candidate) => candidate?.id === id)
    if (check?.status !== 'pass') {
      throw new Error(
        `The npx doctor output did not pass the ${id} check: ${JSON.stringify(
          check ?? null,
        )}\n${evidence('stdout', stdout)}`,
      )
    }
  }
  return report
}

function summarize(report, packages, projectPeers) {
  const status = (id) => report.checks.find((check) => check?.id === id)?.status ?? 'absent'
  return [
    `published npx smoke passed after a clean-cache bootstrap: ${packages.join(', ')}`,
    `  cwd: a project that already has ${projectPeers.join(', ')}`,
    `  doctor.ok=${report.ok} node=${status('node')} playwright=${status('playwright')} electron=${status('electron')}`,
  ].join('\n')
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
  const project = path.join(scratch, 'project')
  const options = {
    cwd: project,
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
    // `--prefix` must name an existing directory, which a real home always is.
    await mkdir(home, { recursive: true })
    const projectPeers = await writeProjectFixture(project, packages)
    // The documented first step: Electron downloads its binary lazily, so fetch it outside any MCP
    // transport. Its progress output is expected and not part of the contract.
    await execPackageCommand('npx', npxArguments(packages, INSTALL_ELECTRON), options)
    const report = assertDoctorReport(await runPublishedDoctor(packages, options))
    process.stderr.write(`${summarize(report, packages, projectPeers)}\n`)
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
