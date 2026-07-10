import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const ROOT = process.cwd()
const CORE_DIR = path.join(ROOT, 'packages', 'core')
const requireFromCore = createRequire(pathToFileURL(path.join(CORE_DIR, 'package.json')))
const APP_MAIN = `
import { BrowserWindow, app } from 'electron'

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, webPreferences: { contextIsolation: true } })
  await win.loadFile(new URL('./index.html', import.meta.url).pathname)
})
app.on('window-all-closed', () => app.quit())
`
const APP_HTML = `<!doctype html><title>Package smoke</title><button id="greet">Greet</button><p id="status">Waiting</p><script>document.querySelector('#greet').onclick=()=>document.querySelector('#status').textContent='Ready'</script>`
const CLIENT_SMOKE = `
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [cliPath, appMain, profile] = process.argv.slice(2)
const client = new Client({ name: 'package-smoke', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: profile === undefined ? [cliPath] : [cliPath, '--tool-profile', profile],
})

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.find((block) => block.type === 'text')?.text
  if (typeof text !== 'string') throw new Error(name + ': no text result')
  const envelope = JSON.parse(text)
  if (!envelope.ok) throw new Error(name + ': ' + (envelope.code ?? envelope.error ?? 'failed'))
  return envelope
}

let sessionId
try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  if (!tools.some((tool) => tool.name === 'electron_launch')) {
    throw new Error('published manifest omitted electron_launch')
  }
  if (profile === undefined) {
    if (!tools.some((tool) => tool.name === 'electron_doctor')) {
      throw new Error('published full manifest omitted electron_doctor')
    }
    const doctor = await call('electron_doctor', {})
    if (!Array.isArray(doctor.checks)) throw new Error('electron_doctor omitted its check list')
  } else if (profile === 'essential' && tools.some((tool) => tool.name === 'electron_doctor')) {
    throw new Error('published essential manifest unexpectedly includes electron_doctor')
  }
  const launched = await call('electron_launch', { main: appMain })
  sessionId = launched.session_id
  await call('electron_snapshot', { sessionId })
  await call('electron_click', { sessionId, selector: '#greet' })
  await call('electron_expect_text', { sessionId, selector: '#status', equals: 'Ready' })
} finally {
  if (sessionId !== undefined) await call('electron_stop', { sessionId }).catch(() => undefined)
  await client.close().catch(() => undefined)
}
`

async function packageVersion(name) {
  const packagePath = requireFromCore.resolve(`${name}/package.json`)
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  if (typeof pkg.version !== 'string') throw new Error(`${packagePath} has no version`)
  return pkg.version
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'stagewright-package-smoke-'))
  const packDir = path.join(tempRoot, 'pack')
  const scratchDir = path.join(tempRoot, 'scratch')
  try {
    await Promise.all([mkdir(packDir), mkdir(scratchDir)])
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', packDir], {
      cwd: CORE_DIR,
      maxBuffer: 1024 * 1024,
    })
    const packed = JSON.parse(stdout)
    const filename = packed[0]?.filename
    if (typeof filename !== 'string') throw new Error('npm pack did not report a tarball filename')
    const coreTarball = path.join(packDir, filename)
    const [playwrightVersion, electronVersion] = await Promise.all([
      packageVersion('playwright'),
      packageVersion('electron'),
    ])

    await execFile(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        coreTarball,
        `playwright@${playwrightVersion}`,
        `electron@${electronVersion}`,
      ],
      { cwd: scratchDir, maxBuffer: 8 * 1024 * 1024 },
    )
    await Promise.all([
      writeFile(path.join(scratchDir, 'app.mjs'), APP_MAIN),
      writeFile(path.join(scratchDir, 'index.html'), APP_HTML),
    ])
    const clientPath = path.join(scratchDir, 'client-smoke.mjs')
    await writeFile(clientPath, CLIENT_SMOKE)
    const cliPath = path.join(
      scratchDir,
      'node_modules',
      '@electron-stagewright',
      'core',
      'dist',
      'cli.js',
    )
    await execFile(process.execPath, [clientPath, cliPath, path.join(scratchDir, 'app.mjs')], {
      cwd: scratchDir,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 90_000,
    })
    await execFile(
      process.execPath,
      [clientPath, cliPath, path.join(scratchDir, 'app.mjs'), 'essential'],
      {
        cwd: scratchDir,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 90_000,
      },
    )
    process.stderr.write(`package smoke passed: ${coreTarball}\n`)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(
    `package smoke failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exitCode = 1
})
