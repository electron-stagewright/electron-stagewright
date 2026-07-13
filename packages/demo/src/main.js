import { BrowserWindow, app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function createMainWindow() {
  const window = new BrowserWindow({
    width: 860,
    height: 650,
    minWidth: 720,
    minHeight: 520,
    show: true,
    title: 'Stagewright demo',
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('file:')) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 440,
        height: 360,
        minWidth: 360,
        minHeight: 280,
        show: true,
        title: 'Stagewright demo inspector',
        webPreferences: { contextIsolation: true, sandbox: true },
      },
    }
  })
  void window.loadFile(join(here, 'index.html'))
}

app.whenReady().then(createMainWindow)
app.on('window-all-closed', () => app.quit())
