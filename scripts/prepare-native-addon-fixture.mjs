import { execFile as execFileCallback } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const TARGET_ELECTRON_VERSION = '41.7.1'
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])
const DOWNLOAD_ATTEMPTS = 3

function targetArchiveName() {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    throw new Error(
      `Native addon fixture preparation supports darwin and linux, not ${process.platform}.`,
    )
  }
  return `electron-v${TARGET_ELECTRON_VERSION}-${process.platform}-${process.arch}.zip`
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function download(url, destination) {
  const temporary = `${destination}.partial-${process.pid}`
  let failure
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    await rm(temporary, { force: true })
    try {
      const response = await fetch(url)
      if (!response.ok || response.body === null) {
        throw new Error(`Download failed (${response.status}) for ${url}`)
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
      await rename(temporary, destination)
      return
    } catch (error) {
      failure = error
      await rm(temporary, { force: true })
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500))
      }
    }
  }
  throw failure
}

async function main() {
  const archiveName = targetArchiveName()
  const cacheRoot =
    process.env['STAGEWRIGHT_NATIVE_ADDON_CACHE'] ??
    path.join(
      homedir(),
      '.cache',
      'electron-stagewright',
      'native-addon-fixture',
      TARGET_ELECTRON_VERSION,
      `${process.platform}-${process.arch}`,
    )
  const electronArchive = path.join(cacheRoot, archiveName)
  const headersArchive = path.join(cacheRoot, `node-v${TARGET_ELECTRON_VERSION}-headers.tar.gz`)
  const headersRoot = path.join(cacheRoot, 'headers', 'node_headers')
  const nodeHeader = path.join(headersRoot, 'include', 'node', 'node.h')

  await mkdir(cacheRoot, { recursive: true })
  if (!(await exists(electronArchive))) {
    await download(
      `https://github.com/electron/electron/releases/download/v${TARGET_ELECTRON_VERSION}/${archiveName}`,
      electronArchive,
    )
  }
  if (!(await exists(headersArchive))) {
    await download(
      `https://electronjs.org/headers/v${TARGET_ELECTRON_VERSION}/node-v${TARGET_ELECTRON_VERSION}-headers.tar.gz`,
      headersArchive,
    )
  }
  if (!(await exists(nodeHeader))) {
    const headersDirectory = path.dirname(headersRoot)
    await mkdir(headersDirectory, { recursive: true })
    await execFile('tar', ['-xzf', headersArchive, '-C', headersDirectory])
  }
  if (!(await exists(nodeHeader))) {
    throw new Error(
      `Electron ${TARGET_ELECTRON_VERSION} headers did not contain include/node/node.h`,
    )
  }

  // Deliberately shell-compatible for GitHub Actions' $GITHUB_ENV and local eval.
  process.stdout.write(
    [
      `STAGEWRIGHT_NATIVE_ADDON_ELECTRON_ARCHIVE=${electronArchive}`,
      `STAGEWRIGHT_NATIVE_ADDON_HEADERS_DIR=${headersRoot}`,
    ].join('\n') + '\n',
  )
}

main().catch((error) => {
  process.stderr.write(
    `native addon fixture preparation failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
