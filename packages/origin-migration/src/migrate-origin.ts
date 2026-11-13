import type { Session } from 'electron'

import { runOriginMigration, type OriginMigrationResult, type OriginStore } from './migration.js'
import { openLegacyOriginPage, openTargetOriginPage, type WindowFactory } from './pages.js'

export interface MigrateOriginOptions {
  /** `app.getPath('userData')`; the marker lives here. */
  userDataDir: string
  /** Electron's `BrowserWindow`, used for two hidden, sandboxed pages. */
  BrowserWindow: WindowFactory
  /** The session whose storage moves, usually `session.defaultSession`. */
  session: Session
  /** An empty document on the new origin, served by the app's protocol handler. */
  targetUrl: string
  /** Default both. */
  stores?: readonly OriginStore[]
  /** A file name inside `userDataDir`. Default `origin-migration.json`. */
  markerFile?: string
  /** Bounds each page load and page step. Default 30 s. */
  stepTimeoutMs?: number
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/**
 * Copies localStorage and the origin private file system from `file://` to the origin of
 * `targetUrl`, once. Resolves with the outcome; an attempt that fails is retried on later
 * launches, up to three attempts in all.
 */
export async function migrateOrigin(options: MigrateOriginOptions): Promise<OriginMigrationResult> {
  if (new URL(options.targetUrl).protocol === 'file:') {
    throw new TypeError('targetUrl must be on the new origin, not file://')
  }
  const pageOptions = {
    session: options.session,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stepTimeoutMs ? { stepTimeoutMs: options.stepTimeoutMs } : {}),
  }
  return runOriginMigration({
    userDataDir: options.userDataDir,
    openLegacy: () => openLegacyOriginPage(options.BrowserWindow, pageOptions),
    openTarget: () => openTargetOriginPage(options.BrowserWindow, options.targetUrl, pageOptions),
    flush: () => options.session.flushStorageData(),
    ...(options.markerFile ? { markerFile: options.markerFile } : {}),
    ...(options.stores ? { stores: options.stores } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}
