import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function sourceTuple(lock: string): { electron: string; playwright: string } {
  const importer = lock.match(/^  packages\/core:\n([\s\S]*?)(?=^  [^ ]|$(?![\s\S]))/m)?.[1]
  if (importer === undefined) throw new Error('Missing packages/core lock importer')
  function version(name: string): string {
    const match = importer?.match(
      new RegExp(
        `^      ${name}:\\n        specifier: [^\\n]+\\n        version: ([0-9]+\\.[0-9]+\\.[0-9]+)(?:\\([^\\n]*\\))?$`,
        'm',
      ),
    )
    if (match?.[1] === undefined) throw new Error(`Missing locked source version: ${name}`)
    return match[1]
  }
  return { electron: version('electron'), playwright: version('playwright') }
}

function assertDocumentSource(lock: string, guide: string): void {
  const tuple = sourceTuple(lock)
  const field = `Source-resolved Electron: \`${tuple.electron}\`; Playwright: \`${tuple.playwright}\`.`
  if (!guide.includes(field))
    throw new Error('Source-resolution field differs from frozen lockfile')
}

describe('source resolution is distinct from compatibility qualification', () => {
  it('checks only the documented source field against the core lock importer', async () => {
    const lock = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')
    const guide = await readFile(path.join(root, 'docs/guides/compatibility.md'), 'utf8')
    expect(() => assertDocumentSource(lock, guide)).not.toThrow()
    expect(() =>
      assertDocumentSource(lock, guide.replace('Source-resolved Electron:', 'Hidden Electron:')),
    ).toThrow('differs')
    expect(() =>
      assertDocumentSource(lock, guide.replace('Playwright: `1.63.0`', 'Playwright: `0.0.0`')),
    ).toThrow('differs')
    expect(guide).toContain('pending qualification')
    expect(guide).toContain('not recorded in the previous guide')
  })

  it('refuses an absent importer instead of looking at unrelated package snapshots', () => {
    expect(() => sourceTuple('packages:\n  electron@42.11.10:\n  playwright@1.63.0:\n')).toThrow(
      'Missing packages/core',
    )
  })
})
