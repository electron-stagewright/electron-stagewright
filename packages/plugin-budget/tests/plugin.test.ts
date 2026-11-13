/**
 * The budget plugin loaded into a real server over a FakeTransport whose `evaluate` stands in for
 * the main-process sampler and the renderer probe. The real bodies run in the gated smoke.
 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { EvalPolicy } from '@electron-stagewright/core'
import {
  FakeSession,
  TestLifecycle,
  fullCapabilities,
  type FakeEvaluate,
} from '@electron-stagewright/testkit'
import { afterEach, describe, expect, it } from 'vitest'

import packageJson from '../package.json' with { type: 'json' }
import budgetPlugin from '../src/index.js'
import {
  classifyProcess,
  measureMemory,
  parseFootprintJson,
  parseSmapsRollup,
} from '../src/memory.js'

const lifecycle = new TestLifecycle()
const dirs: string[] = []
afterEach(async () => {
  await lifecycle.cleanup()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface FakeApp {
  readonly evaluate: FakeEvaluate
  readonly calls: string[]
  maxStallMs: number
  probeFails: boolean
}

/** A stand-in app: `linux`-shaped facts so no host memory reader is needed for its pids. */
function fakeApp(): FakeApp {
  let windowOpen = false
  let probing = false
  const app: FakeApp = {
    calls: [],
    maxStallMs: 0,
    probeFails: false,
    evaluate: async (target, body, arg) => {
      const op = (arg as { op?: string } | undefined)?.op
      if (target === 'main') {
        app.calls.push(`main:${op}`)
        if (op === 'facts') {
          return {
            pid: 10,
            creationTime: 1_000_000,
            electron: '42.0.0',
            platform: 'win32',
            processes: [
              { pid: 10, type: 'Browser', name: null, workingSetKb: 102_400, privateKb: 51_200 },
              { pid: 11, type: 'Tab', name: null, workingSetKb: 81_920, privateKb: 40_960 },
              { pid: 12, type: 'GPU', name: null, workingSetKb: 204_800, privateKb: 307_200 },
            ],
          }
        }
        if (op === 'start') {
          windowOpen = true
          return { started: true }
        }
        if (!windowOpen) return null
        windowOpen = false
        return {
          windowMs: 2000,
          blockedMs: app.maxStallMs,
          blockedPercent: app.maxStallMs / 20,
          maxStallMs: app.maxStallMs,
          stallsOver50Ms: 0,
          stallsOver100Ms: 0,
        }
      }
      if (body.includes('getEntriesByType')) {
        app.calls.push('renderer:startup')
        return { timeOrigin: 1_000_300, loadEventEnd: 450, type: 'navigate' }
      }
      if (body.includes('window.api.ping()')) {
        app.calls.push('renderer:ipc-start')
        if (app.probeFails) throw new Error('SyntaxError: Unexpected token')
        probing = true
        return true
      }
      app.calls.push('renderer:ipc-read')
      if (!probing) return null
      probing = false
      return { samples: [1, 2, 3, 4], errors: 0, lastError: null }
    },
  }
  return app
}

async function setup(
  allowEval: boolean | EvalPolicy = true,
  pluginConfig: Record<string, unknown> = {},
) {
  const app = fakeApp()
  const { server } = await lifecycle.createPluginTestServer(budgetPlugin, {
    session: new FakeSession({ evaluate: app.evaluate }),
    allowEval,
    pluginConfigs: { budget: { windowMs: 250, ...pluginConfig } },
  })
  const dispatch = (name: string, args: Record<string, unknown> = {}) =>
    server.dispatcher.dispatch(name, args) as Promise<Record<string, unknown>>
  return { app, server, dispatch }
}

async function budgetFile(budget: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-budget-plugin-'))
  dirs.push(dir)
  const file = path.join(dir, 'perf-budget.json')
  await writeFile(file, typeof budget === 'string' ? budget : JSON.stringify(budget))
  await writeFile(path.join(dir, 'app.js'), 'x'.repeat(2048))
  return file
}

const BUDGET = {
  startup: { maxFirstWindowMs: 1000 },
  memory: { win32: { metric: 'privateBytes', perTypeMb: { main: 60, renderer: 60 } } },
  mainThread: { maxStallMs: 100 },
  ipc: { probe: 'window.api.ping()', maxP99Ms: 10 },
  bundle: { entries: [{ name: 'app', path: 'app.js', maxKb: 4 }] },
}

describe('memory collectors', () => {
  it('classifies Electron process types', () => {
    expect(['Browser', 'Tab', 'GPU', 'Utility', 'Zygote'].map(classifyProcess)).toEqual([
      'main',
      'renderer',
      'gpu',
      'utility',
      'other',
    ])
  })

  it('parses footprint JSON and smaps_rollup', () => {
    const footprint = JSON.stringify({
      'bytes per unit': 1,
      processes: [{ pid: 7, footprint: 1_048_576 }, { name: 'gone' }],
    })
    expect([...parseFootprintJson(footprint)]).toEqual([[7, 1_048_576]])
    expect(parseSmapsRollup('Rss:   900 kB\nPss:   512 kB\nPss_Anon: 1 kB\n')).toBe(524_288)
    expect(parseSmapsRollup('Rss: 900 kB\n')).toBeUndefined()
  })

  it('uses the OS reader per pid and reports a reader failure without guessing', async () => {
    const processes = [
      { pid: 1, type: 'Browser', workingSetKb: 2048 },
      { pid: 2, type: 'Tab', workingSetKb: 1024 },
    ]
    const read = await measureMemory(processes, 'darwin', async () => new Map([[1, 3_145_728]]))
    expect(read.memory).toEqual({
      metric: 'footprint',
      processes: [
        { pid: 1, type: 'main', mb: 3, workingSetMb: 2 },
        { pid: 2, type: 'renderer', workingSetMb: 1 },
      ],
    })
    const failed = await measureMemory(processes, 'linux', async () => {
      throw new Error('EACCES')
    })
    expect(failed.error).toMatch(/could not read pss: EACCES/)
    expect(failed.memory.processes.every((entry) => entry.mb === undefined)).toBe(true)
  })
})

describe('budget plugin', () => {
  it('advertises its version and hides the eval-gated tools without main eval', async () => {
    const withEval = await setup(true)
    const names = withEval.server.dispatcher.list().map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining(['budget_start', 'budget_measure', 'budget_check']),
    )
    expect(budgetPlugin.version).toBe(packageJson.version)

    const without = await setup(false)
    const visible = without.server.dispatcher.list().map((tool) => tool.name)
    expect(visible).toContain('budget_check')
    expect(visible).not.toContain('budget_measure')
    expect(visible).not.toContain('budget_start')
  })

  it('budget_measure runs an idle window and reports every metric with its unit', async () => {
    const { app, server, dispatch } = await setup()
    await lifecycle.launch(server)
    const result = await dispatch('budget_measure', { ipcProbe: 'window.api.ping()' })
    expect(result).toMatchObject({ ok: true, platform: 'win32', electron_version: '42.0.0' })
    expect(result['unavailable']).toBeUndefined()
    const measured = result['measured'] as { id: string; value: number; metric?: string }[]
    const find = (id: string, metric?: string) =>
      measured.find((row) => row.id === id && row.metric === metric)?.value
    expect(find('startup.firstWindowMs')).toBe(750)
    expect(find('memory.main', 'privateBytes')).toBe(50)
    expect(find('memory.main', 'workingSet')).toBe(100)
    expect(find('memory.totalWithoutGpu', 'privateBytes')).toBe(90)
    expect(find('ipc.p99Ms')).toBe(4)
    expect(app.calls.indexOf('main:start')).toBeGreaterThanOrEqual(0)
    expect(app.calls.indexOf('renderer:ipc-start')).toBeGreaterThan(app.calls.indexOf('main:start'))
  })

  it('budget_start opens the window that budget_check then closes', async () => {
    const { app, server, dispatch } = await setup()
    await lifecycle.launch(server)
    const budgetPath = await budgetFile(BUDGET)
    expect(await dispatch('budget_start', { budgetPath })).toMatchObject({
      ok: true,
      started: true,
      ipc_probe: true,
    })
    app.maxStallMs = 400
    const checked = await dispatch('budget_check', { budgetPath })
    expect(checked).toMatchObject({
      ok: true,
      passed: false,
      reason: 'OVER_BUDGET',
      summary: { pass: 5, fail: 1, unmeasured: 0 },
    })
    const results = checked['results'] as { id: string; status: string; actual?: number }[]
    expect(results.find((r) => r.status === 'fail')).toMatchObject({
      id: 'mainThread.maxStallMs',
      actual: 400,
    })
    // One window: started once, never restarted by the check.
    expect(app.calls.filter((call) => call === 'main:start')).toHaveLength(1)
  })

  it('budget_check passes within budget using the configured budget file', async () => {
    const budgetPath = await budgetFile(BUDGET)
    const { server, dispatch } = await setup(true, { budgetFile: budgetPath })
    await lifecycle.launch(server)
    expect(await dispatch('budget_check')).toMatchObject({
      ok: true,
      passed: true,
      budget_path: budgetPath,
      summary: { pass: 6, fail: 0, unmeasured: 0 },
    })
  })

  it('without main eval or a session only the bundle is checked', async () => {
    // With no app to ask, the run is attributed to the host platform.
    const budgetPath = await budgetFile({
      ...BUDGET,
      memory: {
        [process.platform]: { metric: 'workingSet', perTypeMb: { main: 60, renderer: 60 } },
      },
    })
    const { dispatch } = await setup(false)
    const checked = await dispatch('budget_check', { budgetPath })
    expect(checked).toMatchObject({ ok: true, passed: true, summary: { pass: 1, unmeasured: 5 } })
    const results = checked['results'] as { id: string; status: string; detail?: string }[]
    expect(results.find((r) => r.id === 'memory.main')?.detail).toMatch(/no app session/)
    expect(await dispatch('budget_check', { budgetPath, requireMeasurement: true })).toMatchObject({
      passed: false,
      reason: 'UNMEASURED',
    })
  })

  it('a main-only grant leaves the renderer metrics unmeasured with the reason', async () => {
    const { server, dispatch } = await setup({ main: true, renderer: false })
    await lifecycle.launch(server)
    const checked = await dispatch('budget_check', { budgetPath: await budgetFile(BUDGET) })
    const results = checked['results'] as { id: string; status: string; detail?: string }[]
    expect(results.find((r) => r.id === 'memory.main')?.status).toBe('pass')
    expect(results.find((r) => r.id === 'ipc.p99Ms')).toMatchObject({
      status: 'unmeasured',
      detail: expect.stringMatching(/renderer eval is off/),
    })
    expect(results.find((r) => r.id === 'startup.firstWindowMs')?.status).toBe('unmeasured')
  })

  it('reports a probe that does not start instead of an empty latency', async () => {
    const { app, server, dispatch } = await setup()
    await lifecycle.launch(server)
    app.probeFails = true
    const result = await dispatch('budget_measure', { ipcProbe: 'window.api.ping()' })
    expect((result['unavailable'] as Record<string, string>)['ipc']).toMatch(/did not start/)
  })

  it('names the missing capability on a transport without main or renderer eval', async () => {
    const noMain = await lifecycle.createPluginTestServer(budgetPlugin, {
      allowEval: true,
      capabilities: { ...fullCapabilities(), supportsMainEval: false },
    })
    await lifecycle.launch(noMain.server)
    const budgetPath = await budgetFile(BUDGET)
    expect(await noMain.server.dispatcher.dispatch('budget_measure', {})).toMatchObject({
      ok: false,
      code: 'budget.MAIN_EVAL_UNSUPPORTED',
    })
    const checked = (await noMain.server.dispatcher.dispatch('budget_check', {
      budgetPath,
    })) as unknown as { results: { id: string; status: string; detail?: string }[] }
    expect(checked.results.find((r) => r.id === 'mainThread.maxStallMs')).toMatchObject({
      status: 'unmeasured',
      detail: expect.stringMatching(/cannot evaluate in the main process/),
    })

    const app = fakeApp()
    const noRenderer = await lifecycle.createPluginTestServer(budgetPlugin, {
      allowEval: true,
      session: new FakeSession({ evaluate: app.evaluate }),
      capabilities: { ...fullCapabilities(), supportsRendererEval: false },
      pluginConfigs: { budget: { windowMs: 250 } },
    })
    await lifecycle.launch(noRenderer.server)
    const measured = (await noRenderer.server.dispatcher.dispatch('budget_measure', {
      ipcProbe: 'window.api.ping()',
    })) as unknown as { unavailable: Record<string, string> }
    expect(measured.unavailable['ipc']).toMatch(/cannot evaluate in the renderer/)
    expect(measured.unavailable['startup']).toMatch(/cannot evaluate in the renderer/)
    expect(app.calls).not.toContain('renderer:ipc-start')
  })

  it('holds the IPC probe to the eval blocklist', async () => {
    const { app, server, dispatch } = await setup()
    await lifecycle.launch(server)
    const result = await dispatch('budget_measure', { ipcProbe: "require('node:fs')" })
    expect((result['unavailable'] as Record<string, string>)['ipc']).toMatch(/refused/)
    expect(app.calls).not.toContain('renderer:ipc-start')
  })

  it('confines the budget file and bundle paths to --app-root', async () => {
    const budgetPath = await budgetFile({ bundle: { entries: [{ path: '../..', maxKb: 1 }] } })
    const appRoot = path.dirname(budgetPath)
    const { server } = await lifecycle.createPluginTestServer(budgetPlugin, { appRoot })
    const check = (file: string) =>
      server.dispatcher.dispatch('budget_check', { budgetPath: file }) as Promise<
        Record<string, unknown>
      >
    expect(await check(path.join(tmpdir(), 'elsewhere.json'))).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
    })
    // Inside the root, but its bundle entry climbs out of it.
    expect(await check(budgetPath)).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
  })

  it('refuses a bundle entry that is a symlink out of the root', async () => {
    const budgetPath = await budgetFile({ bundle: { entries: [{ path: 'link', maxKb: 1 }] } })
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'sw-budget-outside-'))
    dirs.push(outsideDir)
    await symlink(outsideDir, path.join(path.dirname(budgetPath), 'link'), 'junction')
    const { dispatch } = await setup()
    expect(await dispatch('budget_check', { budgetPath })).toMatchObject({
      ok: false,
      code: 'BAD_ARGUMENT',
    })
  })

  it('does not echo file content from an unparseable budget', async () => {
    const { dispatch } = await setup()
    const result = await dispatch('budget_check', { budgetPath: await budgetFile('secret-token') })
    expect(result).toMatchObject({ ok: false, code: 'budget.BUDGET_INVALID' })
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('maps budget file problems to registered errors', async () => {
    const { dispatch } = await setup()
    expect(await dispatch('budget_check')).toMatchObject({ ok: false, code: 'budget.NO_BUDGET' })
    expect(await dispatch('budget_check', { budgetPath: 'relative.json' })).toMatchObject({
      ok: false,
      code: 'ABSOLUTE_PATH_REQUIRED',
    })
    expect(
      await dispatch('budget_check', { budgetPath: path.join(tmpdir(), 'sw-nope', 'b.json') }),
    ).toMatchObject({ ok: false, code: 'budget.BUDGET_NOT_FOUND' })
    expect(
      await dispatch('budget_check', { budgetPath: await budgetFile({ startup: { typo: 1 } }) }),
    ).toMatchObject({ ok: false, code: 'budget.BUDGET_INVALID' })
    expect(await dispatch('budget_measure')).toMatchObject({ ok: false, code: 'NOT_RUNNING' })
  })
})
