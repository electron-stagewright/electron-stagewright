/**
 * Launch-time native instrumentation (ADR-020) — unit tests for the shim builder and, above all, the
 * tray-hook body. The hook body is exported as a string so it can be run here via `new Function` against
 * a FAKE electron module (no real Electron): we patch a fake `Tray`, construct + configure trays, and
 * assert the registry the real shim would expose. The shim source's shape (the real-main import) is
 * checked directly; the real launch path is the gated real-Electron smoke.
 */

import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
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

describe('buildInstrumentationShim', () => {
  it('embeds the real main as a file URL and imports it after the hook', () => {
    const shim = buildInstrumentationShim('/abs/app/main.js')
    expect(shim).toContain(JSON.stringify(pathToFileURL('/abs/app/main.js').href))
    expect(shim).toContain(`import(`)
    expect(shim).toContain(TRAY_REGISTRY_GLOBAL)
    // The hook runs before the real main is imported.
    expect(shim.indexOf(TRAY_REGISTRY_GLOBAL)).toBeLessThan(shim.lastIndexOf('import('))
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
