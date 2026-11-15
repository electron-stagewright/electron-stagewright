/**
 * Ends a launched app together with every process it started. Chromium's GPU, renderer, utility
 * and crashpad children otherwise outlive a main process killed on its own.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * Kills `pid` and its descendants. Resolves whether anything was signalled. `exited` says the main
 * process is already gone, so its pid may belong to someone else now: only a POSIX group kill is
 * still safe (a live group id is never reused).
 */
export type KillProcessTree = (
  pid: number,
  opts?: { readonly exited?: boolean },
) => Promise<boolean>

export interface ProcessTreeDeps {
  readonly platform?: NodeJS.Platform
  /** `process.kill`; a negative pid targets the process group. */
  readonly kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  /** Runs `taskkill` and resolves its exit code. */
  readonly taskkill?: (args: readonly string[]) => Promise<number | null>
  /** How long to wait for a POSIX process group to empty. */
  readonly settleMs?: number
}

const TASKKILL_TIMEOUT_MS = 5_000
const GROUP_SETTLE_MS = 2_000
const GROUP_POLL_MS = 25

function runTaskkill(args: readonly string[]): Promise<number | null> {
  return new Promise((resolve) => {
    // By full path: a bare name would also search the working directory first.
    const exe = path.win32.join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'taskkill.exe',
    )
    const child = spawn(exe, [...args], { shell: false, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, TASKKILL_TIMEOUT_MS)
    timer.unref()
    child.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

function signal(kill: NonNullable<ProcessTreeDeps['kill']>, pid: number): boolean {
  try {
    kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

/** True while any process of the group led by `pid` is alive. */
function groupAlive(kill: NonNullable<ProcessTreeDeps['kill']>, pid: number): boolean {
  try {
    kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Windows: `taskkill /T /F` walks the tree by parent pid, so it must run while `pid` is alive.
 * POSIX: SIGKILL to the process group `pid` leads (the app must be spawned `detached`), then wait
 * for the group to empty; a pid that leads no group is killed alone.
 */
export function createKillProcessTree(deps: ProcessTreeDeps = {}): KillProcessTree {
  const platform = deps.platform ?? process.platform
  const kill = deps.kill ?? ((pid, sig) => void process.kill(pid, sig))
  const taskkill = deps.taskkill ?? runTaskkill
  const settleMs = deps.settleMs ?? GROUP_SETTLE_MS
  return async (pid, opts = {}) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    if (platform === 'win32') {
      if (opts.exited === true) return false
      if ((await taskkill(['/pid', String(pid), '/T', '/F'])) === 0) return true
      return signal(kill, pid)
    }
    if (!signal(kill, -pid)) return opts.exited === true ? false : signal(kill, pid)
    const until = Date.now() + settleMs
    while (groupAlive(kill, pid) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS))
    }
    return true
  }
}

export const killProcessTree: KillProcessTree = createKillProcessTree()

/** For a fake process from a test seam: signals nothing, so callers fall back to their own kill. */
export const noProcessTree: KillProcessTree = () => Promise.resolve(false)
