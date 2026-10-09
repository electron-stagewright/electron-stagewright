import { afterEach, describe, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(options: Record<string, unknown>) {
      capture.options = options
    }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async callTool(): Promise<unknown> {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, session_id: 'fixture', matches: [{ ref: 1 }] }),
          },
        ],
      }
    }
  },
}))

import { FORWARDED_RUNTIME_ENV, runFixture } from '../../../examples/framework-matrix/harness.js'

afterEach(() => {
  vi.unstubAllEnvs()
  capture.options = undefined
})

describe('framework matrix runtime environment', () => {
  it('passes existing display and runtime configuration to the MCP child', async () => {
    vi.stubEnv('DISPLAY', ':123')
    vi.stubEnv('XAUTHORITY', '/tmp/fixture.Xauthority')
    vi.stubEnv('ELECTRON_DISABLE_SANDBOX', '1')
    vi.stubEnv('ELECTRON_OVERRIDE_DIST_PATH', '/tmp/provisioned-electron')
    const result = await runFixture({ name: 'vanilla', main: '/fixture/main.js', notes: 'unit' })
    expect(result.ok).toBe(true)
    expect(capture.options).toMatchObject({
      command: process.execPath,
      env: {
        DISPLAY: ':123',
        XAUTHORITY: '/tmp/fixture.Xauthority',
        ELECTRON_DISABLE_SANDBOX: '1',
        ELECTRON_OVERRIDE_DIST_PATH: '/tmp/provisioned-electron',
      },
    })
  })

  it('does not invent optional runtime settings when they are absent', async () => {
    for (const name of FORWARDED_RUNTIME_ENV) vi.stubEnv(name, undefined)
    await runFixture({ name: 'vanilla', main: '/fixture/main.js', notes: 'unit' })
    expect(capture.options?.['env']).toEqual({})
  })
})
