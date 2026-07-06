/**
 * Unit tests for `electron_drop_file` — dispatched against a recording
 * `FakeSession` whose evaluate seam plays the renderer side. Covers the
 * base64 file payload shipped into the renderer, MIME inference + override,
 * path validation (absolute/exists/caps), and the renderer-result mapping
 * (no-match → SELECTOR_NO_MATCH, default_prevented passthrough).
 *
 * The real DragEvent/DataTransfer dispatch path requires a Chromium renderer
 * (jsdom implements neither), so it is exercised by the gated real-Electron
 * smoke in `dropfile-smoke.test.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { dropFileTool } from '../src/tools/interaction/index.js'
import { FakeSession, FakeTransport, type FakeEvaluate } from './helpers/fake-transport.js'

let dir: string
let textPath: string
let jsonPath: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sw-dropfile-'))
  textPath = path.join(dir, 'notes.txt')
  jsonPath = path.join(dir, 'data.json')
  await writeFile(textPath, 'hola drop')
  await writeFile(jsonPath, '{"a":1}')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function setup(evaluate?: FakeEvaluate, opts: { appRoot?: string } = {}) {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const session = new FakeSession({
    id: 'sess',
    evaluate: evaluate ?? (async () => ({ ok: true, default_prevented: true })),
  })
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({
    sessions,
    snapshots,
    ...(opts.appRoot !== undefined ? { appRoot: opts.appRoot } : {}),
  })
  dispatcher.register(dropFileTool)
  return { dispatcher, session }
}

describe('electron_drop_file', () => {
  it('ships the file to the renderer as base64 with an inferred MIME type', async () => {
    const evals: { body: string; arg: unknown }[] = []
    const { dispatcher } = setup(async (_target, body, arg) => {
      evals.push({ body, arg })
      return { ok: true, default_prevented: true }
    })

    const res = (await dispatcher.dispatch('electron_drop_file', {
      selector: '#zone',
      paths: [textPath],
    })) as SuccessResponse & { target: string; files: number; default_prevented: boolean }

    expect(res).toMatchObject({ ok: true, target: '#zone', files: 1, default_prevented: true })
    const arg = evals[0]?.arg as {
      selector: string
      files: readonly { name: string; type: string; data: string }[]
    }
    expect(arg.selector).toBe('#zone')
    expect(arg.files).toHaveLength(1)
    expect(arg.files[0]).toMatchObject({ name: 'notes.txt', type: 'text/plain' })
    expect(Buffer.from(arg.files[0]?.data ?? '', 'base64').toString()).toBe('hola drop')
    // The renderer body dispatches the full drag sequence.
    expect(evals[0]?.body).toContain("fire('dragenter')")
    expect(evals[0]?.body).toContain("fire('dragover')")
    expect(evals[0]?.body).toContain("fire('drop')")
  })

  it('honours a mimeType override and infers per extension otherwise', async () => {
    const evals: unknown[] = []
    const { dispatcher } = setup(async (_t, _b, arg) => {
      evals.push(arg)
      return { ok: true, default_prevented: false }
    })

    await dispatcher.dispatch('electron_drop_file', { selector: '#z', paths: [jsonPath] })
    await dispatcher.dispatch('electron_drop_file', {
      selector: '#z',
      paths: [jsonPath],
      mimeType: 'application/x-custom',
    })

    const first = evals[0] as { files: readonly { type: string }[] }
    const second = evals[1] as { files: readonly { type: string }[] }
    expect(first.files[0]?.type).toBe('application/json')
    expect(second.files[0]?.type).toBe('application/x-custom')
  })

  it('reports default_prevented: false when no drop handler engaged', async () => {
    const { dispatcher } = setup(async () => ({ ok: true, default_prevented: false }))
    const res = (await dispatcher.dispatch('electron_drop_file', {
      selector: '#inert',
      paths: [textPath],
    })) as SuccessResponse & { default_prevented: boolean }
    expect(res.ok).toBe(true)
    expect(res.default_prevented).toBe(false)
  })

  it('rejects relative paths with ABSOLUTE_PATH_REQUIRED', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_drop_file', {
      selector: '#zone',
      paths: ['relative/notes.txt'],
    })) as ErrorResponse
    expect(res.ok).toBe(false)
    expect(res.code).toBe('ABSOLUTE_PATH_REQUIRED')
  })

  it('rejects missing files with FILE_NOT_FOUND', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_drop_file', {
      selector: '#zone',
      paths: [path.join(dir, 'missing.bin')],
    })) as ErrorResponse
    expect(res.ok).toBe(false)
    expect(res.code).toBe('FILE_NOT_FOUND')
  })

  it('maps a no-match renderer result to SELECTOR_NO_MATCH', async () => {
    const { dispatcher } = setup(async () => ({ ok: false, reason: 'no-match' }))
    const res = (await dispatcher.dispatch('electron_drop_file', {
      selector: '#gone',
      paths: [textPath],
    })) as ErrorResponse
    expect(res.ok).toBe(false)
    expect(res.code).toBe('SELECTOR_NO_MATCH')
  })

  it('maps a bad-selector renderer result to BAD_ARGUMENT', async () => {
    const { dispatcher } = setup(async () => ({ ok: false, reason: 'bad-selector' }))
    const res = (await dispatcher.dispatch('electron_drop_file', {
      selector: ':::nope',
      paths: [textPath],
    })) as ErrorResponse
    expect(res.ok).toBe(false)
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('rejects a path outside --app-root and never reads it', async () => {
    let evaluated = false
    // Confine to a sibling dir the fixtures do NOT live in, so textPath escapes it.
    const { dispatcher } = setup(
      async () => {
        evaluated = true
        return { ok: true, default_prevented: true }
      },
      { appRoot: path.join(dir, 'confined') },
    )
    const res = (await dispatcher.dispatch('electron_drop_file', {
      selector: '#zone',
      paths: [textPath],
    })) as ErrorResponse
    expect(res.ok).toBe(false)
    expect(res.code).toBe('BAD_ARGUMENT')
    expect(res.error).toMatch(/--app-root/)
    expect(evaluated).toBe(false)
  })

  it('allows a path inside --app-root', async () => {
    const { dispatcher } = setup(undefined, { appRoot: dir })
    const res = (await dispatcher.dispatch('electron_drop_file', {
      selector: '#zone',
      paths: [textPath],
    })) as SuccessResponse & { files: number }
    expect(res).toMatchObject({ ok: true, files: 1 })
  })
})
