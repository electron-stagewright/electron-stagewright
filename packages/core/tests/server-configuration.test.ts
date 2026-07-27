import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { StagewrightError } from '../src/errors/registry.js'
import type { StagewrightPlugin } from '../src/plugins/types.js'
import {
  inspectServerConfiguration,
  type ServerConfigurationInput,
} from '../src/server/configuration.js'

const BASE_CONFIGURATION: ServerConfigurationInput = {
  demo: false,
  allowEval: { main: false, renderer: false },
  toolProfile: 'essential',
  pluginSpecs: [],
  pluginConfigs: {},
}

describe('inspectServerConfiguration', () => {
  it('builds and closes the same unconnected server object graph as serve', async () => {
    const result = await inspectServerConfiguration(BASE_CONFIGURATION)

    expect(result).toEqual({
      ok: true,
      status: 'pass',
      message: 'Server configuration is valid (0 plugin(s), essential tool profile).',
      details: {
        demo: false,
        tool_profile: 'essential',
        plugins: [],
        operation_timeout_ms: 'default',
      },
    })
  })

  it('runs plugin import, config parsing, setup, and teardown without exposing config values', async () => {
    const events: string[] = []
    const plugin: StagewrightPlugin = {
      name: 'fixturep',
      version: '1.0.0',
      coreVersionRange: '*',
      configSchema: z.object({ secret: z.string() }),
      setup: () => {
        events.push('setup')
      },
      teardown: () => {
        events.push('teardown')
      },
    }

    const result = await inspectServerConfiguration(
      {
        ...BASE_CONFIGURATION,
        pluginSpecs: ['fixture'],
        pluginConfigs: { fixturep: { secret: 'must-not-leak' } },
        operationTimeoutMs: 5000,
      },
      {
        importPlugin: async (spec) => {
          expect(spec).toBe('fixture')
          events.push('import')
          return plugin
        },
      },
    )

    expect(result).toMatchObject({
      ok: true,
      status: 'pass',
      details: {
        plugins: ['fixturep'],
        operation_timeout_ms: 5000,
      },
    })
    expect(events).toEqual(['import', 'setup', 'teardown'])
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
  })

  it('returns typed plugin failures as diagnostics instead of throwing', async () => {
    const result = await inspectServerConfiguration(
      {
        ...BASE_CONFIGURATION,
        pluginSpecs: ['missing-plugin'],
      },
      {
        importPlugin: async () => {
          throw new StagewrightError('PLUGIN_LOAD_FAILED', 'module was not found', {
            spec: 'missing-plugin',
            resolved_spec: 'missing-plugin',
          })
        },
      },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'PLUGIN_LOAD_FAILED',
      message: expect.stringContaining('module was not found'),
      details: {
        spec: 'missing-plugin',
        resolved_spec: 'missing-plugin',
      },
    })
  })

  it('drops non-serializable plugin error details so doctor JSON remains valid', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const result = await inspectServerConfiguration(
      {
        ...BASE_CONFIGURATION,
        pluginSpecs: ['broken-plugin'],
      },
      {
        importPlugin: async () => {
          throw new StagewrightError('PLUGIN_LOAD_FAILED', 'broken plugin', cyclic)
        },
      },
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'PLUGIN_LOAD_FAILED',
      message: expect.stringContaining('broken plugin'),
    })
    expect(result).not.toHaveProperty('details')
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  it('warns when config is keyed to a plugin that is not selected', async () => {
    const result = await inspectServerConfiguration({
      ...BASE_CONFIGURATION,
      pluginConfigs: { ghost: { secret: 'must-not-leak' } },
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'warn',
      message: expect.stringContaining('ghost'),
      details: { orphaned_plugin_configs: ['ghost'] },
    })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
  })

  it('validates demo and app-root compatibility in the shared serve/doctor path', async () => {
    const result = await inspectServerConfiguration({
      ...BASE_CONFIGURATION,
      demo: true,
      appRoot: '/app',
    })

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('--demo cannot be combined with --app-root'),
    })
  })
})
