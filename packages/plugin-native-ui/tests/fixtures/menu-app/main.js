// Minimal Electron main process for the gated native-UI smoke. Sets a KNOWN application menu so the
// smoke can read it back and assert the interesting fields — a checkbox (checked), an accelerator, a
// disabled item, and a role-based item — then loads a trivial page. Quits when the window closes.
import { BrowserWindow, Menu, app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = dirname(fileURLToPath(import.meta.url))

const template = [
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
