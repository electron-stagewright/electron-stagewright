import { access } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { demoMain } from '../src/manifest.js'

describe('demo manifest', () => {
  it('resolves the packaged Electron entry to an existing absolute file', async () => {
    expect(path.isAbsolute(demoMain)).toBe(true)
    expect(demoMain).toMatch(/main\.js$/)
    await expect(access(demoMain)).resolves.toBeUndefined()
  })
})
