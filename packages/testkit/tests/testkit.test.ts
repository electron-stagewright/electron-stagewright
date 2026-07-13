import { describe, expect, it } from 'vitest'

import type { StagewrightPlugin } from '../../core/src/index.js'

import {
  connectMcpTestClient,
  createPluginTestServer,
  FULL_CAPABILITIES,
  fullCapabilities,
  TestLifecycle,
} from '../src/index.js'

describe('testkit', () => {
  it('creates independent full capability matrices', () => {
    const restricted = fullCapabilities({ canIntercept: false })

    expect(restricted).toMatchObject({ canIntercept: false, canLaunch: true })
    expect(FULL_CAPABILITIES).toMatchObject({ canIntercept: true, canLaunch: true })
  })

  it('tracks a fake server, launch fixture, and cleanup lifecycle', async () => {
    const lifecycle = new TestLifecycle()
    const { server, session, transport } = await lifecycle.createTestServer()
    try {
      const sessionId = await lifecycle.launch(server)
      expect(sessionId).toBe(session.id)
      expect(transport.launchCount).toBe(1)
    } finally {
      await lifecycle.cleanup()
    }

    expect(session.disposeCount).toBe(1)
  })

  it('loads one plugin through the shared server helper', async () => {
    const plugin = {
      name: 'testkit',
      version: '1.0.0',
      coreVersionRange: '*',
    } satisfies StagewrightPlugin
    const { server } = await createPluginTestServer(plugin)
    try {
      expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
        ok: true,
        plugins: [{ name: 'testkit', version: '1.0.0' }],
      })
    } finally {
      await server.close()
    }
  })

  it('connects an MCP client through the shared in-memory transport helper', async () => {
    const lifecycle = new TestLifecycle()
    const { server } = await lifecycle.createTestServer()
    const connection = await connectMcpTestClient(server)
    try {
      const listed = await connection.client.listTools()
      expect(listed.tools).toContainEqual(expect.objectContaining({ name: 'electron_launch' }))
    } finally {
      await connection.close()
      await lifecycle.cleanup()
    }
  })
})
