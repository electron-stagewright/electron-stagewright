/**
 * Unit tests for `electron_type_into_editor`'s replace option — the dogfooded
 * "replace editor contents" recipe: click the content area to focus, select all
 * against the ACTIVE element (no re-click that would collapse the selection),
 * then type over the selection; with empty text, clear via Delete.
 */

import process from 'node:process'

import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { typeIntoEditorTool } from '../src/tools/interaction/index.js'
import { FakeSession, FakeTransport, type FakeEvaluate } from './helpers/fake-transport.js'

const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A'

function setup(opts: { readonly evaluate?: FakeEvaluate } = {}) {
  const sessions = new SessionManager()
  const session = new FakeSession({
    id: 'sess',
    ...(opts.evaluate !== undefined ? { evaluate: opts.evaluate } : {}),
  })
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({ sessions, snapshots: new SnapshotStore() })
  dispatcher.register(typeIntoEditorTool)
  return { dispatcher, session }
}

describe('electron_type_into_editor replace', () => {
  it('selects all between the focusing click and the typing — never a second click', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_type_into_editor', {
      selector: '.view-lines',
      text: 'contenido nuevo',
      replace: true,
    })) as SuccessResponse & { typed: number; replaced: boolean }

    expect(res).toMatchObject({ ok: true, typed: 'contenido nuevo'.length, replaced: true })
    expect(session.interactions.map((i) => i.method)).toEqual(['click', 'press', 'typeText'])
    // The select-all targets the ACTIVE element (no selector/options) — a
    // re-targeted press would click again and collapse the selection.
    expect(session.interactions[1]?.args).toEqual([SELECT_ALL, undefined])
    expect(session.interactions[2]?.args[0]).toBe('contenido nuevo')
  })

  it('clears the editor (select-all + Delete) when replacing with empty text', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_type_into_editor', {
      selector: '.view-lines',
      text: '',
      replace: true,
    })) as SuccessResponse & { typed: number; replaced: boolean }

    expect(res).toMatchObject({ ok: true, typed: 0, replaced: true })
    expect(session.interactions.map((i) => i.method)).toEqual(['click', 'press', 'press'])
    expect(session.interactions[1]?.args[0]).toBe(SELECT_ALL)
    expect(session.interactions[2]?.args[0]).toBe('Delete')
  })

  it('reports TYPE_NO_EFFECT when empty replacement does not change a non-empty editor', async () => {
    const signatures = ['before text', 'before text']
    const { dispatcher, session } = setup({
      evaluate: async () => signatures.shift() ?? 'before text',
    })
    const res = (await dispatcher.dispatch('electron_type_into_editor', {
      selector: '.view-lines',
      text: '',
      replace: true,
    })) as ErrorResponse

    expect(res.ok).toBe(false)
    expect(res.code).toBe('TYPE_NO_EFFECT')
    expect(session.interactions.map((i) => i.method)).toEqual(['click', 'press', 'press'])
  })

  it('keeps the append behaviour (no select-all) without replace', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_type_into_editor', {
      selector: '.view-lines',
      text: 'appended',
    })) as SuccessResponse & { replaced: boolean }

    expect(res).toMatchObject({ ok: true, replaced: false })
    expect(session.interactions.map((i) => i.method)).toEqual(['click', 'typeText'])
  })
})
