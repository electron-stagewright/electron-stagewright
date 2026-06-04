/**
 * Unit tests for `electron_screenshot`. The renderer-bundle loader is mocked so
 * the element-clip path stays unit-fast; `FakeSession.screenshot` returns a
 * canned buffer and records the call so we can assert window targeting, clip, and
 * format. Captures are written to (and cleaned up from) the OS temp dir.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import { OBSERVE_TOOLS } from '../src/tools/observe/index.js'
import { FakeSession, FakeTransport, type FakeEvaluate } from './helpers/fake-transport.js'

vi.mock('../src/tools/snapshot/inject.js', () => ({
  buildProbeBody: () => 'PROBE',
  buildWalkBody: () => 'WALK',
  buildRetagBody: () => 'RETAG',
  loadInjectedWalker: () => 'BUNDLE',
}))

/** A minimal valid PNG header (signature + IHDR width/height) for dimension parsing. */
function pngBuffer(width: number, height: number): Buffer {
  const b = Buffer.alloc(24)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

function snap(html: string): Snapshot {
  return walkAccessibilityTree(new JSDOM(html).window.document, {})
}

const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

function setup(
  opts: { readonly evaluate?: FakeEvaluate; readonly screenshotResult?: Buffer } = {},
) {
  const sessions = new SessionManager()
  const session = new FakeSession({
    id: 'sess',
    ...(opts.evaluate !== undefined ? { evaluate: opts.evaluate } : {}),
    ...(opts.screenshotResult !== undefined ? { screenshotResult: opts.screenshotResult } : {}),
  })
  const snapshots = new SnapshotStore()
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.registerAll(OBSERVE_TOOLS)
  return { dispatcher, session, snapshots }
}

describe('electron_screenshot', () => {
  it('captures a window to the given absolute path and reports path/bytes/format/dimensions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-shot-'))
    created.push(dir)
    const out = path.join(dir, 'shot.png')
    const { dispatcher, session } = setup({ screenshotResult: pngBuffer(640, 480) })
    const res = (await dispatcher.dispatch('electron_screenshot', {
      path: out,
      fullPage: true,
    })) as SuccessResponse & {
      path: string
      bytes: number
      format: string
      width?: number
      height?: number
    }
    expect(res).toMatchObject({ ok: true, path: out, format: 'png', width: 640, height: 480 })
    expect(res.bytes).toBe(24)
    expect(await readFile(out)).toHaveLength(24)
    // Defaults to the active window; fullPage flows through.
    expect(session.screenshotCalls[0]?.target).toEqual({ kind: 'index', index: 0 })
    expect(session.screenshotCalls[0]?.opts).toMatchObject({ format: 'png', fullPage: true })
  })

  it('writes to a generated temp path when none is given', async () => {
    const { dispatcher } = setup({ screenshotResult: pngBuffer(10, 10) })
    const res = (await dispatcher.dispatch('electron_screenshot', {})) as SuccessResponse & {
      path: string
    }
    expect(path.isAbsolute(res.path)).toBe(true)
    created.push(res.path)
    expect(await readFile(res.path)).toHaveLength(24)
  })

  it('writes a generated filename into an explicit dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-shot-dir-'))
    created.push(dir)
    const { dispatcher } = setup({ screenshotResult: pngBuffer(10, 10) })
    const res = (await dispatcher.dispatch('electron_screenshot', { dir })) as SuccessResponse & {
      path: string
    }
    expect(path.dirname(res.path)).toBe(dir)
    expect(await readFile(res.path)).toHaveLength(24)
  })

  it('prefers an explicit dir over the server screenshotDir default', async () => {
    const serverDir = await mkdtemp(path.join(tmpdir(), 'sw-shot-server-'))
    const callDir = await mkdtemp(path.join(tmpdir(), 'sw-shot-call-'))
    created.push(serverDir, callDir)
    const sessions = new SessionManager()
    sessions.register(
      new FakeTransport(),
      new FakeSession({ id: 'sess', screenshotResult: pngBuffer(10, 10) }),
    )
    const dispatcher = new Dispatcher({
      sessions,
      snapshots: new SnapshotStore(),
      screenshotDir: serverDir,
    })
    dispatcher.registerAll(OBSERVE_TOOLS)
    const res = (await dispatcher.dispatch('electron_screenshot', {
      dir: callDir,
    })) as SuccessResponse & {
      path: string
    }
    expect(path.dirname(res.path)).toBe(callDir)
  })

  it('falls back to the server screenshotDir when no path/dir is given', async () => {
    const serverDir = await mkdtemp(path.join(tmpdir(), 'sw-shot-server-'))
    created.push(serverDir)
    const sessions = new SessionManager()
    sessions.register(
      new FakeTransport(),
      new FakeSession({ id: 'sess', screenshotResult: pngBuffer(10, 10) }),
    )
    const dispatcher = new Dispatcher({
      sessions,
      snapshots: new SnapshotStore(),
      screenshotDir: serverDir,
    })
    dispatcher.registerAll(OBSERVE_TOOLS)
    const res = (await dispatcher.dispatch('electron_screenshot', {})) as SuccessResponse & {
      path: string
    }
    expect(path.dirname(res.path)).toBe(serverDir)
  })

  it('resolves a relative server screenshotDir before returning generated paths', async () => {
    const serverDir = await mkdtemp(path.join(tmpdir(), 'sw-shot-server-relative-'))
    created.push(serverDir)
    const relativeServerDir = path.relative(process.cwd(), serverDir)
    const sessions = new SessionManager()
    sessions.register(
      new FakeTransport(),
      new FakeSession({ id: 'sess', screenshotResult: pngBuffer(10, 10) }),
    )
    const dispatcher = new Dispatcher({
      sessions,
      snapshots: new SnapshotStore(),
      screenshotDir: relativeServerDir,
    })
    dispatcher.registerAll(OBSERVE_TOOLS)
    const res = (await dispatcher.dispatch('electron_screenshot', {})) as SuccessResponse & {
      path: string
    }
    expect(path.isAbsolute(res.path)).toBe(true)
    expect(path.dirname(res.path)).toBe(path.resolve(relativeServerDir))
  })

  it('rejects a relative dir with ABSOLUTE_PATH_REQUIRED', async () => {
    const { dispatcher } = setup({ screenshotResult: pngBuffer(10, 10) })
    const res = (await dispatcher.dispatch('electron_screenshot', {
      dir: 'relative/dir',
    })) as ErrorResponse
    expect(res.code).toBe('ABSOLUTE_PATH_REQUIRED')
  })

  it('rejects path and dir supplied together with BAD_ARGUMENT', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-shot-both-'))
    created.push(dir)
    const { dispatcher } = setup({ screenshotResult: pngBuffer(10, 10) })
    const res = (await dispatcher.dispatch('electron_screenshot', {
      path: path.join(dir, 'a.png'),
      dir,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('rejects a relative path with ABSOLUTE_PATH_REQUIRED', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_screenshot', {
      path: 'relative/shot.png',
    })) as ErrorResponse
    expect(res.code).toBe('ABSOLUTE_PATH_REQUIRED')
  })

  it('captures a single element by clipping to its bounding box', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-shot-'))
    created.push(dir)
    const out = path.join(dir, 'el.png')
    const evaluate: FakeEvaluate = async () => ({
      found: true,
      bbox: { x: 5, y: 6, w: 100, h: 40 },
    })
    const { dispatcher, session } = setup({ evaluate, screenshotResult: pngBuffer(100, 40) })
    const res = (await dispatcher.dispatch('electron_screenshot', {
      selector: '#card',
      path: out,
    })) as SuccessResponse
    expect(res.ok).toBe(true)
    expect(session.screenshotCalls[0]?.opts?.clip).toEqual({ x: 5, y: 6, width: 100, height: 40 })
  })

  it('returns SELECTOR_NO_MATCH when the element to clip is not found', async () => {
    const { dispatcher } = setup({ evaluate: async () => ({ found: false }) })
    const res = (await dispatcher.dispatch('electron_screenshot', {
      selector: '#gone',
    })) as ErrorResponse
    expect(res.code).toBe('SELECTOR_NO_MATCH')
  })

  it('returns BAD_ARGUMENT for invalid element selectors', async () => {
    const { dispatcher, session } = setup({
      evaluate: async () => ({ found: false, invalid_selector: true, error: 'bad selector' }),
    })
    const res = (await dispatcher.dispatch('electron_screenshot', {
      selector: ':::',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(session.screenshotCalls).toHaveLength(0)
  })

  it('fails stale refs before running the element probe', async () => {
    const evaluateBodies: string[] = []
    const { dispatcher, session, snapshots } = setup({
      evaluate: async (_target, body) => {
        evaluateBodies.push(body)
        return { found: true, bbox: { x: 0, y: 0, w: 10, h: 10 } }
      },
    })
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_screenshot', {
      ref: 99,
    })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(evaluateBodies).toEqual(['WALK'])
    expect(session.screenshotCalls).toHaveLength(0)
  })

  it('rejects element capture options that only apply to window captures', async () => {
    const { dispatcher, session } = setup({
      evaluate: async () => ({ found: true, bbox: { x: 0, y: 0, w: 10, h: 10 } }),
    })
    const res = (await dispatcher.dispatch('electron_screenshot', {
      selector: '#card',
      fullPage: true,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(session.screenshotCalls).toHaveLength(0)
  })

  it('rejects element capture combined with explicit window targeting', async () => {
    // The element bbox probe runs on the active window, so a window-targeting arg
    // would clip the active window's coordinates onto a different window's image.
    const { dispatcher, session } = setup({
      evaluate: async () => ({ found: true, bbox: { x: 0, y: 0, w: 10, h: 10 } }),
    })
    const res = (await dispatcher.dispatch('electron_screenshot', {
      selector: '#card',
      windowIndex: 1,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(session.screenshotCalls).toHaveLength(0)
  })

  it('rejects png quality before calling the transport', async () => {
    const { dispatcher, session } = setup({ screenshotResult: pngBuffer(10, 10) })
    const res = (await dispatcher.dispatch('electron_screenshot', {
      quality: 80,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(session.screenshotCalls).toHaveLength(0)
  })

  it('requires a running session', async () => {
    const sessions = new SessionManager()
    const dispatcher = new Dispatcher({ sessions })
    dispatcher.registerAll(OBSERVE_TOOLS)
    const res = (await dispatcher.dispatch('electron_screenshot', {})) as ErrorResponse
    expect(res.code).toBe('NOT_RUNNING')
  })
})
