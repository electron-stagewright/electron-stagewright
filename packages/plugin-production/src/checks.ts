/**
 * Production-readiness checks for a packaged macOS app (ADR-012).
 *
 * Each check returns a {@link CheckResult} whose `status` encodes the load-bearing distinction the
 * acceptance criteria demand: `pass` (verified good), `fail` (verified bad — a real packaging or
 * signing defect), and `unknown` (could not be determined — a required CLI is absent, a file is
 * missing, or the host is not macOS; i.e. MISSING evidence, not a failure). The shell-out checks
 * derive `unknown` from the command runner's `spawnError` rather than a platform branch, so on a
 * non-macOS host the tools are simply absent (`unknown`) and tests can drive every branch through
 * a fake {@link RunCommand}.
 *
 * @module
 */

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { RunCommand } from './command.js'

/** Outcome class of a check: verified good, verified bad, or could-not-determine. */
export type CheckStatus = 'pass' | 'fail' | 'unknown'

/**
 * The result of one production-readiness check.
 *
 * - `status` — `pass` (verified good), `fail` (verified bad: a real defect), or `unknown` (missing
 *   evidence — a CLI absent, a file missing, or a non-macOS host; never conflate with `fail`).
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

/** The checks this plugin runs, in a stable display order. Doubles as the `checks` argument enum. */
export const CHECK_IDS = ['bundle-structure', 'code-signing', 'gatekeeper'] as const

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
 * fixture-testable. (Field-level Info.plist checks — bundle id, version — need a plist parser and
 * are deferred.) A missing piece is a `fail` (the bundle is broken); an unreadable path is
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
  'code-signing': (appPath, run) => checkCodeSigning(appPath, run),
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
