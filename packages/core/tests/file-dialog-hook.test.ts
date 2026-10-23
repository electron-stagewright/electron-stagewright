/**
 * Unit tests for the native file-dialog bodies (ADR-019 amendment), run against a fake electron
 * `dialog` module: the hook passes through until armed, then answers each form from a FIFO queue,
 * cancels on an empty queue or a kind mismatch, and records what the app asked.
 */

import { describe, expect, it } from 'vitest'

import {
  ARM_FILE_DIALOGS_BODY,
  FILE_DIALOG_HOOK_BODY,
  FILE_DIALOG_STATE_BODY,
} from '../src/transports/native-instrumentation.js'
import type { FileDialogArmResult, FileDialogState } from '../src/transports/index.js'

function fakeApp() {
  const os: string[] = []
  const dialog: Record<string, (...args: unknown[]) => unknown> = {
    showOpenDialog: async () => (os.push('open'), { canceled: true, filePaths: [] }),
    showOpenDialogSync: () => (os.push('openSync'), undefined),
    showSaveDialog: async () => (os.push('save'), { canceled: true, filePath: '' }),
    showSaveDialogSync: () => (os.push('saveSync'), ''),
  }
  const electron = { dialog }
  const host: Record<string, unknown> = {}
  // Fixed in-repo bodies, run the way the launch transport runs them in main.
  const run = <T>(body: string, arg: unknown): T =>
    (new Function('electron', 'host', 'arg', body) as (e: unknown, h: unknown, a: unknown) => T)(
      electron,
      host,
      arg,
    )
  return {
    os,
    dialog,
    host,
    arm: (responses: unknown[], append = false) =>
      run<FileDialogArmResult | null>(ARM_FILE_DIALOGS_BODY, { responses, append }),
    state: (disarm = false) => run<FileDialogState>(FILE_DIALOG_STATE_BODY, { disarm }),
    installAtLaunch: () =>
      new Function('electron', 'host', 'phase', FILE_DIALOG_HOOK_BODY)(electron, host, 'launch'),
  }
}

const win = { getTitle: () => 'Lingua' }

describe('file-dialog bodies', () => {
  it('answers each form in order and records what the app asked', async () => {
    const app = fakeApp()
    expect(
      app.arm([
        { kind: 'open', paths: ['/data/a.sql', '/data/b.sql'] },
        { kind: 'save', path: '/out/export.csv' },
        { kind: 'open', paths: ['/data/c.sql'] },
        { kind: 'save', path: '/out/again.csv' },
      ]),
    ).toEqual({ pending: 4, hooked: 'arm' })

    await expect(
      app.dialog['showOpenDialog']?.(win, {
        title: 'Import',
        filters: [{ name: 'SQL', extensions: ['sql'] }],
        properties: ['openFile', 'multiSelections'],
        securityScopedBookmarks: true,
      }),
    ).resolves.toEqual({ canceled: false, filePaths: ['/data/a.sql', '/data/b.sql'] })
    await expect(app.dialog['showSaveDialog']?.({ defaultPath: 'export.csv' })).resolves.toEqual({
      canceled: false,
      filePath: '/out/export.csv',
    })
    expect(app.dialog['showOpenDialogSync']?.({})).toEqual(['/data/c.sql'])
    expect(app.dialog['showSaveDialogSync']?.(win, {})).toBe('/out/again.csv')
    expect(app.os).toEqual([])

    const state = app.state()
    expect(state).toMatchObject({ armed: true, pending: 0 })
    expect(state.events.map((event) => [event.kind, event.sync])).toEqual([
      ['open', false],
      ['save', false],
      ['open', true],
      ['save', true],
    ])
    expect(state.events[0]).toMatchObject({
      window: 'Lingua',
      options: {
        title: 'Import',
        filters: [{ name: 'SQL', extensions: ['sql'] }],
        properties: ['openFile', 'multiSelections'],
      },
      answer: { kind: 'open', paths: ['/data/a.sql', '/data/b.sql'] },
    })
    expect(state.events[0]?.options).not.toHaveProperty('securityScopedBookmarks')
    expect(state.events[0]).not.toHaveProperty('warning')
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })

  it('cancels on an empty queue, a queued cancel, and a kind mismatch that keeps the answer', async () => {
    const app = fakeApp()
    app.arm([{ kind: 'cancel' }, { kind: 'save', path: '/out/x.csv' }])
    await expect(app.dialog['showOpenDialog']?.({})).resolves.toEqual({
      canceled: true,
      filePaths: [],
    })
    // The next answer is a save: an open is cancelled and leaves it queued.
    expect(app.dialog['showOpenDialogSync']?.({})).toBeUndefined()
    expect(app.dialog['showSaveDialogSync']?.({})).toBe('/out/x.csv')
    await expect(app.dialog['showSaveDialog']?.({})).resolves.toEqual({
      canceled: true,
      filePath: '',
    })
    expect(app.state().events.map((event) => [event.answer.kind, event.reason])).toEqual([
      ['cancel', undefined],
      ['cancel', 'kind_mismatch'],
      ['save', undefined],
      ['cancel', 'queue_empty'],
    ])
  })

  it('passes through until armed and again after disarm', async () => {
    const app = fakeApp()
    app.installAtLaunch()
    await app.dialog['showOpenDialog']?.({})
    expect(app.os).toEqual(['open'])
    expect(app.state()).toEqual({ armed: false, pending: 0, events: [] })

    expect(app.arm([{ kind: 'save', path: '/out/x.csv' }])).toEqual({
      pending: 1,
      hooked: 'launch',
    })
    app.dialog['showOpenDialogSync']?.({})
    const disarmed = app.state(true)
    expect(disarmed).toMatchObject({ armed: false, pending: 1 })
    expect(disarmed.events).toHaveLength(1)
    app.dialog['showSaveDialogSync']?.({})
    expect(app.os).toEqual(['open', 'saveSync'])
    expect(app.state()).toEqual({ armed: false, pending: 0, events: [] })
  })

  it('replaces the queue and events on arm, or appends', () => {
    const app = fakeApp()
    app.arm([{ kind: 'cancel' }])
    app.dialog['showSaveDialogSync']?.({})
    expect(app.arm([{ kind: 'cancel' }], true)).toMatchObject({ pending: 1 })
    expect(app.state().events).toHaveLength(1)
    expect(app.arm([{ kind: 'cancel' }, { kind: 'cancel' }])).toMatchObject({ pending: 2 })
    expect(app.state().events).toHaveLength(0)
  })

  it('warns when several paths answer a single-selection open dialog', async () => {
    const app = fakeApp()
    app.arm([{ kind: 'open', paths: ['/data/a.sql', '/data/b.sql'] }])
    await app.dialog['showOpenDialog']?.({ properties: ['openFile'] })
    expect(app.state().events[0]).toMatchObject({ warning: 'multiple_paths' })
  })

  it('keeps a bounded event buffer', () => {
    const app = fakeApp()
    app.arm([])
    for (let i = 0; i < 205; i++) app.dialog['showSaveDialogSync']?.({ title: String(i) })
    const events = app.state().events
    expect(events).toHaveLength(200)
    expect(events[0]?.options.title).toBe('5')
  })

  it('is idempotent and answers null without a dialog module', () => {
    const app = fakeApp()
    app.installAtLaunch()
    const wrapped = app.dialog['showOpenDialog']
    app.arm([])
    expect(app.dialog['showOpenDialog']).toBe(wrapped)
    const bare = new Function('electron', 'host', 'arg', ARM_FILE_DIALOGS_BODY)(
      {},
      {},
      {
        responses: [],
        append: false,
      },
    )
    expect(bare).toBeNull()
  })
})
