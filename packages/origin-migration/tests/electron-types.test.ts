import type { BrowserWindow, Session } from 'electron'
import { describe, expect, it } from 'vitest'

import type { SessionLike, WindowFactory } from '../src/index.js'

// Compile-time only: Electron's own classes must satisfy the structural types.
export function acceptsElectron(window: typeof BrowserWindow, session: Session) {
  const factory: WindowFactory = window
  const storage: SessionLike = session
  return { factory, storage }
}

describe('structural Electron types', () => {
  it("accept Electron's own BrowserWindow and Session", () => {
    expect(typeof acceptsElectron).toBe('function')
  })
})
