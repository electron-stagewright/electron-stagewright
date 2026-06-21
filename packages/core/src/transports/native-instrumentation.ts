/**
 * Launch-time native instrumentation (ADR-020) — the shim-main mechanism for the Playwright transport.
 *
 * Electron keeps no registry of `Tray` instances and a tray is configured at app startup, so a hook
 * armed AFTER launch (the notification model) would miss it. To read tray state the hook must be in place
 * BEFORE the app's own main runs. When a session opts in (`LaunchOptions.instrumentNative`), the transport
 * launches a generated SHIM main (a `.cjs` written to a temp file) as `args[0]` instead of the app's real
 * main. The shim:
 *
 *   1. synchronously runs {@link TRAY_HOOK_BODY} against `require('electron')`, patching `Tray`
 *      (constructor wrap + prototype-setter patches + destroy cleanup) into a registry on
 *      `globalThis.__stagewright_trayRegistry`, then
 *   2. `import()`s the app's real main (which handles BOTH a CommonJS and an ESM main).
 *
 * Because (1) runs before (2), the real main's `require('electron').Tray` resolves to the patched class
 * even if the app destructures `const { Tray } = require('electron')` at import. The shim is fixed,
 * transport-owned code — it runs NO agent-supplied JavaScript. The hook logic is authored as a
 * self-contained source STRING ({@link TRAY_HOOK_BODY}) with no outer-scope refs, so it has no
 * dependencies to drop (the B5 concern that forces the renderer walker to be bundled does not apply), and
 * the SAME string is embedded in the shim AND unit-tested directly via `new Function`.
 *
 * @module
 */

import { pathToFileURL } from 'node:url'

/** The registry key the hook populates and {@link PlaywrightSession.getTrays} reads. */
export const TRAY_REGISTRY_GLOBAL = '__stagewright_trayRegistry'

/**
 * The tray-hook installer body. Given `electron` (the module) and `host` (the object to hang the registry
 * on — `globalThis` at runtime), it patches `electron.Tray` so every live tray and its tooltip / title /
 * image / context-menu state is recorded into `host[TRAY_REGISTRY_GLOBAL]` as `{ inst, rec }` entries
 * (the `rec` is the JSON-serialisable {@link NativeTray}); `destroy()` removes the entry. Exported as a
 * string so it is BOTH embedded in the launch shim and runnable in tests via `new Function('electron',
 * 'host', TRAY_HOOK_BODY)`.
 */
export const TRAY_HOOK_BODY = `
try {
  var OrigTray = electron && electron.Tray
  if (typeof OrigTray !== 'function') return
  var registry = []
  host[${JSON.stringify(TRAY_REGISTRY_GLOBAL)}] = registry
  var str = function (v) { return typeof v === 'string' ? v : '' }
  var serializeItem = function (raw) {
    if (raw === null || typeof raw !== 'object') return null
    var rawType = str(raw.type)
    var type =
      rawType === 'separator' || rawType === 'submenu' || rawType === 'checkbox' ||
      rawType === 'radio' || rawType === 'header' || rawType === 'palette' ? rawType : 'normal'
    var item = { label: str(raw.label), type: type, enabled: raw.enabled !== false, visible: raw.visible !== false }
    if (typeof raw.id === 'string' && raw.id !== '') item.id = raw.id
    if (typeof raw.role === 'string' && raw.role !== '') item.role = raw.role
    if (typeof raw.accelerator === 'string' && raw.accelerator !== '') item.accelerator = raw.accelerator
    if (item.type === 'checkbox' || item.type === 'radio') item.checked = raw.checked === true
    if (typeof raw.sublabel === 'string' && raw.sublabel !== '') item.sublabel = raw.sublabel
    if (typeof raw.toolTip === 'string' && raw.toolTip !== '') item.toolTip = raw.toolTip
    var sub = raw.submenu && raw.submenu.items
    if (Array.isArray(sub)) item.submenu = sub.map(serializeItem).filter(Boolean)
    return item
  }
  var serializeMenu = function (menu) {
    if (menu === null || typeof menu !== 'object' || !Array.isArray(menu.items)) return undefined
    return { items: menu.items.map(serializeItem).filter(Boolean) }
  }
  var nextId = 0
  var recFor = function (inst) {
    for (var i = 0; i < registry.length; i++) if (registry[i].inst === inst) return registry[i].rec
    var rec = { id: nextId++, hasImage: false }
    registry.push({ inst: inst, rec: rec })
    return rec
  }
  var removeFor = function (inst) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].inst === inst) {
        registry.splice(i, 1)
        return
      }
    }
  }
  var patch = function (name, apply) {
    var orig = OrigTray.prototype[name]
    if (typeof orig !== 'function') return
    OrigTray.prototype[name] = function () {
      var result = orig.apply(this, arguments)
      try { apply(recFor(this), arguments) } catch (e) {}
      return result
    }
  }
  patch('setToolTip', function (rec, args) { if (typeof args[0] === 'string') rec.toolTip = args[0] })
  patch('setTitle', function (rec, args) { if (typeof args[0] === 'string') rec.title = args[0] })
  patch('setImage', function (rec, args) { rec.hasImage = args.length > 0 && args[0] != null })
  patch('setContextMenu', function (rec, args) {
    var menu = serializeMenu(args[0])
    if (menu !== undefined) rec.menu = menu; else delete rec.menu
  })
  var origDestroy = OrigTray.prototype.destroy
  if (typeof origDestroy === 'function') {
    OrigTray.prototype.destroy = function () {
      var result = origDestroy.apply(this, arguments)
      try { removeFor(this) } catch (e) {}
      return result
    }
  }
  try {
    var TrayWrapper = function () {
      var inst = new (Function.prototype.bind.apply(OrigTray, [null].concat(Array.prototype.slice.call(arguments))))()
      var rec = recFor(inst)
      if (arguments.length > 0 && arguments[0] != null) rec.hasImage = true
      return inst
    }
    TrayWrapper.prototype = OrigTray.prototype
    Object.setPrototypeOf(TrayWrapper, OrigTray)
    Object.defineProperty(electron, 'Tray', { value: TrayWrapper, configurable: true, writable: true })
  } catch (e) {}
} catch (e) {
  // Instrumentation must never break the app's launch.
}
`

/**
 * Build the self-contained shim-main source (CommonJS) that runs {@link TRAY_HOOK_BODY} then loads
 * `realMainPath`. The real main is embedded as a `file://` URL so the shim's dynamic `import()` resolves
 * a CommonJS or an ESM main identically.
 */
export function buildInstrumentationShim(realMainPath: string): string {
  // {@link TRAY_HOOK_BODY} is a compile-time constant (no untrusted interpolation). `realMainPath` is the
  // operator's own preflighted launch entry (absolute, existing, inside --app-root); it is JSON-escaped
  // into a string LITERAL and written to a file Electron runs — it is never passed to `new Function`/eval.
  const realMainUrl = pathToFileURL(realMainPath).href
  return `'use strict'
// Stagewright launch-time native instrumentation shim. Generated per launch; do not edit.
try {
  (function (electron, host) {${TRAY_HOOK_BODY}})(require('electron'), globalThis)
} catch (e) {
  console.error('[stagewright] native instrumentation failed:', e)
}
import(${JSON.stringify(realMainUrl)}).catch(function (err) {
  console.error('[stagewright] failed to load the instrumented app main:', err)
})
`
}
