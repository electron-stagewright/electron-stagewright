/**
 * Production-readiness checks for a packaged macOS app (ADR-012).
 *
 * Each check returns a {@link CheckResult} whose `status` encodes the load-bearing distinction the
 * acceptance criteria demand: `pass` (verified good), `fail` (verified bad — a real packaging or
 * signing defect), and `unknown` (could not be determined — a required CLI is absent, a command
 * times out, or the host is not macOS; i.e. MISSING evidence, not a failure). The shell-out checks
 * derive `unknown` from the command runner's `spawnError` rather than a platform branch, so on a
 * non-macOS host the tools are simply absent (`unknown`) and tests can drive every branch through
 * a fake {@link RunCommand}.
 *
 * @module
 */

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { CommandResult, RunCommand } from './command.js'

/** Outcome class of a check: verified good, verified bad, or could-not-determine. */
export type CheckStatus = 'pass' | 'fail' | 'unknown'

/**
 * The result of one production-readiness check.
 *
 * - `status` — `pass` (verified good), `fail` (verified bad: a real defect), or `unknown` (missing
 *   evidence — a CLI absent, a command timeout, or a non-macOS host; never conflate with `fail`).
 * - `detail` — one human-readable sentence explaining the outcome.
 * - `evidence` — a short justifying snippet (a tool's output line, the signing authority) when one
 *   is available; omitted otherwise.
 * - `next_actions` — remediation steps; present only on `fail`.
 */
export interface CheckResult {
  readonly id: CheckId
  readonly title: string
  readonly status: CheckStatus
  readonly detail: string
  readonly evidence?: string
  readonly next_actions?: readonly string[]
}

/**
 * The checks this plugin runs, in a stable display order that mirrors the real build pipeline
 * (structure → Info.plist → sign → notarize → the Gatekeeper launch gate). Doubles as the `checks`
 * argument enum.
 */
export const CHECK_IDS = [
  'bundle-structure',
  'info-plist',
  'code-signing',
  'notarization',
  'gatekeeper',
] as const

/** A check identifier — one of {@link CHECK_IDS}. */
export type CheckId = (typeof CHECK_IDS)[number]

/** First non-empty line of a tool's output, trimmed — a compact `evidence` snippet. */
function firstLine(value: string): string {
  const trimmed = value.trim()
  const nl = trimmed.indexOf('\n')
  return nl === -1 ? trimmed : trimmed.slice(0, nl)
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

async function hasMacOSExecutable(dir: string): Promise<boolean> {
  let entries: readonly string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    const missing =
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { readonly code?: unknown }).code === 'ENOENT'
    if (missing) return false
    throw err
  }
  for (const entry of entries) {
    if ((await isFile(path.join(dir, entry))) === true) return true
  }
  return false
}

const BUNDLE_TITLE = 'macOS app bundle structure'

/**
 * Verify the `.app` is a well-formed bundle: a `Contents/Info.plist` file plus at least one entry
 * under `Contents/MacOS/`. Pure filesystem — no external tool — so it is cross-platform and
 * fixture-testable. (Field-level Info.plist field checks — bundle id, version — are the separate
 * info-plist check.) A missing piece is a `fail` (the bundle is broken); an unreadable path is
 * `unknown`. The tool validates the app path exists before any check runs, so that case is handled
 * upstream.
 */
export async function checkBundleStructure(appPath: string): Promise<CheckResult> {
  const id = 'bundle-structure' as const
  try {
    const infoPresent = await isFile(path.join(appPath, 'Contents', 'Info.plist'))
    const hasExecutable = await hasMacOSExecutable(path.join(appPath, 'Contents', 'MacOS'))
    if (infoPresent && hasExecutable) {
      return {
        id,
        title: BUNDLE_TITLE,
        status: 'pass',
        detail: 'The bundle has Contents/Info.plist and at least one Contents/MacOS executable.',
      }
    }
    const missing: string[] = []
    if (!infoPresent) missing.push('Contents/Info.plist')
    if (!hasExecutable) missing.push('a Contents/MacOS executable')
    return {
      id,
      title: BUNDLE_TITLE,
      status: 'fail',
      detail: `The app bundle is missing ${missing.join(' and ')}.`,
      next_actions: [
        'Repackage the app as a well-formed .app (Contents/Info.plist plus Contents/MacOS/<binary>).',
      ],
    }
  } catch (err) {
    return {
      id,
      title: BUNDLE_TITLE,
      status: 'unknown',
      detail: `Could not inspect the bundle: ${err instanceof Error ? err.message : String(err)}.`,
    }
  }
}

const INFO_PLIST_TITLE = 'Info.plist metadata'

/** The Info.plist identity keys a distributable macOS app must declare (present and non-empty). */
const REQUIRED_PLIST_KEYS = [
  'CFBundleIdentifier',
  'CFBundleShortVersionString',
  'CFBundleExecutable',
] as const

/**
 * Reverse-DNS shape for `CFBundleIdentifier` — at least two dot-separated labels of
 * alphanumerics / hyphen / underscore (e.g. `com.acme.app`). Deliberately lenient: Apple is strict
 * about the character set, but the defect worth catching is a bare word with no namespace.
 */
const REVERSE_DNS_BUNDLE_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/

/** Read `key` as a trimmed non-empty string, or `undefined` when absent / empty / non-string. */
function readPlistString(plist: Record<string, unknown>, key: string): string | undefined {
  const value = plist[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A CFBundleExecutable value is a file name, not a path. Reject traversal before joining. */
function isPlainFileName(value: string): boolean {
  return value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

/** A parsed plist root that is a dictionary (object) — the only shape with inspectable keys. */
function isPlistDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Verify the bundle's `Contents/Info.plist` declares the identity fields a distributable macOS app
 * needs, by converting it to JSON with `plutil -convert json` (which reads both XML and binary
 * plists, so no extra dependency). Confirms `CFBundleIdentifier`, `CFBundleShortVersionString`, and
 * `CFBundleExecutable` are present and non-empty, that the identifier is reverse-DNS, and that the
 * declared executable is a plain file name that actually exists under `Contents/MacOS/`.
 *
 * Classification: a clean parse with every field valid is `pass` (evidence = the bundle id +
 * version); a parsed plist that is missing fields, has a non-reverse-DNS id, or names a
 * non-existent executable is `fail` (a real packaging defect, with remediation); a non-zero
 * `plutil` exit (missing or unparseable plist) is `fail`; a spawn failure — `plutil` absent
 * (non-macOS) or a timeout — is `unknown`. `plutil` ships with the macOS base system, so on macOS
 * it is always present; only off-macOS does this report `unknown`.
 */
export async function checkInfoPlist(appPath: string, run: RunCommand): Promise<CheckResult> {
  const id = 'info-plist' as const
  const plistPath = path.join(appPath, 'Contents', 'Info.plist')
  const res = await run('plutil', ['-convert', 'json', '-o', '-', plistPath])
  if (res.spawnError !== undefined) {
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'unknown',
      detail: `plutil could not run (${res.spawnError}); Info.plist fields are only verifiable on macOS.`,
    }
  }
  if (!res.ok) {
    const out = res.stderr.trim() !== '' ? res.stderr : res.stdout
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'fail',
      detail: 'plutil could not parse Contents/Info.plist: the file is missing or malformed.',
      ...(out.trim() !== '' ? { evidence: firstLine(out) } : {}),
      next_actions: ['Repackage the app with a well-formed Contents/Info.plist.'],
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'unknown',
      detail: 'plutil exited cleanly but did not produce parseable JSON for Contents/Info.plist.',
    }
  }
  if (!isPlistDictionary(parsed)) {
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'fail',
      detail: 'Contents/Info.plist is not a property-list dictionary.',
      next_actions: ['Repackage the app with a Contents/Info.plist whose root is a dictionary.'],
    }
  }
  const plist = parsed

  const problems: string[] = []
  const missing = REQUIRED_PLIST_KEYS.filter((key) => readPlistString(plist, key) === undefined)
  if (missing.length > 0) problems.push(`missing or empty ${missing.join(', ')}`)

  const bundleId = readPlistString(plist, 'CFBundleIdentifier')
  if (bundleId !== undefined && !REVERSE_DNS_BUNDLE_ID.test(bundleId)) {
    problems.push(`CFBundleIdentifier "${bundleId}" is not a reverse-DNS identifier`)
  }

  const executable = readPlistString(plist, 'CFBundleExecutable')
  if (executable !== undefined) {
    if (!isPlainFileName(executable)) {
      problems.push(`CFBundleExecutable "${executable}" must be a file name, not a path`)
    } else if (!(await isFile(path.join(appPath, 'Contents', 'MacOS', executable)))) {
      problems.push(`CFBundleExecutable "${executable}" is not a file under Contents/MacOS/`)
    }
  }

  if (problems.length > 0) {
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'fail',
      detail: `Contents/Info.plist has problems: ${problems.join('; ')}.`,
      next_actions: [
        'Set a reverse-DNS CFBundleIdentifier, a CFBundleShortVersionString, and a CFBundleExecutable that names the binary under Contents/MacOS/.',
      ],
    }
  }

  const version = readPlistString(plist, 'CFBundleShortVersionString')
  const build = readPlistString(plist, 'CFBundleVersion')
  const name = readPlistString(plist, 'CFBundleName')
  const evidence = [
    bundleId,
    version !== undefined ? `v${version}` : undefined,
    build !== undefined ? `(build ${build})` : undefined,
    name !== undefined ? `"${name}"` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ')
  return {
    id,
    title: INFO_PLIST_TITLE,
    status: 'pass',
    detail:
      'Contents/Info.plist declares a reverse-DNS bundle id, a version, and an executable that exists.',
    ...(evidence !== '' ? { evidence } : {}),
  }
}

const SIGNING_TITLE = 'Code signing'

/** Best-effort signing authority from `codesign -dvvv` (printed on stderr), for `evidence`. */
async function readSigningIdentity(appPath: string, run: RunCommand): Promise<string | undefined> {
  const res = await run('codesign', ['-dvvv', appPath])
  return res.stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('Authority='))
}

/**
 * Verify the app's code signature with `codesign --verify --deep --strict`. A clean run is `pass`
 * (with the signing authority as evidence when readable); a non-zero exit is `fail` (signature
 * missing/invalid/broken seal); a spawn failure — `codesign` absent (non-macOS) or a timeout — is
 * `unknown`.
 *
 * The `pass` path makes a SECOND `codesign -dvvv` call for the signing authority, so a pass costs
 * up to 2× the command timeout; that read is best-effort — if it fails, the `pass` simply carries
 * no `evidence`.
 */
export async function checkCodeSigning(appPath: string, run: RunCommand): Promise<CheckResult> {
  const id = 'code-signing' as const
  const res = await run('codesign', ['--verify', '--deep', '--strict', appPath])
  if (res.spawnError !== undefined) {
    return {
      id,
      title: SIGNING_TITLE,
      status: 'unknown',
      detail: `codesign could not run (${res.spawnError}); code signing is only verifiable on macOS with the developer toolchain installed.`,
    }
  }
  if (res.ok) {
    const identity = await readSigningIdentity(appPath, run)
    return {
      id,
      title: SIGNING_TITLE,
      status: 'pass',
      detail: 'The app passed codesign --verify --deep --strict.',
      ...(identity !== undefined ? { evidence: identity } : {}),
    }
  }
  return {
    id,
    title: SIGNING_TITLE,
    status: 'fail',
    detail: 'codesign --verify failed: the signature is missing, invalid, or the seal is broken.',
    ...(res.stderr.trim() !== '' ? { evidence: firstLine(res.stderr) } : {}),
    next_actions: [
      'Sign the app with a valid Developer ID Application certificate (codesign --deep --options runtime).',
      'Re-run codesign --verify --deep --strict to confirm the seal.',
    ],
  }
}

const NOTARIZATION_TITLE = 'Notarization'

/**
 * Detect the "toolchain unavailable" outcome of `xcrun stapler validate`: xcrun itself ran (so it
 * is not a `spawnError`) but could not find the `stapler` utility, or the active developer
 * directory is invalid (a misconfigured `xcode-select`). That is MISSING evidence — an incomplete
 * developer toolchain → `unknown`, not a real "no stapled ticket" defect → `fail`. Both share a
 * non-zero exit, so they are told apart by the xcrun diagnostic text rather than the exit code.
 */
function isStaplerToolchainUnavailable(res: CommandResult): boolean {
  const output = `${res.stderr}\n${res.stdout}`.toLowerCase()
  return (
    output.includes('unable to find utility "stapler"') ||
    output.includes("unable to find utility 'stapler'") ||
    output.includes('invalid active developer path')
  )
}

/**
 * Best-effort notarization source from `spctl --assess --type execute --verbose` (printed on
 * stderr), for `evidence` on a pass — the `source=Notarized Developer ID` line corroborates that
 * the stapled ticket is Apple-issued.
 */
async function readNotarizationSource(
  appPath: string,
  run: RunCommand,
): Promise<string | undefined> {
  const res = await run('spctl', ['--assess', '--type', 'execute', '--verbose', appPath])
  return res.stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('source='))
}

/**
 * Verify a valid notarization ticket is STAPLED to the bundle via `xcrun stapler validate`. A clean
 * run is `pass` (with the spctl notarization source as evidence when readable); a non-zero exit is
 * `fail` (no/invalid stapled ticket); a spawn failure — `xcrun` absent (non-macOS) or a timeout —
 * is `unknown`.
 *
 * `stapler validate` is OFFLINE — it inspects the ticket embedded in the bundle, with no network
 * lookup — so a non-zero exit reliably means "no valid stapled ticket" (a real defect) and is
 * classified `fail`, never softened to `unknown`. The output stream varies by toolchain version, so
 * the verdict is driven purely by the exit code and `evidence` reads whichever stream is non-empty.
 *
 * The `pass` path makes a SECOND `spctl` call for the notarization source, so a pass costs up to 2×
 * the command timeout; that read is best-effort — if it fails, the `pass` simply carries no
 * `evidence`.
 */
export async function checkNotarization(appPath: string, run: RunCommand): Promise<CheckResult> {
  const id = 'notarization' as const
  const res = await run('xcrun', ['stapler', 'validate', appPath])
  if (res.spawnError !== undefined) {
    return {
      id,
      title: NOTARIZATION_TITLE,
      status: 'unknown',
      detail: `xcrun stapler could not run (${res.spawnError}); notarization is only verifiable on macOS with the developer toolchain installed.`,
    }
  }
  if (isStaplerToolchainUnavailable(res)) {
    return {
      id,
      title: NOTARIZATION_TITLE,
      status: 'unknown',
      detail:
        'xcrun ran, but stapler is unavailable or the active developer directory is invalid; notarization is only verifiable with a working macOS developer toolchain.',
      ...(res.stderr.trim() !== '' ? { evidence: firstLine(res.stderr) } : {}),
    }
  }
  if (res.ok) {
    const source = await readNotarizationSource(appPath, run)
    return {
      id,
      title: NOTARIZATION_TITLE,
      status: 'pass',
      detail: 'A valid notarization ticket is stapled to the app (xcrun stapler validate passed).',
      ...(source !== undefined ? { evidence: source } : {}),
    }
  }
  // stapler prints to stdout in some toolchain versions and stderr in others; read whichever is
  // non-empty so the evidence survives either.
  const failOutput = res.stderr.trim() !== '' ? res.stderr : res.stdout
  return {
    id,
    title: NOTARIZATION_TITLE,
    status: 'fail',
    detail:
      'No valid notarization ticket is stapled to the app (xcrun stapler validate failed): it was never notarized, or the ticket was not stapled into the bundle.',
    ...(failOutput.trim() !== '' ? { evidence: firstLine(failOutput) } : {}),
    next_actions: [
      'Notarize the app with the Apple notary service (xcrun notarytool submit --wait).',
      'Staple the issued ticket into the bundle (xcrun stapler staple) so it validates offline.',
      'Re-run xcrun stapler validate to confirm the ticket is attached.',
    ],
  }
}

const GATEKEEPER_TITLE = 'Gatekeeper assessment'

/**
 * Assess whether Gatekeeper will accept the app for execution via `spctl --assess --type execute`.
 * Acceptance is `pass`; rejection is `fail` (unsigned, not notarized, or untrusted); a spawn
 * failure — `spctl` absent (non-macOS) or a timeout — is `unknown`.
 */
export async function checkGatekeeper(appPath: string, run: RunCommand): Promise<CheckResult> {
  const id = 'gatekeeper' as const
  const res = await run('spctl', ['--assess', '--type', 'execute', '--verbose', appPath])
  if (res.spawnError !== undefined) {
    return {
      id,
      title: GATEKEEPER_TITLE,
      status: 'unknown',
      detail: `spctl could not run (${res.spawnError}); Gatekeeper assessment is only available on macOS.`,
    }
  }
  if (res.ok) {
    return {
      id,
      title: GATEKEEPER_TITLE,
      status: 'pass',
      detail: 'Gatekeeper accepts the app for execution (spctl --assess passed).',
    }
  }
  return {
    id,
    title: GATEKEEPER_TITLE,
    status: 'fail',
    detail:
      'Gatekeeper rejected the app (spctl --assess failed): it is unsigned, not notarized, or the signature is not trusted.',
    ...(res.stderr.trim() !== '' ? { evidence: firstLine(res.stderr) } : {}),
    next_actions: [
      'Notarize the app with the Apple notary service and staple the ticket (xcrun notarytool + stapler).',
      'Re-run spctl --assess --type execute to confirm acceptance.',
    ],
  }
}

/** Maps each id to its runner. Bundle ignores the command runner (pure filesystem). */
const RUNNERS: Readonly<
  Record<CheckId, (appPath: string, run: RunCommand) => Promise<CheckResult>>
> = {
  'bundle-structure': (appPath) => checkBundleStructure(appPath),
  'info-plist': (appPath, run) => checkInfoPlist(appPath, run),
  'code-signing': (appPath, run) => checkCodeSigning(appPath, run),
  notarization: (appPath, run) => checkNotarization(appPath, run),
  gatekeeper: (appPath, run) => checkGatekeeper(appPath, run),
}

/**
 * Run the selected checks (default: all) against `appPath`, always in the canonical
 * {@link CHECK_IDS} order regardless of the order requested, and deduped — so the result is
 * deterministic. Checks run sequentially; each is independent and self-classifying.
 */
export async function runChecks(
  appPath: string,
  run: RunCommand,
  ids: readonly CheckId[] = CHECK_IDS,
): Promise<readonly CheckResult[]> {
  const requested = new Set(ids)
  const results: CheckResult[] = []
  for (const id of CHECK_IDS) {
    if (requested.has(id)) results.push(await RUNNERS[id](appPath, run))
  }
  return results
}
