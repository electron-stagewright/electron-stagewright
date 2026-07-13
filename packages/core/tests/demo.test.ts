import { describe, expect, it } from 'vitest'

import { resolveDemoMain } from '../src/demo.js'

describe('resolveDemoMain', () => {
  it('accepts an absolute existing entry from the separately loaded manifest', async () => {
    await expect(
      resolveDemoMain({
        loadManifest: async () => ({ demoMain: '/opt/stagewright-demo/main.js' }),
        fileExists: () => true,
      }),
    ).resolves.toBe('/opt/stagewright-demo/main.js')
  })

  it('fails clearly when the optional demo package cannot load', async () => {
    await expect(
      resolveDemoMain({ loadManifest: async () => Promise.reject(new Error('module not found')) }),
    ).rejects.toThrow('@electron-stagewright/demo')
  })

  it('fails closed for relative, malformed, or missing entries', async () => {
    await expect(
      resolveDemoMain({ loadManifest: async () => ({ demoMain: 'main.js' }) }),
    ).rejects.toThrow('absolute path')
    await expect(
      resolveDemoMain({
        loadManifest: async () => ({ demoMain: '/opt/stagewright-demo/main.js' }),
        fileExists: () => false,
      }),
    ).rejects.toThrow('does not exist')
  })
})
