/**
 * Real Electron coverage for the ABI risk `runtime: "project"` prevents.
 *
 * The fixture compiles a classic Node addon against Electron 41 (ABI 145), where the server's
 * default Electron is ABI 146. A default launch must fail while a root-confined project runtime
 * launches and snapshots the exact same app. CI provides the archive and headers through the
 * cached fixture-preparation script; ordinary local test runs skip this network/toolchain fixture.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { TransportRegistry } from '../src/server/transport-registry.js'
import { doctorTool, launchTool, stopTool } from '../src/tools/lifecycle/index.js'
import { snapshotTool } from '../src/tools/snapshot/index.js'
import { PlaywrightElectronTransport } from '../src/transports/index.js'

const execFile = promisify(execFileCallback)
const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const ELECTRON_ARCHIVE = process.env['STAGEWRIGHT_NATIVE_ADDON_ELECTRON_ARCHIVE']
const HEADERS_DIRECTORY = process.env['STAGEWRIGHT_NATIVE_ADDON_HEADERS_DIR']
const SUPPORTED_PLATFORM = process.platform === 'darwin' || process.platform === 'linux'
const SHOULD_RUN =
  RUN_E2E && SUPPORTED_PLATFORM && ELECTRON_ARCHIVE !== undefined && HEADERS_DIRECTORY !== undefined
const TARGET_ELECTRON_VERSION = '41.7.1'
const managers = new Set<SessionManager>()
const temporaryRoots: string[] = []

const ADDON_SOURCE = `#include <node.h>

namespace stagewright_fixture {
void Initialize(v8::Local<v8::Object> exports) {}
NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)
}  // namespace stagewright_fixture
`

const APP_MAIN = `const { app, BrowserWindow } = require('electron')
try {
  require('./build/Release/runtime-aligned.node')
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false })
  await window.loadURL('data:text/html,<main><h1>Runtime aligned</h1></main>')
})
app.on('window-all-closed', () => app.quit())
`

afterEach(async () => {
  await Promise.all([...managers].map((sessions) => sessions.disposeAll()))
  managers.clear()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function targetExecutableRelativePath(): string {
  return process.platform === 'darwin'
    ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
    : 'electron'
}

async function prepareFixture(
  archive: string,
  headersDirectory: string,
): Promise<{ readonly root: string; readonly main: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'stagewright-native-addon-runtime-'))
  temporaryRoots.push(root)
  const electronDirectory = path.join(root, 'node_modules', 'electron')
  const distributionDirectory = path.join(electronDirectory, 'dist')
  const addonDirectory = path.join(root, 'build', 'Release')
  const source = path.join(root, 'runtime-aligned.cc')
  const addon = path.join(addonDirectory, 'runtime-aligned.node')
  const main = path.join(root, 'main.cjs')
  await Promise.all([
    mkdir(distributionDirectory, { recursive: true }),
    mkdir(addonDirectory, { recursive: true }),
  ])
  await execFile('unzip', ['-q', archive, '-d', distributionDirectory])
  await Promise.all([
    writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'native-addon-runtime-fixture' }),
    ),
    writeFile(
      path.join(electronDirectory, 'package.json'),
      JSON.stringify({ version: TARGET_ELECTRON_VERSION }),
    ),
    writeFile(path.join(electronDirectory, 'path.txt'), `${targetExecutableRelativePath()}\n`),
    writeFile(source, ADDON_SOURCE),
    writeFile(main, APP_MAIN),
  ])
  const headerPath = path.join(headersDirectory, 'include', 'node')
  const compiler = process.env['CXX'] ?? (process.platform === 'darwin' ? 'clang++' : 'g++')
  const compilerArgs =
    process.platform === 'darwin'
      ? [
          '-std=c++20',
          '-I',
          headerPath,
          '-dynamiclib',
          '-undefined',
          'dynamic_lookup',
          source,
          '-o',
          addon,
        ]
      : [
          '-std=c++20',
          '-I',
          headerPath,
          '-shared',
          '-fPIC',
          '-Wl,--unresolved-symbols=ignore-all',
          source,
          '-o',
          addon,
        ]
  await execFile(compiler, compilerArgs, { maxBuffer: 4 * 1024 * 1024 })
  return { root, main }
}

describe('native addon project-runtime recovery (real Electron)', () => {
  it.skipIf(!SHOULD_RUN)(
    'warns before a default ABI-mismatched launch and recovers with the target runtime',
    async () => {
      if (ELECTRON_ARCHIVE === undefined || HEADERS_DIRECTORY === undefined) {
        throw new Error(
          'Native addon smoke fixture paths must be configured when the test is enabled.',
        )
      }

      const fixture = await prepareFixture(ELECTRON_ARCHIVE, HEADERS_DIRECTORY)
      const sessions = new SessionManager()
      managers.add(sessions)
      const dispatcher = new Dispatcher({
        appRoot: fixture.root,
        sessions,
        snapshots: new SnapshotStore(),
        transports: new TransportRegistry({ transports: [new PlaywrightElectronTransport()] }),
      })
      dispatcher.registerAll([doctorTool, launchTool, snapshotTool, stopTool])

      const doctor = (await dispatcher.dispatch('electron_doctor', {})) as SuccessResponse & {
        readonly checks: readonly {
          readonly id: string
          readonly status: string
          readonly message: string
        }[]
      }
      expect(doctor.ok).toBe(true)
      expect(doctor.checks.find((check) => check.id === 'project_runtime')).toMatchObject({
        status: 'warn',
        message: expect.stringContaining('NODE_MODULE_VERSION'),
      })

      const defaultLaunch = (await dispatcher.dispatch('electron_launch', {
        main: fixture.main,
      })) as ErrorResponse
      expect(defaultLaunch).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
      expect(defaultLaunch.error).toMatch(/NODE_MODULE_VERSION|compiled against a different/i)

      const projectLaunch = (await dispatcher.dispatch('electron_launch', {
        main: fixture.main,
        runtime: 'project',
      })) as
        | (SuccessResponse & { readonly runtime_source: string; readonly session_id: string })
        | ErrorResponse
      if (!projectLaunch.ok) {
        throw new Error(`Project-runtime launch failed: ${JSON.stringify(projectLaunch)}`)
      }
      expect(projectLaunch).toMatchObject({ ok: true, runtime_source: 'project' })
      const snapshot = (await dispatcher.dispatch('electron_snapshot', {
        sessionId: projectLaunch.session_id,
      })) as SuccessResponse & { readonly snapshot: { readonly entries: readonly unknown[] } }
      expect(snapshot.ok).toBe(true)
      expect(snapshot.snapshot.entries.length).toBeGreaterThan(0)
      await expect(
        dispatcher.dispatch('electron_stop', { sessionId: projectLaunch.session_id }),
      ).resolves.toMatchObject({ ok: true, stopped: true })
    },
    120_000,
  )
})
