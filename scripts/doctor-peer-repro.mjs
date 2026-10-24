// Offline CLI reproduction with a separate server install and a synthetic project peer.
// Run after pnpm build. No Electron entry point or app is executed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32')
  throw new Error('This manual reproduction needs POSIX bin symlinks.')
const original = process.argv.includes('--expect-original')
const core = fileURLToPath(new URL('../packages/core/', import.meta.url))
const scratch = await mkdtemp(path.join(tmpdir(), 'stagewright-doctor-peer-'))
const harness = path.join(scratch, 'server')
const project = path.join(scratch, 'project')
const modules = path.join(harness, 'node_modules')
const installedCore = path.join(modules, '@electron-stagewright', 'core')
const manifest = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8'))

try {
  await mkdir(installedCore, { recursive: true })
  await mkdir(project)
  await mkdir(path.join(modules, '.bin'))
  await writeFile(path.join(harness, 'package.json'), '{"private":true}')
  await writeFile(path.join(scratch, 'empty.npmrc'), '')
  await writeFile(path.join(installedCore, 'package.json'), JSON.stringify(manifest))
  await cp(path.join(core, 'dist'), path.join(installedCore, 'dist'), { recursive: true })
  for (const dependency of Object.keys(manifest.dependencies)) {
    const destination = path.join(modules, dependency)
    await mkdir(path.dirname(destination), { recursive: true })
    await symlink(await realpath(path.join(core, 'node_modules', dependency)), destination, 'dir')
  }
  // Copy both Playwright packages so their module resolution cannot borrow workspace Electron.
  const playwright = await realpath(path.join(core, 'node_modules', 'playwright'))
  const playwrightCore = await realpath(path.join(playwright, '..', 'playwright-core'))
  await cp(playwright, path.join(modules, 'playwright'), { recursive: true })
  await cp(playwrightCore, path.join(modules, 'playwright-core'), { recursive: true })
  const cli = path.join(installedCore, 'dist', 'cli.js')
  // npm/pnpm normally marks package bins executable during installation.
  await chmod(cli, 0o755)
  await symlink(cli, path.join(modules, '.bin', 'electron-stagewright'))
  const env = {
    PATH: process.env.PATH,
    TMPDIR: scratch,
    npm_config_cache: path.join(scratch, 'npm-cache'),
    npm_config_userconfig: path.join(scratch, 'empty.npmrc'),
    npm_config_globalconfig: path.join(scratch, 'empty-global.npmrc'),
  }
  await writeFile(env.npm_config_globalconfig, '')
  for (const projectCopy of [false, true]) {
    if (projectCopy) {
      const electron = path.join(project, 'node_modules', 'electron')
      await mkdir(electron, { recursive: true })
      await writeFile(
        path.join(electron, 'package.json'),
        JSON.stringify({ name: 'electron', version: '44.3.0' }),
      )
    }
    for (const mode of ['node', 'npx']) {
      const args = ['doctor', '--json', '--tool-profile', 'essential', '--app-root', project]
      const result = spawnSync(
        mode === 'node' ? process.execPath : 'npx',
        mode === 'node'
          ? [cli, ...args]
          : ['--offline', '--no', '--prefix', harness, 'electron-stagewright', ...args],
        { cwd: project, env, encoding: 'utf8', timeout: 30_000 },
      )
      assert.ifError(result.error)
      assert.equal(result.status, 1, result.stderr)
      const report = JSON.parse(result.stdout)
      assert.equal(report.ok, false)
      assert.equal(report.checks.find((check) => check.id === 'playwright').status, 'pass')
      const electron = report.checks.find((check) => check.id === 'electron')
      assert.equal(electron.status, 'fail')
      if (projectCopy) {
        assert.equal(
          electron.details.project_copy,
          await realpath(path.join(project, 'node_modules', 'electron')),
        )
        assert.match(electron.hint, /--prefix ~\//)
        if (original) assert.match(electron.hint, /npx reused electron/)
        else {
          assert.doesNotMatch(electron.hint, /npx reused/)
          assert.match(electron.hint, /If the server runs through npx/)
        }
      } else assert.equal(electron.details, undefined)
      // Keep printed evidence portable: no scratch paths or raw child logs.
      console.log(
        JSON.stringify({
          mode,
          projectCopy,
          exit: result.status,
          ok: report.ok,
          electron: electron.status,
          core: report.runtime.server.core,
          node: report.runtime.server.node,
          playwright: report.runtime.server.playwright,
          expectedCopy: original ? 'original' : 'conditional',
        }),
      )
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
