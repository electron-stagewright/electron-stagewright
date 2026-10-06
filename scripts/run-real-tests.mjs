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
const electronDirectory = path.dirname(requireCore.resolve('electron/package.json'))
try {
  const executable = (await readFile(path.join(electronDirectory, 'path.txt'), 'utf8')).trim()
  if (!executable) throw new Error('Empty Electron path.txt')
  await access(path.join(electronDirectory, 'dist', executable))
} catch (cause) {
  throw new Error(
    'Missing provisioned Electron binary; run the supported binary preparation before qualification',
    { cause },
  )
}
if (process.platform !== 'win32') {
  for (const variable of [
    'STAGEWRIGHT_NATIVE_ADDON_ELECTRON_ARCHIVE',
    'STAGEWRIGHT_NATIVE_ADDON_HEADERS_DIR',
  ]) {
    const value = process.env[variable]
    if (!value) throw new Error(`Missing required real-runtime prerequisite: ${variable}`)
    await access(variable.endsWith('HEADERS_DIR') ? path.join(value, 'include/node/node.h') : value)
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
assertRealExecution(JSON.parse(await readFile(report, 'utf8')), inventory, root, process.platform)
console.log(
  `Qualified ${inventory.length} reviewed real-runtime files on ${process.platform}; native-addon omission is explicit on Windows`,
)
