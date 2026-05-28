/**
 * Best-effort code-signature inspection for a launched Electron app.
 *
 * macOS is the only platform with a first-class verifier wired here (`codesign`).
 * On every other platform this reports `unsupported` rather than guessing.
 * Cross-platform signature/notarization coverage belongs in platform-specific
 * tooling, not this best-effort helper.
 *
 * ## Security
 *
 * The verifier shells out with {@link import('node:child_process').execFile} and
 * an **argument array**, never a shell string. A crafted executable path (e.g.
 * one containing `; rm -rf …`) is passed as a single argv entry and cannot inject
 * shell commands. The call is also time-bounded so a hung `codesign` cannot wedge
 * a tool dispatch.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Outcome of a signature check. */
export type SignatureStatus =
  /** A valid signature was verified. */
  | 'signed'
  /** No signature, or the signature failed verification. */
  | 'unsigned'
  /** The platform has no signature verifier wired (everything but macOS today). */
  | 'unsupported'
  /** There was nothing to check (e.g. no executable path was available). */
  | 'unknown'

/** Result of {@link inspectSignature}. */
export interface SignatureInfo {
  readonly status: SignatureStatus
  /** Human-readable detail (e.g. the verifier's stderr), when available. */
  readonly detail?: string
}

/**
 * A signature verifier: resolves when the target is validly signed, rejects
 * otherwise. The rejection may carry a `stderr` string. Injectable so tests
 * exercise the darwin branch without spawning a real `codesign`.
 */
export type SignatureVerifier = (file: string, args: readonly string[]) => Promise<void>

const defaultVerifier: SignatureVerifier = async (file, args) => {
  await execFileAsync(file, [...args], { timeout: 5000 })
}

/** Options for {@link inspectSignature}. */
export interface InspectSignatureOptions {
  /** Platform to branch on. Defaults to the host platform. */
  readonly platform?: NodeJS.Platform
  /** Verifier injection for tests. Defaults to a real `codesign` invocation. */
  readonly verify?: SignatureVerifier
}

/**
 * Inspect the code signature of the binary at `targetPath`. Never throws — a
 * failed verification, an unsupported platform, or a missing path each map to a
 * {@link SignatureInfo} status.
 */
export async function inspectSignature(
  targetPath: string,
  opts: InspectSignatureOptions = {},
): Promise<SignatureInfo> {
  const platform = opts.platform ?? process.platform
  if (platform !== 'darwin') {
    return {
      status: 'unsupported',
      detail: 'Signature verification is implemented on macOS only.',
    }
  }
  if (targetPath === '') {
    return { status: 'unknown', detail: 'No executable path available to verify.' }
  }
  const verify = opts.verify ?? defaultVerifier
  try {
    await verify('codesign', ['-v', '--verbose=2', targetPath])
    return { status: 'signed' }
  } catch (err) {
    const stderr = (err as { readonly stderr?: unknown }).stderr
    const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : undefined
    return { status: 'unsigned', ...(detail !== undefined ? { detail } : {}) }
  }
}
