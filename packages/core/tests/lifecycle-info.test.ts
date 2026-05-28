/**
 * Unit tests for the `electron_info` lifecycle tool, driven through the
 * dispatcher against a fake session. Covers the happy path, the no-session
 * error, signature inspection (injected for determinism across platforms), and
 * the wire-serialisability invariant (the response must round-trip through JSON).
 */

import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { makeInfoTool } from '../src/tools/lifecycle/info.js'
import type { SignatureInfo } from '../src/tools/lifecycle/signature.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

const RAW_INFO = {
  electron: '32.1.0',
  node: '20.18.0',
  chrome: '128.0.0',
  v8: '12.8',
  app_name: 'Demo',
  app_version: '1.2.3',
  app_path: '/Applications/Demo.app/Contents/Resources/app',
  exe_path: '/Applications/Demo.app/Contents/MacOS/Demo',
  user_data_path: '/Users/x/Library/Application Support/Demo',
  packaged: true,
}

function setup(
  signature: SignatureInfo = { status: 'signed' },
  rawInfo: typeof RAW_INFO = RAW_INFO,
  inspectSignature: (targetPath: string) => Promise<SignatureInfo> = async () => signature,
) {
  const sessions = new SessionManager()
  const transport = new FakeTransport({
    session: new FakeSession({ id: 'sess-info', evaluate: async () => rawInfo }),
  })
  const dispatcher = new Dispatcher({ sessions })
  dispatcher.register(makeInfoTool({ inspectSignature }))
  return { sessions, transport, dispatcher }
}

describe('electron_info', () => {
  it('reports versions, app paths, signature, transport, and capabilities', async () => {
    const { sessions, transport, dispatcher } = setup({ status: 'signed' })
    sessions.register(transport, transport.session)

    const res = await dispatcher.dispatch('electron_info', {})
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({
      ok: true,
      session_id: 'sess-info',
      transport: 'playwright-electron',
      versions: { electron: '32.1.0', node: '20.18.0' },
      app: { name: 'Demo', version: '1.2.3', packaged: true },
      signature: { status: 'signed' },
    })
    expect((res as SuccessResponse & { capabilities: unknown }).capabilities).toMatchObject({
      canLaunch: true,
    })
    expect((res as SuccessResponse)._meta.session_id).toBe('sess-info')
  })

  it('returns NOT_RUNNING when no session is live', async () => {
    const { dispatcher } = setup()
    const res = await dispatcher.dispatch('electron_info', {})
    expect(res.ok).toBe(false)
    expect((res as ErrorResponse).code).toBe('NOT_RUNNING')
  })

  it('surfaces an unsigned signature without throwing', async () => {
    const { sessions, transport, dispatcher } = setup({
      status: 'unsigned',
      detail: 'code object is not signed at all',
    })
    sessions.register(transport, transport.session)
    const res = await dispatcher.dispatch('electron_info', {})
    expect(res).toMatchObject({ ok: true, signature: { status: 'unsigned' } })
  })

  it('does not inspect a signature for unpackaged development apps', async () => {
    let inspectCalls = 0
    const { sessions, transport, dispatcher } = setup(
      { status: 'signed' },
      { ...RAW_INFO, packaged: false },
      async () => {
        inspectCalls += 1
        return { status: 'signed' }
      },
    )
    sessions.register(transport, transport.session)

    const res = await dispatcher.dispatch('electron_info', {})
    expect(res).toMatchObject({
      ok: true,
      app: { packaged: false },
      signature: { status: 'unknown' },
    })
    expect(inspectCalls).toBe(0)
  })

  it('produces a response that round-trips through JSON (wire-serialisable)', async () => {
    const { sessions, transport, dispatcher } = setup()
    sessions.register(transport, transport.session)
    const res = await dispatcher.dispatch('electron_info', {})
    const roundTripped = JSON.parse(JSON.stringify(res))
    expect(roundTripped).toEqual(res)
  })
})
