import { spawnSync } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import inventory from './real-test-inventory.json' with { type: 'json' }
import { assertRealExecution } from './real-test-report.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const report = path.join(root, 'output/real-electron/results.json')
await mkdir(path.dirname(report), { recursive: true })
await rm(report, { force: true })
const requireCore = createRequire(path.join(root, 'packages/core/package.json'))
// Read provisioned files directly: newer Electron packages may try to download a binary
// as a side effect of require('electron'). Missing qualification inputs must fail closed.
// Mirror electron's own resolution, including the ELECTRON_OVERRIDE_DIST_PATH the harness forwards.
const electronDirectory = path.dirname(requireCore.resolve('electron/package.json'))
const overrideDist = process.env.ELECTRON_OVERRIDE_DIST_PATH
try {
  const pathFile = await readFile(path.join(electronDirectory, 'path.txt'), 'utf8').catch(
    (error) => {
      if (overrideDist) return ''
      throw error
    },
  )
  const executable = pathFile.trim() || (overrideDist ? 'electron' : '')
  if (!executable) throw new Error('Empty Electron path.txt')
  await access(path.join(overrideDist || path.join(electronDirectory, 'dist'), executable))
} catch (cause) {
  throw new Error(
    'Missing provisioned Electron binary; run the supported binary preparation before qualification',
    { cause },
  )
}
const nativeAddonInputs = {
  STAGEWRIGHT_NATIVE_ADDON_ELECTRON_ARCHIVE: [],
  STAGEWRIGHT_NATIVE_ADDON_HEADERS_DIR: [
    'include/node/node.h',
    ...(process.platform === 'win32' ? ['Release/node.lib'] : []),
  ],
  ...(process.platform === 'win32' ? { STAGEWRIGHT_NATIVE_ADDON_NODE_GYP: [] } : {}),
}
for (const [variable, files] of Object.entries(nativeAddonInputs)) {
  const value = process.env[variable]
  if (!value) throw new Error(`Missing required real-runtime prerequisite: ${variable}`)
  for (const file of files.length > 0 ? files.map((f) => path.join(value, f)) : [value]) {
    await access(file)
  }
}
const requireRoot = createRequire(path.join(root, 'package.json'))
const vitest = path.join(path.dirname(requireRoot.resolve('vitest/package.json')), 'vitest.mjs')
const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    '--project',
    'real-electron',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${report}`,
  ],
  {
    cwd: root,
    env: { ...process.env, STAGEWRIGHT_E2E: '1' },
    stdio: 'inherit',
  },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
assertRealExecution(JSON.parse(await readFile(report, 'utf8')), inventory, root)
console.log(`Qualified ${inventory.length} reviewed real-runtime files on ${process.platform}`)
