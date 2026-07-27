/**
 * Read-only Electron fuse inspection for launch compatibility.
 *
 * Playwright's Electron launcher always passes `--inspect=0` to establish its main-process
 * control channel. A packaged binary with `EnableNodeCliInspectArguments` disabled cannot
 * support that launch path. Inspection is best-effort: an unreadable/non-Electron/unknown
 * fuse wire returns `undefined` so a diagnostic helper never invents incompatibility.
 *
 * @module
 */

import { stat } from 'node:fs/promises'

import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
  pathToFuseFile,
} from '@electron/fuses'

/** Bounded states exposed to tools instead of raw fuse-wire bytes. */
export type ElectronFuseState = 'enabled' | 'disabled' | 'removed' | 'unknown'

/** Fuse facts relevant to Playwright Electron launch. */
export interface ElectronLaunchFuseInspection {
  readonly version: string
  readonly run_as_node: ElectronFuseState
  readonly node_cli_inspect_arguments: ElectronFuseState
  readonly blocks_playwright_launch: boolean
}

function readableState(value: FuseState | undefined): ElectronFuseState {
  switch (value) {
    case FuseState.ENABLE:
      return 'enabled'
    case FuseState.DISABLE:
      return 'disabled'
    case FuseState.REMOVED:
      return 'removed'
    default:
      return 'unknown'
  }
}

/** Convert a raw V1 fuse wire to the stable launch-diagnostic shape. */
export function describeElectronLaunchFuses(
  wire: Awaited<ReturnType<typeof getCurrentFuseWire>>,
): ElectronLaunchFuseInspection | undefined {
  if (wire.version !== FuseVersion.V1) return undefined
  const runAsNode = readableState(wire[FuseV1Options.RunAsNode])
  const nodeCliInspect = readableState(wire[FuseV1Options.EnableNodeCliInspectArguments])
  return {
    version: wire.version,
    run_as_node: runAsNode,
    node_cli_inspect_arguments: nodeCliInspect,
    blocks_playwright_launch: nodeCliInspect === 'disabled' || nodeCliInspect === 'removed',
  }
}

const inspectionCache = new Map<string, Promise<ElectronLaunchFuseInspection | undefined>>()
const MAX_CACHED_INSPECTIONS = 64

/**
 * Inspect an Electron binary or macOS app path once per server process. Failures are intentionally
 * converted to `undefined`: absence of positive evidence must never block a launch.
 */
export function inspectElectronLaunchFuses(
  executablePath: string,
): Promise<ElectronLaunchFuseInspection | undefined> {
  return stat(pathToFuseFile(executablePath))
    .then((metadata) => {
      // Fuses live in the Electron framework on macOS rather than the small app executable.
      // Keying by that actual file's identity avoids stale compatibility after an in-place rebuild.
      const cacheKey = `${executablePath}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`
      const cached = inspectionCache.get(cacheKey)
      if (cached !== undefined) return cached
      const inspection = getCurrentFuseWire(executablePath)
        .then(describeElectronLaunchFuses)
        .catch(() => undefined)
      if (inspectionCache.size >= MAX_CACHED_INSPECTIONS) {
        const oldest = inspectionCache.keys().next().value as string | undefined
        if (oldest !== undefined) inspectionCache.delete(oldest)
      }
      inspectionCache.set(cacheKey, inspection)
      return inspection
    })
    .catch(() => undefined)
}
