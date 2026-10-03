import { createServer } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import { CdpConnection } from '../src/transports/cdp-connection.js'
import { CDPTransport } from '../src/transports/cdp.js'
import { InjectorTransport } from '../src/transports/injector.js'
import { FakeCdpServer, FakeSocket } from './helpers/fake-cdp.js'

const BROWSER_WS = 'ws://127.0.0.1:9222/devtools/browser/test'
const PAGE_WS = 'ws://127.0.0.1:9222/devtools/page/test'
const REMOTE_WS = 'ws://example.com:9222/devtools/browser/test'

describe('discovered transport endpoints', () => {
  it('rejects a remote browser endpoint before opening a socket', async () => {
    const server = new FakeCdpServer()
    const transport = new CDPTransport({
      wsFactory: server.factory,
      fetchJson: async () => ({ webSocketDebuggerUrl: REMOTE_WS }),
    })
    await expect(transport.attach({ port: 9222 })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' })
    expect(server.sockets).toHaveLength(0)
  })

  it('does not connect to remote page targets during attach or subsequent renderer calls', async () => {
    const server = new FakeCdpServer()
    const transport = new CDPTransport({
      wsFactory: server.factory,
      fetchJson: async (url) =>
        url.endsWith('/json/version')
          ? { webSocketDebuggerUrl: BROWSER_WS }
          : [{ id: 'test', type: 'page', webSocketDebuggerUrl: REMOTE_WS }],
    })
    const session = await transport.attach({ port: 9222 })
    try {
      await expect(session.evaluate('renderer', 'return 1')).rejects.toMatchObject({
        code: 'BAD_ARGUMENT',
      })
      expect(server.sockets.map((socket) => socket.url)).toEqual([BROWSER_WS])
    } finally {
      await session.detach()
    }
  })

  it.each(['attach', 'inject'] as const)(
    'rejects remote inspector discovery during %s',
    async (operation) => {
      const server = new FakeCdpServer()
      const transport = new InjectorTransport({
        wsFactory: server.factory,
        debugProcess: () => {},
        fetchJson: async () => [{ title: 'electron[4242]', webSocketDebuggerUrl: REMOTE_WS }],
      })
      const pending =
        operation === 'attach'
          ? transport.attach({ port: 9229, pid: 4242 })
          : transport.inject({ pid: 4242 })
      await expect(pending).rejects.toMatchObject({ code: 'BAD_ARGUMENT' })
      expect(server.sockets).toHaveLength(0)
    },
  )

  it.each([null, [], {}, 'invalid'])(
    'reports malformed browser discovery as a transport failure: %j',
    async (value) => {
      const transport = new CDPTransport({ fetchJson: async () => value })
      await expect(transport.attach({ port: 9222 })).rejects.toMatchObject({
        code: 'CDP_DISCONNECTED',
      })
    },
  )

  it.each([CDPTransport, InjectorTransport])(
    'does not follow discovery HTTP redirects for %s',
    async (Transport) => {
      const requests: string[] = []
      const server = createServer((request, response) => {
        requests.push(request.url ?? '')
        if (request.url === '/redirected') response.end('[]')
        else response.writeHead(302, { Location: '/redirected' }).end()
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      try {
        const address = server.address()
        if (address === null || typeof address === 'string')
          throw new Error('missing listener address')
        await expect(new Transport().attach({ port: address.port })).rejects.toThrow()
        expect(requests).toHaveLength(1)
        expect(requests).not.toContain('/redirected')
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    },
  )
})

describe('CDP protocol frame validation', () => {
  it.each([
    'null',
    '[]',
    'true',
    '42',
    '"text"',
    '{',
    '{"id":1,"error":null}',
    '{"id":1,"error":"invalid"}',
    '{"id":1,"error":{"message":1}}',
    '{"id":1,"error":{"code":"bad"}}',
  ])('ignores malformed frames without losing an outstanding request: %s', async (data) => {
    const server = new FakeCdpServer()
    const conn = await CdpConnection.open(BROWSER_WS, { factory: server.factory })
    server.neverReply('Runtime.evaluate')
    const pending = conn.send('Runtime.evaluate')
    void pending.catch(() => undefined)
    try {
      expect(() => server.sockets[0]?.fire('message', { data })).not.toThrow()
      server.sockets[0]?.fire('message', { data: JSON.stringify({ id: 1, result: { value: 42 } }) })
      await expect(pending).resolves.toEqual({ value: 42 })
    } finally {
      conn.close()
    }
  })

  it('does not deliver queued events after the connection closes', async () => {
    const server = new FakeCdpServer()
    const conn = await CdpConnection.open(BROWSER_WS, { factory: server.factory })
    const listener = vi.fn()
    conn.on('Runtime.consoleAPICalled', listener)
    conn.close()
    server.emit('browser', 'Runtime.consoleAPICalled', {})
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('inspector identity verification', () => {
  it.each(['attach', 'inject'] as const)(
    'verifies the connected pid after %s discovery',
    async (operation) => {
      const server = new FakeCdpServer()
      server.respond('Runtime.evaluate', () => ({ result: { value: 9999 } }))
      const transport = new InjectorTransport({
        wsFactory: server.factory,
        debugProcess: () => {},
        fetchJson: async () => [{ title: 'electron[4242]', webSocketDebuggerUrl: PAGE_WS }],
      })
      const pending =
        operation === 'attach'
          ? transport.attach({ port: 9229, pid: 4242 })
          : transport.inject({ pid: 4242 })
      const closeSpy = vi.spyOn(FakeSocket.prototype, 'close')
      try {
        await expect(pending).rejects.toMatchObject({ code: 'INJECT_FAILED' })
        expect(server.sent.every((frame) => frame.method !== 'Browser.close')).toBe(true)
        expect(closeSpy).toHaveBeenCalledTimes(1)
      } finally {
        closeSpy.mockRestore()
      }
    },
  )

  it('closes the inspector socket and reports INJECT_FAILED when the pid probe fails', async () => {
    const server = new FakeCdpServer()
    server.respond('Runtime.evaluate', () => {
      throw new Error('probe failed')
    })
    const transport = new InjectorTransport({
      wsFactory: server.factory,
      fetchJson: async () => [{ title: 'electron[4242]', webSocketDebuggerUrl: PAGE_WS }],
    })
    const closeSpy = vi.spyOn(FakeSocket.prototype, 'close')
    try {
      await expect(transport.attach({ port: 9229, pid: 4242 })).rejects.toMatchObject({
        code: 'INJECT_FAILED',
        details: { pid: 4242, cause: expect.stringContaining('probe failed') },
      })
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      closeSpy.mockRestore()
    }
  })
})
