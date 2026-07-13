import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
const APP_HTML = `<!doctype html><title>Package smoke</title><img id="missing-alt" src="missing.png"><button id="greet">Greet</button><p id="status">Waiting</p><script>document.querySelector('#greet').onclick=()=>document.querySelector('#status').textContent='Ready'</script>`
const PLUGIN_SDK_SMOKE = `
import {
  createPluginConfigState,
  requireTransportCapability,
  sessionIdField,
} from '@electron-stagewright/core/plugin-sdk'

const state = createPluginConfigState({ tags: ['default'] })
state.set({ tags: ['configured'] })
if (!Object.isFrozen(state.current) || state.current.tags[0] !== 'configured') {
  throw new Error('published plugin SDK did not expose immutable config state')
}
const capability = requireTransportCapability({ canIntercept: false }, 'canIntercept', () => 'fallback')
if (capability.supported || capability.fallback !== 'fallback') {
  throw new Error('published plugin SDK did not expose the capability guard')
}
if (!sessionIdField.sessionId.safeParse('session-1').success) {
  throw new Error('published plugin SDK did not expose the session schema fragment')
}
`
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
const A11Y_CLIENT_SMOKE = `
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [cliPath, appMain] = process.argv.slice(2)
const client = new Client({ name: 'a11y-package-smoke', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cliPath, '--plugin', '@electron-stagewright/plugin-a11y'],
})

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.find((block) => block.type === 'text')?.text
  if (typeof text !== 'string') throw new Error(name + ': no text result')
  return JSON.parse(text)
}

let sessionId
try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  if (!tools.some((tool) => tool.name === 'a11y_audit')) {
    throw new Error('published a11y manifest omitted a11y_audit')
  }
  const launched = await call('electron_launch', { main: appMain })
  if (!launched.ok || typeof launched.session_id !== 'string') {
    throw new Error('electron_launch failed for a11y package smoke')
  }
  sessionId = launched.session_id
  const first = await call('a11y_audit', { sessionId })
  if (!first.ok || first.engine?.cache_hit !== false || first.engine?.transferred_bytes <= 100000) {
    throw new Error('published a11y plugin did not install the fixed engine: ' + JSON.stringify(first))
  }
  if (!first.violations?.some((violation) => violation.id === 'image-alt')) {
    throw new Error('published a11y plugin did not report the fixture image-alt violation')
  }
  const warm = await call('a11y_audit', { sessionId })
  if (!warm.ok || warm.engine?.cache_hit !== true || warm.engine?.transferred_bytes !== 0) {
    throw new Error('published a11y plugin did not reuse its renderer engine cache')
  }
} finally {
  if (sessionId !== undefined) await call('electron_stop', { sessionId }).catch(() => undefined)
  await client.close().catch(() => undefined)
}
`
const DEMO_CLIENT_SMOKE = `
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [cliPath] = process.argv.slice(2)
const client = new Client({ name: 'demo-package-smoke', version: '1.0.0' })
const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, '--demo'] })

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.find((block) => block.type === 'text')?.text
  if (typeof text !== 'string') throw new Error(name + ': no text result')
  const envelope = JSON.parse(text)
  if (!envelope.ok) throw new Error(name + ': ' + (envelope.code ?? envelope.error ?? 'failed'))
  return envelope
}

async function inspectorWindow(sessionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = await call('electron_windows_list', { sessionId })
    const inspector = listed.windows.find((window) => window.title === 'Stagewright demo inspector')
    if (inspector !== undefined) return inspector
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('demo inspector window did not appear')
}

let sessionId
try {
  await client.connect(transport)
  const launched = await call('electron_launch', {})
  sessionId = launched.session_id
  const snapshot = await call('electron_snapshot', { sessionId })
  const addTask = snapshot.snapshot.entries.find((entry) => entry.name === 'Add a task')
  if (typeof addTask?.ref !== 'number') throw new Error('demo snapshot omitted Add a task ref')
  await call('electron_click', { sessionId, ref: addTask.ref })
  await call('electron_type', { sessionId, selector: '#task-title', text: 'Tarball verified' })
  await call('electron_click', { sessionId, selector: '#save-task' })
  await call('electron_expect_text', {
    sessionId,
    selector: '#task-summary',
    equals: '1 task · Tarball verified',
  })
  await call('electron_click', { sessionId, selector: '#open-inspector' })
  const inspector = await inspectorWindow(sessionId)
  await call('electron_switch_window', { sessionId, targetId: inspector.id })
  await call('electron_expect_text', {
    sessionId,
    selector: '#inspector-status',
    equals: '1 task in the board',
  })
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

async function packTracePlugin(packDir) {
  await execFile(
    'pnpm',
    ['--filter', '@electron-stagewright/plugin-trace', 'pack', '--pack-destination', packDir],
    { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  )
  const filename = (await readdir(packDir)).find(
    (entry) => entry.startsWith('electron-stagewright-plugin-trace-') && entry.endsWith('.tgz'),
  )
  if (filename === undefined) throw new Error('pnpm pack did not produce the trace plugin tarball')
  return path.join(packDir, filename)
}

async function packA11yPlugin(packDir) {
  await execFile(
    'pnpm',
    ['--filter', '@electron-stagewright/plugin-a11y', 'pack', '--pack-destination', packDir],
    { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  )
  const filename = (await readdir(packDir)).find(
    (entry) => entry.startsWith('electron-stagewright-plugin-a11y-') && entry.endsWith('.tgz'),
  )
  if (filename === undefined) throw new Error('pnpm pack did not produce the a11y plugin tarball')
  return path.join(packDir, filename)
}

async function packDemo(packDir) {
  await execFile(
    'pnpm',
    ['--filter', '@electron-stagewright/demo', 'pack', '--pack-destination', packDir],
    { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  )
  const filename = (await readdir(packDir)).find(
    (entry) => entry.startsWith('electron-stagewright-demo-') && entry.endsWith('.tgz'),
  )
  if (filename === undefined) throw new Error('pnpm pack did not produce the demo tarball')
  return path.join(packDir, filename)
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'stagewright-package-smoke-'))
  const packDir = path.join(tempRoot, 'pack')
  const a11yPackDir = path.join(tempRoot, 'a11y-pack')
  const tracePackDir = path.join(tempRoot, 'trace-pack')
  const demoPackDir = path.join(tempRoot, 'demo-pack')
  const scratchDir = path.join(tempRoot, 'scratch')
  try {
    await Promise.all([
      mkdir(packDir),
      mkdir(a11yPackDir),
      mkdir(tracePackDir),
      mkdir(demoPackDir),
      mkdir(scratchDir),
    ])
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', packDir], {
      cwd: CORE_DIR,
      maxBuffer: 1024 * 1024,
    })
    const packed = JSON.parse(stdout)
    const filename = packed[0]?.filename
    if (typeof filename !== 'string') throw new Error('npm pack did not report a tarball filename')
    const publishedPaths = packed[0]?.files?.map((file) => file.path)
    if (
      !Array.isArray(publishedPaths) ||
      publishedPaths.some((file) => file.includes('testkit') || file.includes('/tests/'))
    ) {
      throw new Error(
        'published core tarball unexpectedly includes private testkit or test sources',
      )
    }
    const coreTarball = path.join(packDir, filename)
    const a11yTarball = await packA11yPlugin(a11yPackDir)
    const traceTarball = await packTracePlugin(tracePackDir)
    const demoTarball = await packDemo(demoPackDir)
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
        a11yTarball,
        traceTarball,
        demoTarball,
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
    const demoClientPath = path.join(scratchDir, 'demo-client-smoke.mjs')
    const a11yClientPath = path.join(scratchDir, 'a11y-client-smoke.mjs')
    const pluginSdkPath = path.join(scratchDir, 'plugin-sdk-smoke.mjs')
    await Promise.all([
      writeFile(clientPath, CLIENT_SMOKE),
      writeFile(demoClientPath, DEMO_CLIENT_SMOKE),
      writeFile(a11yClientPath, A11Y_CLIENT_SMOKE),
      writeFile(pluginSdkPath, PLUGIN_SDK_SMOKE),
      writeFile(
        path.join(scratchDir, 'replay.json'),
        `${JSON.stringify(
          {
            format: 'stagewright-replay',
            version: 1,
            normalizers: ['session_id', 'timestamps', 'absolute_paths'],
            redactions: [],
            steps: [
              {
                tool: 'electron_launch',
                args: { main: path.join(scratchDir, 'app.mjs') },
                captureSession: '$stagewright.session.1',
                expect: { ok: true },
              },
              {
                tool: 'electron_snapshot',
                args: { sessionId: '$stagewright.session.1' },
                expect: { ok: true },
              },
              {
                tool: 'electron_click',
                args: { sessionId: '$stagewright.session.1', selector: '#greet' },
                expect: { ok: true },
              },
              {
                tool: 'electron_expect_text',
                args: {
                  sessionId: '$stagewright.session.1',
                  selector: '#status',
                  equals: 'Ready',
                },
                expect: { ok: true },
              },
              {
                tool: 'electron_stop',
                args: { sessionId: '$stagewright.session.1' },
                expect: { ok: true },
              },
            ],
          },
          null,
          2,
        )}\n`,
      ),
    ])
    await execFile(process.execPath, [pluginSdkPath], {
      cwd: scratchDir,
      maxBuffer: 8 * 1024 * 1024,
    })
    const cliPath = path.join(
      scratchDir,
      'node_modules',
      '@electron-stagewright',
      'core',
      'dist',
      'cli.js',
    )
    const demoRoot = path.join(scratchDir, 'node_modules', '@electron-stagewright', 'demo')
    const a11yRoot = path.join(scratchDir, 'node_modules', '@electron-stagewright', 'plugin-a11y')
    const a11yNotice = await readFile(path.join(a11yRoot, 'THIRD-PARTY-NOTICES.md'), 'utf8')
    if (!a11yNotice.includes('MPL-2.0')) {
      throw new Error('published a11y plugin omitted its axe-core MPL notice')
    }
    const demoRuntimeFiles = [
      'dist/manifest.js',
      'dist/main.js',
      'dist/index.html',
      'dist/inspector.html',
    ]
    const demoContents = await Promise.all(
      demoRuntimeFiles.map(async (file) => ({
        file,
        content: await readFile(path.join(demoRoot, file), 'utf8'),
      })),
    )
    if (demoContents.some(({ content }) => content.includes('packages/'))) {
      throw new Error('published demo unexpectedly imports a monorepo path')
    }
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
    await execFile(process.execPath, [demoClientPath, cliPath], {
      cwd: scratchDir,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 90_000,
    })
    await execFile(process.execPath, [a11yClientPath, cliPath, path.join(scratchDir, 'app.mjs')], {
      cwd: scratchDir,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 90_000,
    })
    const replayBin = path.join(scratchDir, 'node_modules', '.bin', 'electron-stagewright-replay')
    const { stdout: replayOutput } = await execFile(
      replayBin,
      [path.join(scratchDir, 'replay.json'), '--json'],
      { cwd: scratchDir, maxBuffer: 8 * 1024 * 1024, timeout: 90_000 },
    )
    const replayReport = JSON.parse(replayOutput)
    if (
      replayReport?.format !== 'stagewright-replay-report' ||
      replayReport?.passed !== true ||
      replayReport?.exit_code !== 0
    ) {
      throw new Error(`published replay bin failed: ${replayOutput}`)
    }
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
