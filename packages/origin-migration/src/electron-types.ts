/**
 * The parts of Electron this package uses. Declared here so that installing the package never
 * pulls Electron into a consumer's production dependency graph; Electron's own classes satisfy them.
 */

export interface SessionLike {
  flushStorageData(): void
}

export interface StorageWindowOptions {
  show?: boolean
  webPreferences?: {
    sandbox?: boolean
    contextIsolation?: boolean
    nodeIntegration?: boolean
    webSecurity?: boolean
    spellcheck?: boolean
    backgroundThrottling?: boolean
    session?: SessionLike
  }
}

export interface StorageWindow {
  readonly webContents: {
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }) => void): unknown
    on(event: 'will-redirect', listener: (event: { preventDefault(): void }) => void): unknown
    executeJavaScript(code: string): Promise<unknown>
  }
  loadFile(filePath: string): Promise<void>
  loadURL(url: string): Promise<void>
  isDestroyed(): boolean
  destroy(): void
}
