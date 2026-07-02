/**
 * `--app-root` path confinement shared by every tool that reads or executes a
 * host path from agent-supplied arguments (`electron_launch`, `electron_set_files`,
 * `electron_drop_file`).
 *
 * When the operator starts the server with `--app-root`, host access is meant to be
 * confined to that directory. Launch enforces it for `main` / `executablePath` / `cwd`
 * (code execution); the file-reading interaction tools enforce it here for the paths
 * whose BYTES flow into the app under test — otherwise a tool call could read a file
 * outside the intended root (e.g. `~/.ssh/id_rsa`) and surface it to a cooperating
 * page. Without `--app-root`, paths are unconstrained (the documented default).
 *
 * @module
 */

import { isAbsolute, relative, resolve } from 'node:path'

import { StagewrightError } from '../errors/registry.js'

/** Whether `candidate` resolves inside `root` — blocks `..` escape out of an `--app-root` confinement. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Throw `BAD_ARGUMENT` when any of `paths` escapes the configured `--app-root`.
 * A no-op when `appRoot` is `undefined` (no confinement configured).
 */
export function assertPathsWithinAppRoot(
  appRoot: string | undefined,
  paths: readonly string[],
): void {
  if (appRoot === undefined) return
  for (const candidate of paths) {
    if (!isWithinRoot(appRoot, candidate)) {
      throw new StagewrightError(
        'BAD_ARGUMENT',
        `File path must resolve within the configured --app-root (${appRoot}); "${candidate}" is outside it.`,
        { app_root: appRoot, path: candidate },
      )
    }
  }
}
