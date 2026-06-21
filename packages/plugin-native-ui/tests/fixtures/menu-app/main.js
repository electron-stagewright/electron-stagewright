// Minimal Electron main process for the gated native-UI smoke. Sets a KNOWN application menu so the
// smoke can read it back and assert the interesting fields — a checkbox (checked), an accelerator, a
// disabled item, and a role-based item — an invokable File > Mark item whose click writes a sentinel
// into the page, a File > Notify item whose click shows a native notification, and (at startup, before
// any agent could arm) a system Tray with a tooltip + context menu + a click handler AND a startup
// Notification, so the smoke proves launch-time instrumentation catches the t=0 tray setup, fires the tray
// handler via native_tray_invoke, AND captures the t=0 notification (tagged beforeArm). Quits when the
// window closes.
import { BrowserWindow, Menu, Notification, Tray, app, nativeImage } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = dirname(fileURLToPath(import.meta.url))

const template = [
  {
    label: 'File',
    submenu: [
      {
        // The smoke invokes this by path; the click writes a sentinel into the page so the side effect
        // (not just invoked:true) is observable from the renderer.
        label: 'Mark',
        click: (_item, win) => {
          win ??= BrowserWindow.getFocusedWindow()
          if (win) {
            void win.webContents.executeJavaScript(
              "document.getElementById('invoked').textContent = 'INVOKED'",
            )
          }
        },
      },
      {
        // The smoke arms notification capture, invokes this, and asserts the captured title/body —
        // proving the real Notification.prototype.show hook records against REAL Electron.
        label: 'Notify',
        click: () => {
          new Notification({ title: 'Saved', body: 'All changes saved' }).show()
        },
      },
      // No click option — Electron still installs a default click wrapper, so this validates against REAL
      // Electron that the app-defined-click heuristic reports no_handler (not a false invoked:true).
      { label: 'Inert' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { label: 'Dark Mode', type: 'checkbox', checked: true, accelerator: 'CmdOrCtrl+D' },
      { type: 'separator' },
      { label: 'Frozen', enabled: false },
      { role: 'reload' },
    ],
  },
  {
    label: 'Help',
    submenu: [{ role: 'quit' }],
  },
]

// Keep the tray + window referenced so they are not garbage-collected (which would remove the icon).
let tray
let mainWindow

app.whenReady().then(() => {
  // A startup notification fires at t=0 — before any agent could arm capture. Launch-time instrumentation
  // (instrumentNative) must catch it; the smoke asserts it comes back tagged beforeArm.
  new Notification({
    title: 'Welcome back',
    body: 'Restored your session',
    subtitle: 'Stagewright',
    silent: true,
  }).show()
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  // The tray is created ONCE at startup — before any agent could arm a capture. Launch-time
  // instrumentation must catch it; an after-launch hook would miss it entirely.
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('Stagewright fixture tray')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Tray Action' }, { role: 'quit' }]))
  // The smoke fires native_tray_invoke for this tray; the click handler writes a sentinel into the page
  // so the side effect (not just emitted:true) is observable — proving the event reached the app handler.
  tray.on('click', () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
    if (win) {
      void win.webContents.executeJavaScript(
        "document.getElementById('tray-clicked').textContent = 'TRAY_CLICKED'",
      )
    }
  })
  mainWindow = new BrowserWindow({
    width: 400,
    height: 300,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  void mainWindow.loadFile(join(fixtureDir, 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
