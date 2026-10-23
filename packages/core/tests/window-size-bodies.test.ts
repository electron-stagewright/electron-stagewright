/**
 * Unit tests for the window-size bodies: the main-process body against a fake BrowserWindow whose
 * window manager answers asynchronously, and the renderer body against a page that reports the
 * requested size before the browser applies the real one.
 */

import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { RENDERER_RESIZE_BODY, RESIZE_BY_ID_BODY } from '../src/transports/window-size.js'
import type { WindowSizeResult } from '../src/transports/index.js'

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max > 0 ? max : Infinity)

/** A BrowserWindow whose state changes land after a delay, like a Linux window manager. */
class FakeWindow extends EventEmitter {
  size: [number, number] = [800, 600]
  readonly frame: [number, number] = [0, 28]
  minimum: [number, number] = [0, 0]
  maximum: [number, number] = [0, 0]
  maximized = false
  fullscreen = false
  kiosk = false
  /** When false, leaving fullscreen never reports back. */
  emitsLeave = true
  readonly calls: string[] = []

  isKiosk() {
    return this.kiosk
  }
  setKiosk(value: boolean) {
    this.calls.push('setKiosk')
    this.kiosk = value
  }
  isFullScreen() {
    return this.fullscreen
  }
  setFullScreen(value: boolean) {
    this.calls.push('setFullScreen')
    setTimeout(() => {
      this.fullscreen = value
      if (this.emitsLeave) this.emit('leave-full-screen')
    }, 20)
  }
  isSimpleFullScreen() {
    return false
  }
  isMaximized() {
    return this.maximized
  }
  unmaximize() {
    this.calls.push('unmaximize')
    // The restore lands later and puts back the pre-maximize size.
    setTimeout(() => {
      this.maximized = false
      this.size = [1024, 768]
      this.emit('unmaximize')
    }, 30)
  }
  getSize() {
    return [...this.size]
  }
  getContentSize() {
    return [this.size[0] - this.frame[0], this.size[1] - this.frame[1]]
  }
  getMinimumSize() {
    return [...this.minimum]
  }
  getMaximumSize() {
    return [...this.maximum]
  }
  setSize(width: number, height: number) {
    this.calls.push('setSize')
    this.size = [
      clamp(width, this.minimum[0], this.maximum[0]),
      clamp(height, this.minimum[1], this.maximum[1]),
    ]
  }
  setContentSize(width: number, height: number) {
    this.calls.push('setContentSize')
    this.setSize(width + this.frame[0], height + this.frame[1])
    this.calls.pop()
  }
}

function runMain(win: FakeWindow | null, request: object): Promise<WindowSizeResult | null> {
  const electronApp = { BrowserWindow: { fromId: () => win } }
  return new Function('electronApp', 'arg', `return (async () => {\n${RESIZE_BY_ID_BODY}\n})()`)(
    electronApp,
    { windowId: '1', request },
  ) as Promise<WindowSizeResult | null>
}

describe('main-process resize body', () => {
  it('sets the outer size and maps unset limits to null', async () => {
    const win = new FakeWindow()
    await expect(runMain(win, { width: 640, height: 480 })).resolves.toEqual({
      outer: { width: 640, height: 480 },
      content: { width: 640, height: 452 },
      minimum: null,
      maximum: null,
      method: 'browser_window',
    })
    expect(win.calls).toEqual(['setSize'])
  })

  it('sets the content size, and reports the clamp with the limits', async () => {
    const win = new FakeWindow()
    win.minimum = [0, 450]
    await expect(runMain(win, { width: 600, height: 300, content: true })).resolves.toMatchObject({
      outer: { width: 600, height: 450 },
      content: { width: 600, height: 422 },
      minimum: { width: 0, height: 450 },
    })
    expect(win.calls).toEqual(['setContentSize'])
  })

  it('resizes a maximized window only after the restore landed', async () => {
    const win = new FakeWindow()
    win.maximized = true
    await expect(runMain(win, { width: 700, height: 500 })).resolves.toMatchObject({
      outer: { width: 700, height: 500 },
      restored_from: 'maximized',
    })
    expect(win.calls).toEqual(['unmaximize', 'setSize'])
    expect(win.listenerCount('unmaximize')).toBe(0)
    // Nothing lands afterwards to undo the new size.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(win.size).toEqual([700, 500])
  })

  it('leaves kiosk and fullscreen first and reports the outermost state', async () => {
    const win = new FakeWindow()
    win.kiosk = true
    win.fullscreen = true
    await expect(runMain(win, { width: 700, height: 500 })).resolves.toMatchObject({
      outer: { width: 700, height: 500 },
      restored_from: 'kiosk',
    })
    expect(win.calls).toEqual(['setKiosk', 'setFullScreen', 'setSize'])
    expect(win.listenerCount('leave-full-screen')).toBe(0)
  })

  it('stops waiting for a fullscreen exit that never reports back', async () => {
    const win = new FakeWindow()
    win.fullscreen = true
    win.emitsLeave = false
    await expect(runMain(win, { width: 700, height: 500 })).resolves.toMatchObject({
      restored_from: 'fullscreen',
    })
    expect(win.listenerCount('leave-full-screen')).toBe(0)
  }, 5_000)

  it('answers null for a window that does not exist', async () => {
    await expect(runMain(null, { width: 700, height: 500 })).resolves.toBeNull()
  })
})

/**
 * A page like Blink's: the outer size reads as requested at once and stays so for a while, while
 * the real (clamped) inner size lands with the resize event.
 */
function page(minHeight: number) {
  const listeners = new Set<() => void>()
  const scope = {
    outerWidth: 480,
    outerHeight: 320,
    innerWidth: 480,
    innerHeight: 292,
    arg: {},
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    resizeTo(width: number, height: number) {
      scope.outerWidth = width
      scope.outerHeight = height
      const real = Math.max(height, minHeight)
      setTimeout(() => {
        scope.innerWidth = width
        scope.innerHeight = real - 28
        for (const listener of [...listeners]) listener()
      }, 200)
      setTimeout(() => {
        scope.outerHeight = real
      }, 2000)
    },
    window: undefined as unknown,
    globalThis: undefined as unknown,
  }
  scope.window = scope
  scope.globalThis = scope
  return { scope, listeners }
}

function runRenderer(scope: object, request: object): Promise<WindowSizeResult> {
  Object.assign(scope, { arg: { request } })
  return new Function(
    'scope',
    `with (scope) { return (async () => {\n${RENDERER_RESIZE_BODY}\n})() }`,
  )(scope) as Promise<WindowSizeResult>
}

describe('renderer resize body', () => {
  it('reads the size back only once the browser applied it', async () => {
    const { scope, listeners } = page(450)
    await expect(runRenderer(scope, { width: 640, height: 300 })).resolves.toMatchObject({
      outer: { width: 640, height: 450 },
      content: { width: 640, height: 422 },
      minimum: null,
      method: 'renderer',
    })
    expect(listeners.size).toBe(0)
  })

  it('keeps the frame of the first resize while the outer size is stale', async () => {
    const { scope } = page(450)
    await runRenderer(scope, { width: 640, height: 300 })
    // The outer height still reads 300 here; the next resize must not measure the frame from it.
    await expect(runRenderer(scope, { width: 640, height: 520 })).resolves.toMatchObject({
      outer: { width: 640, height: 520 },
      content: { width: 640, height: 492 },
    })
  })

  it('adds the frame for a content request', async () => {
    const { scope } = page(0)
    await expect(
      runRenderer(scope, { width: 600, height: 400, content: true }),
    ).resolves.toMatchObject({
      outer: { width: 600, height: 428 },
      content: { width: 600, height: 400 },
    })
  })

  it('does not wait for a resize that changes nothing', async () => {
    const { scope } = page(0)
    const started = Date.now()
    await runRenderer(scope, { width: 480, height: 320 })
    expect(Date.now() - started).toBeLessThan(150)
  })
})
