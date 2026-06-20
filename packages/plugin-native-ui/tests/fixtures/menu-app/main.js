// Minimal Electron main process for the gated native-UI smoke. Sets a KNOWN application menu so the
// smoke can read it back and assert the interesting fields — a checkbox (checked), an accelerator, a
// disabled item, and a role-based item — an invokable File > Mark item whose click writes a sentinel
// into the page, and a File > Notify item whose click shows a native notification so the smoke can prove
// notification capture works end to end. Quits when the window closes.
import { BrowserWindow, Menu, Notification, app } from 'electron'
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: true,
    webPreferences: { contextIsolation: true },
  })
  void win.loadFile(join(fixtureDir, 'index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
