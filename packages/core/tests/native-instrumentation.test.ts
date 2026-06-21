/**
 * Launch-time native instrumentation (ADR-020) — unit tests for the shim builder and the hook bodies (the
 * tray hook and the notification hook). Each hook body is exported as a string so it can be run here via
 * `new Function` against a FAKE electron module (no real Electron): we patch a fake `Tray` / `Notification`,
 * drive it, and assert the registry/buffer the real shim would expose. The shim source's shape (both hooks
 * before the real-main import) is checked directly; the real launch path is the gated real-Electron smoke.
 */

import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  NOTIFICATION_HOOK_BODY,
  NOTIFICATION_REGISTRY_GLOBAL,
  TRAY_HOOK_BODY,
  TRAY_REGISTRY_GLOBAL,
  buildInstrumentationShim,
} from '../src/transports/native-instrumentation.js'

/** Run the exported hook body against a fake electron + host, returning both for assertions. */
function installHook(): {
  electron: { Tray: unknown }
  host: Record<string, unknown>
  FakeTray: new (...args: unknown[]) => Record<string, unknown>
} {
  class FakeTray {
    [key: string]: unknown
    args: unknown[]
    constructor(...args: unknown[]) {
      this.args = args
    }
    setToolTip(_t: string): void {}
    setTitle(_t: string): void {}
    setImage(_i: unknown): void {}
    setContextMenu(_m: unknown): void {}
    destroy(): void {}
  }
  const electron: { Tray: unknown } = { Tray: FakeTray }
  const host: Record<string, unknown> = {}
  // TRAY_HOOK_BODY is a compile-time constant (no interpolation) — safe to run here.
  new Function('electron', 'host', TRAY_HOOK_BODY)(electron, host)
  return { electron, host, FakeTray }
}

function registry(host: Record<string, unknown>): Array<{ rec: Record<string, unknown> }> {
  return host[TRAY_REGISTRY_GLOBAL] as Array<{ rec: Record<string, unknown> }>
}

/** Run the notification hook body against a fake electron + host, returning both for assertions. */
function installNotificationHook(): {
  electron: { Notification: unknown }
  host: Record<string, unknown>
  FakeNotification: new (opts?: Record<string, unknown>) => { show: () => void }
  shown: string[]
} {
  const shown: string[] = []
  class FakeNotification {
    [key: string]: unknown
    constructor(opts?: Record<string, unknown>) {
      Object.assign(this, opts ?? {})
    }
    show(): void {
      shown.push(String((this as { title?: unknown }).title))
    }
  }
  const electron: { Notification: unknown } = { Notification: FakeNotification }
  const host: Record<string, unknown> = {}
  // NOTIFICATION_HOOK_BODY is a compile-time constant (no interpolation) — safe to run here.
  new Function('electron', 'host', NOTIFICATION_HOOK_BODY)(electron, host)
  return { electron, host, FakeNotification, shown }
}

function captureBuffer(host: Record<string, unknown>): Array<Record<string, unknown>> {
  return (
    (host[NOTIFICATION_REGISTRY_GLOBAL] as { buffer?: Array<Record<string, unknown>> }).buffer ?? []
  )
}

describe('buildInstrumentationShim', () => {
  it('embeds the real main as a file URL and imports it after BOTH hooks', () => {
    const shim = buildInstrumentationShim('/abs/app/main.js')
    expect(shim).toContain(JSON.stringify(pathToFileURL('/abs/app/main.js').href))
    expect(shim).toContain(`import(`)
    expect(shim).toContain(TRAY_REGISTRY_GLOBAL)
    expect(shim).toContain(NOTIFICATION_REGISTRY_GLOBAL)
    // Both hooks run before the real main is imported.
    expect(shim.indexOf(TRAY_REGISTRY_GLOBAL)).toBeLessThan(shim.lastIndexOf('import('))
    expect(shim.indexOf(NOTIFICATION_REGISTRY_GLOBAL)).toBeLessThan(shim.lastIndexOf('import('))
  })

  it('JSON-escapes the path into a string literal (no break-out)', () => {
    const shim = buildInstrumentationShim('/weird/" + evil + "/main.js')
    // The path is inside a JSON string literal; the raw injection sequence does not appear unescaped.
    expect(shim).toContain(JSON.stringify(pathToFileURL('/weird/" + evil + "/main.js').href))
  })
})

describe('TRAY_HOOK_BODY (run against a fake electron)', () => {
  it('records a tray with its tooltip, title, image, and serialized context menu', () => {
    const { electron, host } = installHook()
    const Tray = electron.Tray as new (...args: unknown[]) => Record<string, unknown>
    const tray = new Tray('/icon.png')
    ;(tray['setToolTip'] as (t: string) => void).call(tray, 'Status: OK')
    ;(tray['setTitle'] as (t: string) => void).call(tray, 'SW')
    ;(tray['setContextMenu'] as (m: unknown) => void).call(tray, {
      items: [
        { label: 'Open', type: 'normal', enabled: true },
        { type: 'separator' },
        { label: 'Quit', role: 'quit', type: 'normal', enabled: false },
      ],
    })

    expect(registry(host).map((e) => e.rec)).toEqual([
      {
        id: 0,
        hasImage: true,
        toolTip: 'Status: OK',
        title: 'SW',
        menu: {
          items: [
            { label: 'Open', type: 'normal', enabled: true, visible: true },
            { label: '', type: 'separator', enabled: true, visible: true },
            { label: 'Quit', role: 'quit', type: 'normal', enabled: false, visible: true },
          ],
        },
      },
    ])
  })

  it('records via a class reference captured BEFORE the hook ran (prototype patch)', () => {
    const { FakeTray, host } = installHook()
    // FakeTray is the original class reference (the app destructured it before the hook installed the
    // constructor wrapper). The prototype-setter patch still records its state.
    const tray = new FakeTray()
    ;(tray['setToolTip'] as (t: string) => void).call(tray, 'via original ref')
    expect(registry(host).map((e) => e.rec)).toEqual([
      { id: 0, hasImage: false, toolTip: 'via original ref' },
    ])
  })

  it('assigns increasing ids and an empty registry when no tray is created', () => {
    const { electron, host } = installHook()
    const Tray = electron.Tray as new (...args: unknown[]) => Record<string, unknown>
    expect(registry(host)).toEqual([])
    const a = new Tray()
    const b = new Tray('/b.png')
    ;(a['setToolTip'] as (t: string) => void).call(a, 'A')
    ;(b['setToolTip'] as (t: string) => void).call(b, 'B')
    expect(registry(host).map((e) => e.rec['id'])).toEqual([0, 1])
    expect(registry(host).map((e) => e.rec['toolTip'])).toEqual(['A', 'B'])
  })

  it('removes destroyed trays without reusing ids', () => {
    const { electron, host } = installHook()
    const Tray = electron.Tray as new (...args: unknown[]) => Record<string, unknown>
    const a = new Tray('/a.png')
    const b = new Tray('/b.png')
    ;(a['setToolTip'] as (t: string) => void).call(a, 'A')
    ;(b['setToolTip'] as (t: string) => void).call(b, 'B')
    ;(a['destroy'] as () => void).call(a)
    const c = new Tray('/c.png')
    ;(c['setToolTip'] as (t: string) => void).call(c, 'C')

    expect(registry(host).map((e) => e.rec)).toEqual([
      { id: 1, hasImage: true, toolTip: 'B' },
      { id: 2, hasImage: true, toolTip: 'C' },
    ])
  })

  it('is wire-serialisable (no functions or refs leak into the rec)', () => {
    const { electron, host } = installHook()
    const Tray = electron.Tray as new (...args: unknown[]) => Record<string, unknown>
    const tray = new Tray('/i.png')
    ;(tray['setToolTip'] as (t: string) => void).call(tray, 'T')
    const recs = registry(host).map((e) => e.rec)
    expect(JSON.parse(JSON.stringify(recs))).toEqual(recs)
  })
})

describe('NOTIFICATION_HOOK_BODY (run against a fake electron)', () => {
  it('records each shown notification (data fields + a monotonic _seq) and still runs the original show', () => {
    const { electron, host, shown } = installNotificationHook()
    const Notification = electron.Notification as new (opts?: Record<string, unknown>) => {
      show: () => void
    }
    new Notification({ title: 'Saved', body: 'All changes saved', silent: false }).show()
    new Notification({ title: 'Hi' }).show()
    expect(shown).toEqual(['Saved', 'Hi']) // the original show still fired

    const buffer = captureBuffer(host)
    expect(buffer).toHaveLength(2)
    expect(buffer[0]).toMatchObject({
      title: 'Saved',
      body: 'All changes saved',
      silent: false,
      _seq: 0,
    })
    expect(typeof buffer[0]?.['at']).toBe('number')
    expect(buffer[1]).toMatchObject({ title: 'Hi', _seq: 1 })
    expect(buffer[1]).not.toHaveProperty('body') // an absent field is omitted, not null
  })

  it('records via a reference captured BEFORE the hook ran (prototype patch)', () => {
    const { FakeNotification, host } = installNotificationHook()
    // Simulate `const { Notification } = require('electron')` at app import — a reference taken before the
    // hook installed. A prototype patch (not a constructor swap) still catches its `.show()`.
    const Destructured = FakeNotification
    new Destructured({ title: 'ViaRef' }).show()
    expect(captureBuffer(host).map((r) => r['title'])).toEqual(['ViaRef'])
  })

  it('is idempotent — a second install is a no-op (never resets the buffer)', () => {
    const { electron, host } = installNotificationHook()
    const Notification = electron.Notification as new (opts?: Record<string, unknown>) => {
      show: () => void
    }
    new Notification({ title: 'First' }).show()
    // Re-running the hook against the same host (e.g. the shim then a redundant install) must no-op.
    new Function('electron', 'host', NOTIFICATION_HOOK_BODY)(electron, host)
    new Notification({ title: 'Second' }).show()
    expect(captureBuffer(host).map((r) => r['title'])).toEqual(['First', 'Second'])
  })

  it('bounds the buffer at the cap, dropping the oldest', () => {
    const { electron, host } = installNotificationHook()
    const Notification = electron.Notification as new (opts?: Record<string, unknown>) => {
      show: () => void
    }
    const CAP = 1000
    for (let i = 0; i < CAP + 5; i += 1) new Notification({ title: `n${i}` }).show()
    const buffer = captureBuffer(host)
    expect(buffer).toHaveLength(CAP)
    expect(buffer[0]?.['title']).toBe('n5') // the 5 oldest were dropped
    expect(buffer[buffer.length - 1]?.['title']).toBe(`n${CAP + 4}`)
  })
})
