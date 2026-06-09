/**
 * Bounded external-command runner for production checks (ADR-012).
 *
 * The validation checks shell out to platform tools (`codesign`, `spctl`). Per the
 * bound-every-spawn invariant, each run carries a timeout so a hung tool cannot wedge the
 * dispatch, and the runner NEVER rejects — it always resolves a {@link CommandResult} classifying
 * the outcome (clean exit, non-zero exit, command-not-found, or timeout). A missing command or a
 * non-macOS host therefore surfaces as `spawnError`, which the checks map to an `unknown` status
 * (missing evidence) rather than a failure.
 *
 * @module
 */

import { execFile } from 'node:child_process'

/**
 * Outcome of running an external command. `code` is the numeric exit code on a clean spawn (0 on
 * success, non-zero on failure), or `null` when the process never produced an exit code (the spawn
 * failed or was killed). `spawnError` is set ONLY when the command could not run to completion —
 * it was not found (`command not found`) or exceeded the timeout — which the checks treat as
 * missing evidence (`unknown`), distinct from a command that ran and exited non-zero (a real
 * failure).
 */
export interface CommandResult {
  readonly ok: boolean
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly spawnError?: string
}

/** Runs an external command and resolves a {@link CommandResult}. Injected so tests can fake it. */
export type RunCommand = (command: string, args: readonly string[]) => Promise<CommandResult>

/**
 * Build a {@link RunCommand} backed by `execFile`, bounded by `timeoutMs`. Output is capped
 * (`maxBuffer`) so a chatty tool cannot exhaust memory. The returned function never rejects.
 */
export function makeRunCommand(timeoutMs: number): RunCommand {
  return (command, args) =>
    new Promise<CommandResult>((resolve) => {
      execFile(
        command,
        [...args],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ ok: true, code: 0, stdout, stderr })
            return
          }
          const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
          // ENOENT: the command is not installed (e.g. codesign on a non-macOS host).
          if (err.code === 'ENOENT') {
            resolve({ ok: false, code: null, stdout, stderr, spawnError: 'command not found' })
            return
          }
          // killed: execFile terminated it for exceeding the timeout.
          if (err.killed === true) {
            resolve({
              ok: false,
              code: null,
              stdout,
              stderr,
              spawnError: `timed out after ${timeoutMs}ms`,
            })
            return
          }
          // A numeric err.code is a process that ran and exited non-zero. Any other spawn-level
          // failure (EACCES, ENOTDIR, …) has a string err.code, so exitCode stays null and the
          // outcome falls through to spawnError below — surfaced by the checks as `unknown`.
          const exitCode = typeof err.code === 'number' ? err.code : null
          resolve({
            ok: false,
            code: exitCode,
            stdout,
            stderr,
            ...(exitCode === null ? { spawnError: err.message } : {}),
          })
        },
      )
    })
}
