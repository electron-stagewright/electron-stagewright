/**
 * Tests for the tool-reference generator:
 *
 * 1. Unit — `renderToolReference` over a synthetic manifest: grouping by operation type, the ToC
 *    (incl. underscore-preserving anchors), parameter tables (required flag, enum + pipe escaping),
 *    the "no parameters" case, the eval-gate mark, and determinism.
 * 2. Sync — the committed `TOOL-REFERENCE.md` equals what the live manifest renders RIGHT NOW, so a
 *    tool added/changed without running `pnpm docs:tools` fails CI (the bench `--check` analog).
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { renderToolReference } from '../src/manifest/tool-reference.js'
import { createServer } from '../src/server/server.js'
import type { ToolManifestEntry } from '../src/server/dispatcher.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REFERENCE_PATH = path.join(REPO_ROOT, 'TOOL-REFERENCE.md')

const MANIFEST: readonly ToolManifestEntry[] = [
  {
    name: 'demo_click',
    title: 'Click it',
    description: 'Click the target.',
    operationType: 'command',
    inputJsonSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector.' },
        ref: { type: 'number', description: 'Snapshot ref.' },
        button: { enum: ['left', 'right'], description: 'Which button: left | right.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'demo_status',
    description: 'Report status.',
    operationType: 'query',
    inputJsonSchema: { type: 'object', properties: {} },
  },
  {
    name: 'demo_eval',
    description: 'Run code.',
    operationType: 'eval',
    requiresEvalFlag: true,
    inputJsonSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JS to run.' } },
      required: ['code'],
    },
  },
]

describe('renderToolReference', () => {
  const md = renderToolReference(MANIFEST)

  it('opens with the generated-do-not-edit header and a tool count', () => {
    expect(md.startsWith('# Tool reference')).toBe(true)
    expect(md).toContain('do not edit by hand')
    expect(md).toContain('The server exposes 3 tools across 3 operation types')
  })

  it('groups tools under per-operation-type headings, sorted', () => {
    const order = ['## Command tools', '## Eval tools', '## Query tools'].map((h) => md.indexOf(h))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b)) // appear in sorted order
  })

  it('builds a contents list with GitHub-style anchors', () => {
    expect(md).toContain('- [Command tools](#command-tools) (1)')
    expect(md).toContain('- [Eval tools](#eval-tools) (1)')
  })

  it('preserves underscores in anchors so multi-word operation types link correctly', () => {
    const withUnderscore = renderToolReference([
      { name: 'demo_info', description: 'x', operationType: 'window_info', inputJsonSchema: {} },
    ])
    expect(withUnderscore).toContain('(#window_info-tools)')
    expect(withUnderscore).toContain('## Window_info tools')
  })

  it('renders a parameter table with the required flag and escaped enum pipes', () => {
    expect(md).toContain('| `selector` | string | yes |')
    expect(md).toContain('| `ref` | number | no |')
    // enum renders as a pipe-joined union, escaped so it cannot break the table column.
    expect(md).toContain('left \\| right')
    // a pipe inside a description is escaped too.
    expect(md).toContain('Which button: left \\| right.')
  })

  it('marks eval-gated tools and notes the flag in the summary', () => {
    expect(md).toContain('Tools marked "Requires `--allow-eval`"')
    expect(md).toContain('Operation: `eval` · Requires `--allow-eval`')
  })

  it('shows a no-parameters note for a tool with an empty schema', () => {
    expect(md).toContain('_No parameters._')
  })

  it('is deterministic (same manifest renders identically)', () => {
    expect(renderToolReference(MANIFEST)).toBe(md)
    // input order must not matter — a reversed manifest renders the same.
    expect(renderToolReference([...MANIFEST].reverse())).toBe(md)
  })
})

describe('TOOL-REFERENCE.md is in sync with the live manifest', () => {
  it('matches what the current dispatcher manifest renders (run pnpm docs:tools if this fails)', async () => {
    const server = await createServer({ allowEval: true })
    try {
      const expected = renderToolReference(server.dispatcher.listManifest())
      // Normalise CRLF -> LF: git may check the committed file out with CRLF on Windows
      // (core.autocrlf=true), but line-ending representation is not content drift. (`.gitattributes`
      // also pins the file to LF; this keeps the assertion correct regardless of git config.)
      const onDisk = (await readFile(REFERENCE_PATH, 'utf8')).replace(/\r\n/g, '\n')
      expect(onDisk).toBe(expected)
    } finally {
      await server.close().catch(() => undefined)
    }
  })
})
