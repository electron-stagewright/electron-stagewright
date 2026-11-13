import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron'

import { BLANK_DOCUMENT_HTML } from './blank.js'
import type { LegacyOriginReader, TargetOriginWriter } from './migration.js'
import {
  ABORT_FILE,
  BEGIN_FILE,
  call,
  COMMIT_FILE,
  END_FILE,
  FILE_SIZE,
  LIST_FILES,
  READ_CHUNK,
  READ_LOCAL_STORAGE,
  REMOVE_FILE,
  WRITE_CHUNK,
  WRITE_LOCAL_STORAGE,
} from './scripts.js'

/** Bounds each page load and script; a stalled step fails the attempt instead of the launch. */
export const ORIGIN_PAGE_STEP_TIMEOUT_MS = 30_000

export type WindowFactory = new (options: BrowserWindowConstructorOptions) => BrowserWindow

export interface OriginPageOptions {
  /** The session whose storage moves. Default: Electron's default session. */
  session?: Session
  signal?: AbortSignal
  stepTimeoutMs?: number
}

interface StoragePage {
  evaluate: <T>(script: string) => Promise<T>
  /** Bounded by the step timeout only: a move or cleanup already sent finishes after an abort. */
  evaluateToEnd: <T>(script: string) => Promise<T>
  close: () => void
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (reason: unknown) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(reason)
    }
    const onAbort = () => fail(signal?.reason)
    const timer = setTimeout(
      () =>
        fail(Object.assign(new Error('Origin migration step timed out'), { code: 'ETIMEDOUT' })),
      timeoutMs,
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    promise.then((value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }, fail)
  })
}

async function openStoragePage(
  Window: WindowFactory,
  load: (window: BrowserWindow) => Promise<void>,
  cleanup: () => void,
  options: OriginPageOptions,
): Promise<StoragePage> {
  const timeoutMs = options.stepTimeoutMs ?? ORIGIN_PAGE_STEP_TIMEOUT_MS
  const window = new Window({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      ...(options.session ? { session: options.session } : {}),
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  const close = () => {
    if (!window.isDestroyed()) window.destroy()
    cleanup()
  }
  try {
    await withTimeout(load(window), timeoutMs, options.signal)
  } catch (error) {
    close()
    throw error
  }
  return {
    evaluate: <T>(script: string) => runSettled<T>(window, script, timeoutMs, options.signal),
    evaluateToEnd: <T>(script: string) => runSettled<T>(window, script, timeoutMs),
    close,
  }
}

type SettledStep<T> = { value: T } | { name: string }

async function runSettled<T>(
  window: BrowserWindow,
  script: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const result = await withTimeout(
    window.webContents.executeJavaScript(settled(script)) as Promise<SettledStep<T>>,
    timeoutMs,
    signal,
  )
  if ('value' in result) return result.value
  throw Object.assign(new Error('Origin page step failed'), { name: result.name })
}

// executeJavaScript rejects with neither name nor message, so the page reports the error name.
function settled(script: string): string {
  return `(async () => { try { return { value: await (${script}) }; } catch (error) { return { name: String((error && error.name) || 'Error') }; } })()`
}

/** Reads the file:// origin through an empty page written to a private temp folder. */
export async function openLegacyOriginPage(
  Window: WindowFactory,
  options: OriginPageOptions = {},
): Promise<LegacyOriginReader> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'origin-migration-'))
  const document = path.join(folder, 'blank.html')
  const removeFolder = () => void rm(folder, { recursive: true, force: true }).catch(() => {})
  try {
    await writeFile(document, BLANK_DOCUMENT_HTML)
  } catch (error) {
    removeFolder()
    throw error
  }
  const page = await openStoragePage(Window, (w) => w.loadFile(document), removeFolder, options)
  return {
    readLocalStorage: () => page.evaluate(READ_LOCAL_STORAGE),
    listFiles: () => page.evaluate(LIST_FILES),
    readChunk: (filePath, offset, length) =>
      page.evaluate(call(READ_CHUNK, filePath, offset, length)),
    close: page.close,
  }
}

/** Writes the new origin through `blankUrl`, an empty document the app's handler serves. */
export async function openTargetOriginPage(
  Window: WindowFactory,
  blankUrl: string,
  options: OriginPageOptions = {},
): Promise<TargetOriginWriter> {
  const page = await openStoragePage(
    Window,
    (w) => w.loadURL(blankUrl),
    () => {},
    options,
  )
  return {
    writeLocalStorage: (entries) => page.evaluate(call(WRITE_LOCAL_STORAGE, entries)),
    fileSize: (filePath) => page.evaluate(call(FILE_SIZE, filePath)),
    beginFile: (filePath) => page.evaluate(call(BEGIN_FILE, filePath)),
    writeChunk: (bytes) =>
      page.evaluate(
        call(
          WRITE_CHUNK,
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
        ),
      ),
    endFile: () => page.evaluate(END_FILE),
    abortFile: () => page.evaluate(ABORT_FILE),
    commitFile: (filePath, name) => page.evaluateToEnd(call(COMMIT_FILE, filePath, name)),
    removeFile: (filePath) => page.evaluateToEnd(call(REMOVE_FILE, filePath)),
    close: page.close,
  }
}
