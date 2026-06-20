/**
 * CDP transport network-seam tests (ADR-016) — capture over the Network domain, bodies over
 * Network.getResponseBody, and stubbing over the Fetch domain, all driven through the in-memory fake
 * CDP endpoint (no real Electron). Pure correlation/mapping helpers are tested directly; the live
 * event→buffer and Fetch→fulfill paths are exercised against a real CdpSession. The real-protocol
 * behaviour against a live app is the STAGEWRIGHT_E2E-gated cdp-attach-smoke.test.ts.
 */

import { describe, expect, it } from 'vitest'

import {
  applyResponse,
  buildFinishedEvent,
  buildRedirectEvent,
  mapAbortReason,
  mergeExtraInfoHeaders,
  startInflight,
  type CdpRequestWillBeSent,
  type InflightRequest,
} from '../src/transports/cdp-network.js'
import { CDPTransport, type FetchJson } from '../src/transports/cdp.js'
import { FakeCdpServer, type Json } from './helpers/fake-cdp.js'

const BROWSER_WS = 'ws://127.0.0.1:9222/devtools/browser/b1'
const PAGE_T1_WS = 'ws://127.0.0.1:9222/devtools/page/T1'
const PAGE_T2_WS = 'ws://127.0.0.1:9222/devtools/page/T2'

const T1: Json = {
  id: 'T1',
  type: 'page',
  title: 'Main',
  url: 'app://index.html',
  webSocketDebuggerUrl: PAGE_T1_WS,
}
const T2: Json = {
  id: 'T2',
  type: 'page',
  title: 'Second',
  url: 'app://second.html',
  webSocketDebuggerUrl: PAGE_T2_WS,
}

/** Let the fake server's queued frame responders + fire-and-forget event handlers settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(initialTargets: readonly Json[] = [T1]) {
  const server = new FakeCdpServer()
  let targets: readonly Json[] = initialTargets
  const fetchJson: FetchJson = async (url) => {
    if (url.endsWith('/json/version')) return { webSocketDebuggerUrl: BROWSER_WS }
    if (url.endsWith('/json/list')) return targets
    throw new Error(`unexpected discovery url ${url}`)
  }
  const transport = new CDPTransport({
    wsFactory: server.factory,
    fetchJson,
    killProcess: () => undefined,
    defaultMethodTimeoutMs: 250,
  })
  return {
    server,
    transport,
    setTargets: (next: readonly Json[]) => {
      targets = next
    },
  }
}

/** Emit a full finished request lifecycle (requestWillBeSent → responseReceived → loadingFinished). */
function emitFinished(
  server: FakeCdpServer,
  spec: {
    requestId?: string
    url: string
    method?: string
    type?: string
    requestHeaders?: Record<string, string>
    postData?: string
    hasPostData?: boolean
    status?: number
    responseHeaders?: Record<string, string>
    mimeType?: string
    startTime?: number
    endTime?: number
  },
): void {
  const requestId = spec.requestId ?? 'R1'
  server.emit('page/T1', 'Network.requestWillBeSent', {
    requestId,
    request: {
      url: spec.url,
      method: spec.method ?? 'GET',
      ...(spec.requestHeaders !== undefined ? { headers: spec.requestHeaders } : {}),
      ...(spec.postData !== undefined ? { postData: spec.postData } : {}),
      ...(spec.hasPostData !== undefined ? { hasPostData: spec.hasPostData } : {}),
    },
    ...(spec.type !== undefined ? { type: spec.type } : {}),
    timestamp: spec.startTime ?? 1,
  })
  server.emit('page/T1', 'Network.responseReceived', {
    requestId,
    response: {
      status: spec.status ?? 200,
      headers: spec.responseHeaders ?? {},
      ...(spec.mimeType !== undefined ? { mimeType: spec.mimeType } : {}),
    },
  })
  server.emit('page/T1', 'Network.loadingFinished', { requestId, timestamp: spec.endTime ?? 1 })
}

describe('cdp-network pure helpers', () => {
  const filter = { urls: ['/api/'] }

  it('startInflight matches the URL allowlist and reads the request half', () => {
    const params: CdpRequestWillBeSent = {
      requestId: 'R1',
      request: { url: 'https://app.test/api/x', method: 'POST', hasPostData: true },
      type: 'XHR',
      timestamp: 2,
    }
    const inflight = startInflight('T1', params, filter)
    expect(inflight).toMatchObject({
      windowId: 'T1',
      method: 'POST',
      url: 'https://app.test/api/x',
      resourceType: 'xhr',
      requestHasPostData: true,
      startTime: 2,
    })
    expect(
      startInflight(
        'T1',
        { ...params, request: { url: 'https://cdn/logo.png', method: 'GET' } },
        filter,
      ),
    ).toBeNull()
  })

  it('buildFinishedEvent assembles status/ok/duration and merges body fields', () => {
    const inflight: InflightRequest = {
      windowId: 'T1',
      method: 'GET',
      url: 'https://app.test/api/x',
      requestHasPostData: false,
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      startTime: 1,
    }
    const event = buildFinishedEvent(
      inflight,
      { requestId: 'R1', timestamp: 1.25 },
      { response: { responseBody: '{"a":1}', responseBodyBytes: 7 } },
      42,
    )
    expect(event).toMatchObject({
      method: 'GET',
      url: 'https://app.test/api/x',
      status: 200,
      ok: true,
      durationMs: 250,
      responseBody: '{"a":1}',
      responseBodyBytes: 7,
      timestamp: 42,
      windowId: 'T1',
    })
  })

  it('keeps responseReceivedExtraInfo headers when they arrive before responseReceived', () => {
    const inflight: InflightRequest = {
      windowId: 'T1',
      method: 'GET',
      url: 'https://app.test/api/x',
      requestHasPostData: false,
    }
    mergeExtraInfoHeaders(inflight, {
      requestId: 'R1',
      headers: { 'content-type': 'application/problem+json', 'set-cookie': 'sid=1' },
    })
    applyResponse(inflight, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-response': 'yes' },
      mimeType: 'application/json',
    })

    expect(inflight.responseHeaders).toEqual({
      'content-type': 'application/problem+json',
      'x-response': 'yes',
      'set-cookie': 'sid=1',
    })
    expect(inflight.responseContentType).toBe('application/problem+json')
  })

  it('buildRedirectEvent records the redirect hop from the redirectResponse', () => {
    const inflight: InflightRequest = {
      windowId: 'T1',
      method: 'GET',
      url: 'https://app.test/api/old',
      requestHasPostData: false,
    }
    const event = buildRedirectEvent(inflight, { status: 301, headers: { location: '/new' } }, 9)
    expect(event).toMatchObject({ status: 301, ok: false, responseHeaders: { location: '/new' } })
  })

  it('mapAbortReason maps known Playwright reasons to the CDP enum and defaults to Failed', () => {
    expect(mapAbortReason('failed')).toBe('Failed')
    expect(mapAbortReason('namenotresolved')).toBe('NameNotResolved')
    expect(mapAbortReason('timedout')).toBe('TimedOut')
    expect(mapAbortReason('connectionrefused')).toBe('ConnectionRefused')
    expect(mapAbortReason('not-a-real-reason')).toBe('Failed')
  })
})

describe('CdpSession network capture', () => {
  it('declares canIntercept and implements every seam method (no NOT_IMPLEMENTED trap)', async () => {
    const { transport } = setup()
    expect(transport.capabilities.canIntercept).toBe(true)
    const session = await transport.attach({ port: 9222 })
    // All five seam methods resolve — the honest-capability contract.
    await expect(session.startNetworkCapture({ urls: ['/api/'] })).resolves.toBeUndefined()
    await expect(session.networkEvents()).resolves.toMatchObject({ events: [], overflowed: 0 })
    await expect(
      session.stubNetwork({ urls: ['/api/'], fulfill: { status: 200 } }),
    ).resolves.toBeUndefined()
    await expect(session.clearNetworkStubs()).resolves.toBeUndefined()
    await expect(session.stopNetworkCapture()).resolves.toBeUndefined()
  })

  it('captures a matching finished request and enables the Network domain on arm', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'] })
    expect(server.sentTo('page/T1', 'Network.enable')).toHaveLength(1)

    emitFinished(server, {
      url: 'https://app.test/api/items',
      type: 'Fetch',
      status: 200,
      requestHeaders: { accept: 'application/json' },
      responseHeaders: { 'content-type': 'application/json' },
      startTime: 1,
      endTime: 1.017,
    })
    emitFinished(server, { requestId: 'R2', url: 'https://cdn.test/logo.png', status: 200 })
    await flush()

    const { events } = await session.networkEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      method: 'GET',
      url: 'https://app.test/api/items',
      resourceType: 'fetch',
      status: 200,
      ok: true,
      requestHeaders: { accept: 'application/json' },
      responseHeaders: { 'content-type': 'application/json' },
      durationMs: 17,
    })
  })

  it('records a failed request with its failure text and no status', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'] })
    server.emit('page/T1', 'Network.requestWillBeSent', {
      requestId: 'R1',
      request: { url: 'https://app.test/api/save', method: 'POST' },
      timestamp: 1,
    })
    server.emit('page/T1', 'Network.loadingFailed', {
      requestId: 'R1',
      errorText: 'net::ERR_ABORTED',
      timestamp: 1,
    })
    await flush()
    const { events } = await session.networkEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ method: 'POST', failure: 'net::ERR_ABORTED' })
    expect(events[0]?.status).toBeUndefined()
  })

  it('restricts capture to the named methods', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'], methods: ['POST'] })
    emitFinished(server, {
      requestId: 'A',
      url: 'https://app.test/api/x',
      method: 'GET',
      status: 200,
    })
    emitFinished(server, {
      requestId: 'B',
      url: 'https://app.test/api/x',
      method: 'POST',
      status: 201,
    })
    await flush()
    expect((await session.networkEvents()).events.map((e) => e.method)).toEqual(['POST'])
  })

  it('records nothing until armed, and stop disarms and clears', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    emitFinished(server, { url: 'https://app.test/api/early', status: 200 })
    await flush()
    expect((await session.networkEvents()).events).toHaveLength(0)

    await session.startNetworkCapture({ urls: ['/api/'] })
    emitFinished(server, { requestId: 'R2', url: 'https://app.test/api/live', status: 200 })
    await flush()
    expect((await session.networkEvents()).events).toHaveLength(1)

    await session.stopNetworkCapture()
    expect(server.sentTo('page/T1', 'Network.disable')).toHaveLength(1)
    expect((await session.networkEvents()).events).toHaveLength(0)
    emitFinished(server, { requestId: 'R3', url: 'https://app.test/api/after', status: 200 })
    await flush()
    expect((await session.networkEvents()).events).toHaveLength(0)
  })

  it('flushes the buffer when clear is passed and rejects after dispose', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'] })
    emitFinished(server, { url: 'https://app.test/api/a', status: 200 })
    await flush()
    expect((await session.networkEvents({ clear: true })).events).toHaveLength(1)
    expect((await session.networkEvents()).events).toHaveLength(0)
    await session.dispose()
    await expect(session.networkEvents()).rejects.toMatchObject({ code: 'NOT_RUNNING' })
  })

  it('enables the Network domain on a window opened AFTER capture is armed', async () => {
    const { server, transport, setTargets } = setup([T1])
    server.respond('Page.captureScreenshot', () => ({ data: Buffer.from('x').toString('base64') }))
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'] })
    // A second window appears; opening its connection (via a screenshot) must catch it up.
    setTargets([T1, T2])
    await session.screenshot({ kind: 'index', index: 1 })
    expect(server.sentTo('page/T2', 'Network.enable')).toHaveLength(1)
    emitFinished2(server, 'https://app.test/api/second')
    await flush()
    expect((await session.networkEvents()).events.map((e) => e.url)).toContain(
      'https://app.test/api/second',
    )
  })

  it('keeps responseReceivedExtraInfo raw headers even when they precede responseReceived', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'] })
    server.emit('page/T1', 'Network.requestWillBeSent', {
      requestId: 'R1',
      request: { url: 'https://app.test/api/x', method: 'GET' },
      timestamp: 1,
    })
    // extraInfo (the raw wire headers) arrives BEFORE responseReceived — the common CDP ordering. The
    // x-raw header it carries must survive the later (parsed) responseReceived, not be overwritten.
    server.emit('page/T1', 'Network.responseReceivedExtraInfo', {
      requestId: 'R1',
      headers: { 'x-raw': '1', 'content-type': 'application/json' },
    })
    server.emit('page/T1', 'Network.responseReceived', {
      requestId: 'R1',
      response: { status: 200, headers: { 'content-type': 'application/json' } },
    })
    server.emit('page/T1', 'Network.loadingFinished', { requestId: 'R1', timestamp: 1 })
    await flush()
    const [event] = (await session.networkEvents()).events
    expect(event?.responseHeaders).toMatchObject({
      'x-raw': '1',
      'content-type': 'application/json',
    })
  })
})

/** Emit a finished request on the T2 page target. */
function emitFinished2(server: FakeCdpServer, url: string): void {
  server.emit('page/T2', 'Network.requestWillBeSent', {
    requestId: 'S1',
    request: { url, method: 'GET' },
    timestamp: 1,
  })
  server.emit('page/T2', 'Network.responseReceived', {
    requestId: 'S1',
    response: { status: 200, headers: {} },
  })
  server.emit('page/T2', 'Network.loadingFinished', { requestId: 'S1', timestamp: 1 })
}

describe('CdpSession network body capture', () => {
  it('captures request and response bodies when captureBodies is on (text content type)', async () => {
    const { server, transport } = setup()
    server.respond('Network.getResponseBody', () => ({ body: '{"ok":true}', base64Encoded: false }))
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true })
    emitFinished(server, {
      url: 'https://app.test/api/save',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json' },
      postData: '{"name":"ada"}',
      responseHeaders: { 'content-type': 'application/json' },
    })
    await flush()
    const [event] = (await session.networkEvents()).events
    expect(event).toMatchObject({
      requestBody: '{"name":"ada"}',
      requestBodyBytes: 14,
      responseBody: '{"ok":true}',
      responseBodyBytes: 11,
    })
  })

  it('decodes a base64 response body and truncates to maxBodyBytes', async () => {
    const { server, transport } = setup()
    server.respond('Network.getResponseBody', () => ({
      body: Buffer.from('abcdefgh', 'utf8').toString('base64'),
      base64Encoded: true,
    }))
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true, maxBodyBytes: 4 })
    emitFinished(server, {
      url: 'https://app.test/api/big',
      responseHeaders: { 'content-type': 'text/plain' },
    })
    await flush()
    const [event] = (await session.networkEvents()).events
    expect(event?.responseBodyBytes).toBe(8)
    expect(event?.responseBodyTruncated).toBe(true)
    expect(event?.responseBody).toBe('abcd…[+4 bytes truncated]')
  })

  it('records only the byte length in size mode and skips a non-text content type', async () => {
    const { server, transport } = setup()
    server.respond('Network.getResponseBody', () => ({ body: '[1,2,3]', base64Encoded: false }))
    const session = await transport.attach({ port: 9222 })
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: 'size' })
    emitFinished(server, {
      requestId: 'J',
      url: 'https://app.test/api/json',
      responseHeaders: { 'content-type': 'application/json' },
    })
    emitFinished(server, {
      requestId: 'P',
      url: 'https://app.test/api/logo',
      responseHeaders: { 'content-type': 'image/png' },
    })
    await flush()
    const events = (await session.networkEvents()).events
    const json = events.find((e) => e.url.endsWith('/json'))
    const png = events.find((e) => e.url.endsWith('/logo'))
    expect(json?.responseBodyBytes).toBe(7)
    expect(json?.responseBody).toBeUndefined()
    expect(png?.responseBodyBytes).toBeUndefined()
  })

  it('drops an event whose body read finishes after stop (no ghost event)', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    // The getResponseBody responder stops capture before returning, exercising the post-body-await
    // filter re-check so the resolved event never lands in the cleared buffer.
    server.respond('Network.getResponseBody', () => {
      void session.stopNetworkCapture()
      return { body: '{"a":1}', base64Encoded: false }
    })
    await session.startNetworkCapture({ urls: ['/api/'], captureBodies: true })
    emitFinished(server, {
      url: 'https://app.test/api/inflight',
      responseHeaders: { 'content-type': 'application/json' },
    })
    await flush()
    expect((await session.networkEvents()).events).toHaveLength(0)
  })
})

describe('CdpSession network stubbing', () => {
  it('fulfills a matching request over the Fetch domain', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.stubNetwork({
      urls: ['/api/save'],
      fulfill: { status: 503, contentType: 'application/json', body: '{"down":true}' },
    })
    expect(server.sentTo('page/T1', 'Fetch.enable')).toHaveLength(1)
    server.emit('page/T1', 'Fetch.requestPaused', {
      requestId: 'F1',
      request: { url: 'https://app.test/api/save', method: 'GET' },
    })
    await flush()
    const fulfilled = server.sentTo('page/T1', 'Fetch.fulfillRequest')
    expect(fulfilled).toHaveLength(1)
    expect(fulfilled[0]?.params).toMatchObject({ requestId: 'F1', responseCode: 503 })
    expect(fulfilled[0]?.params?.['body']).toBe(
      Buffer.from('{"down":true}', 'utf8').toString('base64'),
    )
  })

  it('aborts with the mapped CDP errorReason', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.stubNetwork({ urls: ['/api/'], abort: 'namenotresolved' })
    server.emit('page/T1', 'Fetch.requestPaused', {
      requestId: 'F1',
      request: { url: 'https://app.test/api/x', method: 'GET' },
    })
    await flush()
    const failed = server.sentTo('page/T1', 'Fetch.failRequest')
    expect(failed[0]?.params).toMatchObject({ requestId: 'F1', errorReason: 'NameNotResolved' })
  })

  it('continues a non-matching request and expires a stub after times uses', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.stubNetwork({ urls: ['/api/once'], fulfill: { status: 200 }, times: 1 })
    // Non-matching → continue.
    server.emit('page/T1', 'Fetch.requestPaused', {
      requestId: 'A',
      request: { url: 'https://app.test/other', method: 'GET' },
    })
    await flush()
    expect(server.sentTo('page/T1', 'Fetch.continueRequest')).toHaveLength(1)
    // First match → fulfill; the times:1 stub then expires.
    server.emit('page/T1', 'Fetch.requestPaused', {
      requestId: 'B',
      request: { url: 'https://app.test/api/once', method: 'GET' },
    })
    await flush()
    expect(server.sentTo('page/T1', 'Fetch.fulfillRequest')).toHaveLength(1)
    // Second match → no stub remains → continue.
    server.emit('page/T1', 'Fetch.requestPaused', {
      requestId: 'C',
      request: { url: 'https://app.test/api/once', method: 'GET' },
    })
    await flush()
    expect(server.sentTo('page/T1', 'Fetch.continueRequest')).toHaveLength(2)
  })

  it('disables Fetch when the last stub clears', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.stubNetwork({ urls: ['/api/a'], fulfill: { status: 201 } })
    await session.stubNetwork({ urls: ['/api/b'], fulfill: { status: 202 } })
    await session.clearNetworkStubs('/api/a')
    expect(server.sentTo('page/T1', 'Fetch.disable')).toHaveLength(0)
    await session.clearNetworkStubs()
    expect(server.sentTo('page/T1', 'Fetch.disable')).toHaveLength(1)
  })

  it('disables Fetch when a times-limited stub expires through use (auto-disarm)', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.stubNetwork({ urls: ['/api/once'], fulfill: { status: 200 }, times: 1 })
    server.emit('page/T1', 'Fetch.requestPaused', {
      requestId: 'B',
      request: { url: 'https://app.test/api/once', method: 'GET' },
    })
    await flush()
    await flush()
    // The last finite-use stub was consumed, so the interceptor disarms without an explicit unstub.
    expect(server.sentTo('page/T1', 'Fetch.fulfillRequest')).toHaveLength(1)
    expect(server.sentTo('page/T1', 'Fetch.disable')).toHaveLength(1)
  })

  it('does not emit a duplicate content-type when both contentType and a header are set', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.stubNetwork({
      urls: ['/api/'],
      fulfill: { contentType: 'text/plain', headers: { 'content-type': 'application/json' } },
    })
    server.emit('page/T1', 'Fetch.requestPaused', {
      requestId: 'F1',
      request: { url: 'https://app.test/api/x', method: 'GET' },
    })
    await flush()
    const fulfilled = server.sentTo('page/T1', 'Fetch.fulfillRequest')[0]
    const headers = (fulfilled?.params?.['responseHeaders'] ?? []) as {
      name: string
      value: string
    }[]
    const contentTypes = headers.filter((h) => h.name.toLowerCase() === 'content-type')
    expect(contentTypes).toHaveLength(1)
    expect(contentTypes[0]?.value).toBe('application/json')
  })
})

describe('CdpSession clock seam (honest-false)', () => {
  it('declares canControlClock false and rejects the clock seam with NOT_IMPLEMENTED', async () => {
    const { transport } = setup()
    expect(transport.capabilities.canControlClock).toBe(false)
    const session = await transport.attach({ port: 9222 })
    await expect(session.installClock()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(session.advanceClock(1000)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(session.resumeClock()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
  })
})

describe('CdpSession native-UI seam (honest-false)', () => {
  it('declares canAccessNativeUI false and rejects getApplicationMenu with NOT_IMPLEMENTED', async () => {
    const { transport } = setup()
    // The application menu lives in the Electron main-process Node context, unreachable over the CDP
    // browser-target evaluate, so the capability stays honestly false (not an aspirational true).
    expect(transport.capabilities.canAccessNativeUI).toBe(false)
    const session = await transport.attach({ port: 9222 })
    await expect(session.getApplicationMenu()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(session.invokeApplicationMenuItem(['File', 'Save'])).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    })
  })
})

describe('CdpSession storage seam (honest-true)', () => {
  it('declares canAccessStorage true and implements every seam method (no NOT_IMPLEMENTED trap)', async () => {
    const { server, transport } = setup()
    expect(transport.capabilities.canAccessStorage).toBe(true)
    server.respond('Storage.getCookies', () => ({ cookies: [] }))
    const session = await transport.attach({ port: 9222 })
    await expect(session.getCookies()).resolves.toEqual([])
    await expect(
      session.setCookie({ name: 'a', value: 'b', url: 'https://x.test' }),
    ).resolves.toBeUndefined()
    await expect(session.clearCookies()).resolves.toBeUndefined()
    await expect(session.storageSnapshot()).resolves.toMatchObject({ cookies: [] })
  })

  it('reads unfiltered cookies over Storage.getCookies, drops the -1 session sentinel, applies the name filter', async () => {
    const { server, transport } = setup()
    server.respond('Storage.getCookies', () => ({
      cookies: [
        { name: 'auth', value: 'a', domain: 'app.test', path: '/', expires: -1 },
        { name: 'theme', value: 'dark', domain: 'app.test', path: '/', expires: 1893456000 },
      ],
    }))
    const session = await transport.attach({ port: 9222 })
    const all = await session.getCookies()
    expect(all).toHaveLength(2)
    // expires: -1 (session sentinel) is dropped; a real expiry survives.
    expect(all[0]).toEqual({ name: 'auth', value: 'a', domain: 'app.test', path: '/' })
    expect(all[1]).toMatchObject({ expires: 1893456000 })
    expect(await session.getCookies({ name: 'theme' })).toHaveLength(1)
    expect(server.sentTo('browser', 'Storage.getCookies')).toHaveLength(2)
  })

  it('passes urls through to Network.getCookies', async () => {
    const { server, transport } = setup()
    server.respond('Network.getCookies', () => ({ cookies: [] }))
    const session = await transport.attach({ port: 9222 })
    await session.getCookies({ urls: ['https://app.test'] })
    expect(server.sentTo('page/T1', 'Network.getCookies').at(-1)?.params).toEqual({
      urls: ['https://app.test'],
    })
  })

  it('sets a cookie over Network.setCookie', async () => {
    const { server, transport } = setup()
    server.respond('Network.setCookie', () => ({ success: true }))
    const session = await transport.attach({ port: 9222 })
    await session.setCookie({ name: 'auth', value: 'tok', url: 'https://app.test' })
    expect(server.sentTo('page/T1', 'Network.setCookie').at(-1)?.params).toMatchObject({
      name: 'auth',
      value: 'tok',
      url: 'https://app.test',
    })
  })

  it('clears all cookies over Network.clearBrowserCookies', async () => {
    const { server, transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await session.clearCookies()
    expect(server.sentTo('page/T1', 'Network.clearBrowserCookies')).toHaveLength(1)
  })

  it('deletes each matching cookie precisely over Network.deleteCookies for a filtered clear', async () => {
    const { server, transport } = setup()
    server.respond('Storage.getCookies', () => ({
      cookies: [{ name: 'auth', value: 'a', domain: 'app.test', path: '/' }],
    }))
    const session = await transport.attach({ port: 9222 })
    await session.clearCookies({ name: 'auth' })
    expect(server.sentTo('page/T1', 'Network.deleteCookies').at(-1)?.params).toEqual({
      name: 'auth',
      domain: 'app.test',
      path: '/',
    })
  })

  it('snapshots cookies plus best-effort localStorage via the DOMStorage domain', async () => {
    const { server, transport } = setup([{ ...T1, url: 'https://app.test/index.html' }])
    server.respond('Storage.getCookies', () => ({
      cookies: [{ name: 'auth', value: 'a', domain: 'app.test' }],
    }))
    server.respond('DOMStorage.getDOMStorageItems', () => ({ entries: [['cart', '3-items']] }))
    const session = await transport.attach({ port: 9222 })
    const snap = await session.storageSnapshot()
    expect(snap.cookies).toEqual([{ name: 'auth', value: 'a', domain: 'app.test' }])
    expect(snap.origins).toEqual([
      { origin: 'https://app.test', localStorage: [{ name: 'cart', value: '3-items' }] },
    ])
  })

  it('still returns the cookies when the localStorage read fails (best-effort)', async () => {
    const { server, transport } = setup([{ ...T1, url: 'https://app.test/index.html' }])
    server.respond('Storage.getCookies', () => ({ cookies: [{ name: 'auth', value: 'a' }] }))
    server.respond('DOMStorage.getDOMStorageItems', () => {
      throw new Error('DOMStorage disabled')
    })
    const session = await transport.attach({ port: 9222 })
    const snap = await session.storageSnapshot()
    expect(snap.cookies).toEqual([{ name: 'auth', value: 'a' }])
    expect(snap.origins).toEqual([])
  })

  it('falls back to Network.getCookies when Storage.getCookies is unavailable', async () => {
    const { server, transport } = setup()
    server.respond('Storage.getCookies', () => {
      throw new Error('Storage domain unavailable')
    })
    server.respond('Network.getCookies', () => ({
      cookies: [{ name: 'auth', value: 'a', domain: 'app.test' }],
    }))
    const session = await transport.attach({ port: 9222 })
    await expect(session.getCookies()).resolves.toEqual([
      { name: 'auth', value: 'a', domain: 'app.test' },
    ])
    expect(server.sentTo('browser', 'Storage.getCookies')).toHaveLength(1)
    expect(server.sentTo('page/T1', 'Network.getCookies')).toHaveLength(1)
  })
})
