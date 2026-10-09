import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const FIELD_PREFIX = 'Source-resolved Electron:'

/** Windows checkouts may use CRLF; the field comparison is about content, not line endings. */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

async function readText(relative: string): Promise<string> {
  return toLf(await readFile(path.join(root, relative), 'utf8'))
}

function sourceTuple(rawLock: string): { electron: string; playwright: string } {
  const lock = toLf(rawLock)
  const importer = lock.match(/^  packages\/core:\n([\s\S]*?)(?=^  [^ ]|$(?![\s\S]))/m)?.[1]
  if (importer === undefined) throw new Error('Missing packages/core lock importer')
  const version = (name: string): string => {
    // Accept prerelease/build versions (e.g. 43.0.0-beta.2) and strip pnpm's peer suffix.
    const match = importer.match(
      new RegExp(
        `^      ${name}:\\n        specifier: [^\\n]+\\n        version: ([^\\s(]+)(?:\\([^\\n]*\\))?$`,
        'm',
      ),
    )
    if (match?.[1] === undefined) throw new Error(`Missing locked source version: ${name}`)
    return match[1]
  }
  return { electron: version('electron'), playwright: version('playwright') }
}

function assertDocumentSource(lock: string, rawGuide: string): void {
  const guide = toLf(rawGuide)
  const tuple = sourceTuple(lock)
  const field = `${FIELD_PREFIX} \`${tuple.electron}\`; Playwright: \`${tuple.playwright}\`.`
  const occurrences = guide.split(FIELD_PREFIX).length - 1
  if (occurrences !== 1 || !guide.includes(field))
    throw new Error(
      `Source-resolution field differs from frozen lockfile; expected exactly one line: ${field}`,
    )
}

describe('source resolution is distinct from compatibility qualification', () => {
  let lock = ''
  let guide = ''

  beforeAll(async () => {
    ;[lock, guide] = await Promise.all([
      readText('pnpm-lock.yaml'),
      readText('docs/guides/compatibility.md'),
    ])
  })

  it('checks only the documented source field against the core lock importer', () => {
    const { electron, playwright } = sourceTuple(lock)
    expect(() => assertDocumentSource(lock, guide)).not.toThrow()
    expect(() =>
      assertDocumentSource(lock, guide.replace(FIELD_PREFIX, 'Hidden Electron:')),
    ).toThrow('differs')
    expect(() =>
      assertDocumentSource(lock, guide.replace(`Electron: \`${electron}\``, 'Electron: `0.0.0`')),
    ).toThrow('differs')
    expect(() =>
      assertDocumentSource(
        lock,
        guide.replace(`Playwright: \`${playwright}\``, 'Playwright: `0.0.0`'),
      ),
    ).toThrow('differs')
    expect(() =>
      assertDocumentSource(lock, `${guide}\n${FIELD_PREFIX} \`0.0.0\`; Playwright: \`0.0.0\`.\n`),
    ).toThrow('differs')
    expect(guide).toContain('Qualified compatibility evidence')
    expect(guide).toContain('No successful unit result')
    expect(guide).toContain('not recorded in the previous guide')
  })

  it('reads CRLF checkouts the same as LF checkouts', () => {
    const crlfLock = lock.replace(/\n/g, '\r\n')
    const crlfGuide = guide.replace(/\n/g, '\r\n')
    expect(sourceTuple(crlfLock)).toEqual(sourceTuple(lock))
    expect(() => assertDocumentSource(crlfLock, crlfGuide)).not.toThrow()
  })

  it('reads prerelease versions and strips peer suffixes', () => {
    const synthetic = [
      'importers:',
      '',
      '  packages/core:',
      '    devDependencies:',
      '      electron:',
      '        specifier: ^43.0.0-beta.1',
      '        version: 43.0.0-beta.2',
      '      playwright:',
      '        specifier: ^1.64.0',
      '        version: 1.64.0(peer@1.0.0)',
      '',
      '  packages/demo:',
      '    dependencies:',
      '      electron:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '',
    ].join('\n')
    expect(sourceTuple(synthetic)).toEqual({ electron: '43.0.0-beta.2', playwright: '1.64.0' })
  })

  it('refuses an absent importer instead of looking at unrelated package snapshots', () => {
    expect(() => sourceTuple('packages:\n  electron@42.11.10:\n  playwright@1.63.0:\n')).toThrow(
      'Missing packages/core',
    )
  })
})
