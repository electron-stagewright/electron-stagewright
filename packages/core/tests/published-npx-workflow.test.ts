import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

describe('published npx smoke workflow', () => {
  it('runs the isolated clean-cache probe after a published GitHub release or on demand', async () => {
    const workflow = await readFile(
      path.join(REPO_ROOT, '.github', 'workflows', 'published-npx-smoke.yml'),
      'utf8',
    )

    expect(workflow).toContain('release:')
    expect(workflow).toContain('types: [published]')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('node-version: 24')
    expect(workflow).toContain('node scripts/published-npx-smoke.mjs')
  })
})
