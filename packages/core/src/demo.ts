/** Resolve the optional packaged demo used by the CLI's `--demo` mode. */

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const DEMO_MANIFEST_SPECIFIER = '@electron-stagewright/demo/manifest'

/** Narrow loading seam so the failure modes stay unit-testable without package installation. */
export interface DemoResolverDeps {
  readonly loadManifest?: () => Promise<unknown>
  readonly fileExists?: (path: string) => boolean
}

function defaultLoadManifest(): Promise<unknown> {
  // Keep the specifier indirect: core must not acquire a compile-time or runtime dependency on the
  // demo package. Node resolves it only when the operator explicitly selected `--demo`.
  return import(DEMO_MANIFEST_SPECIFIER)
}

/** Resolve and validate the demo's Electron main entry before the stdio server starts. */
export async function resolveDemoMain(deps: DemoResolverDeps = {}): Promise<string> {
  const loadManifest = deps.loadManifest ?? defaultLoadManifest
  const fileExists = deps.fileExists ?? existsSync
  let manifest: unknown
  try {
    manifest = await loadManifest()
  } catch (cause) {
    const detail = cause instanceof Error ? ` (${cause.message})` : ''
    throw new Error(
      `--demo requires @electron-stagewright/demo beside @electron-stagewright/core. Install the demo package and Electron, then retry.${detail}`,
    )
  }

  const demoMain =
    manifest !== null && typeof manifest === 'object'
      ? (manifest as Record<string, unknown>)['demoMain']
      : undefined
  if (typeof demoMain !== 'string' || !isAbsolute(demoMain)) {
    throw new Error(
      '@electron-stagewright/demo has an invalid manifest: demoMain must be an absolute path.',
    )
  }
  if (!fileExists(demoMain)) {
    throw new Error(
      `@electron-stagewright/demo is incomplete: its Electron entry does not exist (${demoMain}). Reinstall the package.`,
    )
  }
  return demoMain
}
