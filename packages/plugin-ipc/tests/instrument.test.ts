/**
 * Unit tests for the IPC plugin (ADR-010): the pure plugin-side helpers (channel filtering and arg
 * redaction over captured events) AND the main-process shim's send/on capture path, exercised by
 * executing the real INSTRUMENT_BODY against a mock ipcMain (a Node EventEmitter) — no Electron. The
 * handle/invoke/stub paths are additionally covered by the e2e tests (simulated main) and the gated
 * real-Electron smoke.
 */

import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it } from 'vitest'

import { INSTRUMENT_BODY, filterEvents, redactEvents, type IpcEvent } from '../src/instrument.js'

function ev(channel: string, args: unknown[], type: 'invoke' | 'send' = 'invoke'): IpcEvent {
  return { channel, type, args, ok: true, ms: 0, ts: 0 }
}

describe('filterEvents', () => {
  const events = [ev('save', [1]), ev('open', [2]), ev('save', [3])]

  it('returns all events when no channel is given', () => {
    expect(filterEvents(events)).toHaveLength(3)
  })

  it('keeps only the named channel', () => {
    const result = filterEvents(events, 'save')
    expect(result).toHaveLength(2)
    expect(result.every((e) => e.channel === 'save')).toBe(true)
  })
})

describe('redactEvents', () => {
  it('returns events unchanged when no keys are configured', () => {
    const events = [ev('save', [{ token: 'x' }])]
    expect(redactEvents(events, [])).toEqual(events)
  })

  it('redacts named arg fields recursively', () => {
    const events = [ev('save', [{ token: 'secret', keep: 1, nested: { token: 'deep' } }])]
    const redacted = redactEvents(events, ['token'])
    expect(redacted[0]?.args[0]).toEqual({
      token: '[redacted]',
      keep: 1,
      nested: { token: '[redacted]' },
    })
    // The original is not mutated.
    expect((events[0]?.args[0] as { token: string }).token).toBe('secret')
  })
})

/**
 * The real INSTRUMENT_BODY is an async-function body (it `await`s in the invoke op) that mutates a
 * `globalThis.__swIpc` state. Build it once with the AsyncFunction constructor and run it against a
 * mock ipcMain so the send/on wrapping, pre-existing re-wrap, and detach-on-stop run for real.
 */
type ShimResult = Record<string, unknown>
const AsyncFunction = async function () {}.constructor as new (
  ...names: string[]
) => (electronApp: unknown, arg: unknown) => Promise<ShimResult>
const runShim = new AsyncFunction('electronApp', 'arg', INSTRUMENT_BODY)

/** A mock ipcMain: a real EventEmitter (on/removeListener/listeners/emit) plus a handle/invoke map. */
interface MockIpcMain extends EventEmitter {
  handle(channel: string, fn: (...a: unknown[]) => unknown): void
  removeHandler(channel: string): void
  _invokeHandlers: Map<string, (...a: unknown[]) => unknown>
}
function makeIpcMain(): MockIpcMain {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  const invokeHandlers = new Map<string, (...a: unknown[]) => unknown>()
  return Object.assign(emitter, {
    handle(channel: string, fn: (...a: unknown[]) => unknown) {
      invokeHandlers.set(channel, fn)
    },
    removeHandler(channel: string) {
      invokeHandlers.delete(channel)
    },
    _invokeHandlers: invokeHandlers,
  }) as MockIpcMain
}
function shim(ipcMain: MockIpcMain, arg: Record<string, unknown>): Promise<ShimResult> {
  return runShim({ ipcMain }, arg)
}

describe('INSTRUMENT_BODY send/on capture (real shim, mock ipcMain)', () => {
  afterEach(() => {
    delete (globalThis as { __swIpc?: unknown }).__swIpc
  })

  const fakeEvent = { sender: null, frameId: 0, processId: 0 }
  const install = { op: 'install', allow: ['ping'], captureSend: true, maxEvents: 1000 }

  it('records a send on a future on-listener and still forwards to the app', async () => {
    const ipcMain = makeIpcMain()
    const seen: unknown[] = []
    await shim(ipcMain, install)
    // Registered AFTER install -> goes through the patched ipcMain.on -> wrapped.
    ipcMain.on('ping', (_e: unknown, payload: unknown) => seen.push(payload))
    ipcMain.emit('ping', fakeEvent, { hello: 1 })

    expect(seen).toEqual([{ hello: 1 }])
    expect(await shim(ipcMain, { op: 'read' })).toMatchObject({
      events: [{ channel: 'ping', type: 'send', args: [{ hello: 1 }] }],
    })
  })

  it('re-wraps an on-listener registered BEFORE capture started', async () => {
    const ipcMain = makeIpcMain()
    const seen: unknown[] = []
    ipcMain.on('ping', (_e: unknown, payload: unknown) => seen.push(payload))
    await shim(ipcMain, install)
    ipcMain.emit('ping', fakeEvent, { pre: true })

    expect(seen).toEqual([{ pre: true }])
    expect(await shim(ipcMain, { op: 'read' })).toMatchObject({
      events: [{ channel: 'ping', type: 'send', args: [{ pre: true }] }],
    })
  })

  it('detaches wrappers and restores the original listener on stop, with no residue', async () => {
    const ipcMain = makeIpcMain()
    const calls: unknown[] = []
    const original = (_e: unknown, payload: unknown): number => calls.push(payload)
    ipcMain.on('ping', original)
    await shim(ipcMain, install)
    ipcMain.emit('ping', fakeEvent, 'during')
    await shim(ipcMain, { op: 'stop' })

    // The exact original listener is back (wrapper detached) and the app still works after stop.
    expect(ipcMain.listeners('ping')).toEqual([original])
    ipcMain.emit('ping', fakeEvent, 'after')
    expect(calls).toEqual(['during', 'after'])
    expect((globalThis as { __swIpc?: unknown }).__swIpc).toBeUndefined()
  })

  it('does not wrap or record on-listeners for non-allowlisted channels', async () => {
    const ipcMain = makeIpcMain()
    const seen: unknown[] = []
    await shim(ipcMain, install)
    ipcMain.on('other', (_e: unknown, p: unknown) => seen.push(p))
    ipcMain.emit('other', fakeEvent, 'x')

    expect(seen).toEqual(['x'])
    expect(await shim(ipcMain, { op: 'read' })).toMatchObject({ events: [] })
  })

  it('leaves a pre-existing once-listener one-shot (does not convert it to persistent)', async () => {
    const ipcMain = makeIpcMain()
    const calls: unknown[] = []
    ipcMain.once('ping', (_e: unknown, p: unknown) => calls.push(p))
    await shim(ipcMain, install)
    ipcMain.emit('ping', fakeEvent, 'first')
    ipcMain.emit('ping', fakeEvent, 'second')

    // Fired exactly once (one-shot semantics preserved); re-wrapping it as persistent would have run
    // it twice. It is intentionally not captured — transparency wins over capturing a rare case.
    expect(calls).toEqual(['first'])
    expect(await shim(ipcMain, { op: 'read' })).toMatchObject({ events: [] })
  })
})
