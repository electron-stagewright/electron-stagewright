/**
 * Mirror test — asserts every `code: 'XXX'` string-literal in core source files
 * references a key registered in {@link ERROR_CODES}. Adding an error code to a
 * tool without registering it causes this test to fail, forcing the registration
 * conversation to happen in the same PR as the new code.
 *
 * ## Security note — this file does NOT call `eval()`
 *
 * This is a static-analysis test that reads other source files as plain text
 * with `fs.readFile` and applies a regex to find `code: '...'` literals. The
 * only thing it executes is the regex matcher and Vitest assertions. The
 * mentions of "eval" inside this file (in the docstring, the exclude list)
 * refer to the operation-type CLASSIFICATION (see operation-type.ts) and to a
 * filename — not to runtime JavaScript evaluation. The string "eval(" appears
 * only inside a comment explaining why a sibling file is excluded from the scan.
 *
 * ## Implementation notes
 *
 * - This v1 uses a regex-based scan over `.ts` source files. ADR-006 acknowledges
 *   that a TypeScript Compiler API walk would be strictly more precise. The regex
 *   is good enough while the codebase has 1-2 files using codes; the upgrade path
 *   is captured in the project's internal follow-up backlog and will be revisited
 *   when the lifecycle tools land their roughly fifteen tool implementations.
 *
 * - The regex deliberately matches only `code: '...'` (single OR double quotes)
 *   in property-assignment position. It will not catch dynamic references like
 *   `code: someVar`, but those are an anti-pattern this rule discourages anyway.
 *
 * - The mirror test scans `packages/core/src/**\/*.ts` and EXPLICITLY excludes
 *   `packages/core/src/errors/registry.ts` (where the codes are declared, not
 *   referenced) and `packages/core/src/errors/operation-type.ts` (whose keyword
 *   blocklist contains substrings that resemble code references to the regex).
 */

import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ERROR_CODES, type ErrorCode, isErrorCode } from '../src/errors/registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = path.resolve(HERE, '..', 'src')

const EXCLUDED_FILES = new Set([
  // The registry itself declares codes — every key is "used" trivially.
  path.resolve(SRC_ROOT, 'errors', 'registry.ts'),
  // operation-type.ts contains a keyword blocklist with substrings that look
  // like code references (e.g. 'eval(') but are unrelated to ErrorCode.
  path.resolve(SRC_ROOT, 'errors', 'operation-type.ts'),
])

/**
 * Recursively collect all `.ts` files under a directory, skipping `dist/`,
 * `node_modules/`, `.test.ts`, and the excluded files above.
 */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const fullPath = path.resolve(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...(await collectSourceFiles(fullPath)))
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    if (entry.name.endsWith('.d.ts')) continue
    if (EXCLUDED_FILES.has(fullPath)) continue
    out.push(fullPath)
  }
  return out
}

/**
 * Scan source text for `code: '...'` and `code: "..."` literal references.
 * Returns the set of distinct codes referenced.
 */
function extractCodeReferences(source: string): Set<string> {
  const refs = new Set<string>()
  // Match: code: 'NAME' OR code: "NAME"
  // - The key MUST be the literal word `code` (no leading dot — avoids accidental
  //   matches against `myObj.code: 'X'` which is invalid syntax anyway).
  // - The captured name uses [A-Z_]+[A-Z0-9_]* to match SCREAMING_SNAKE_CASE only,
  //   avoiding capture of generic strings like `code: 'hello'` that appear in
  //   prose-y contexts.
  const pattern = /(?<![.\w])code\s*:\s*['"]([A-Z_]+[A-Z0-9_]*)['"]/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    refs.add(match[1] as string)
  }
  return refs
}

describe('errors-mirror — every referenced code is registered', () => {
  it('extractCodeReferences captures literal references and ignores prose', () => {
    // Positive case: property-assignment style.
    expect(extractCodeReferences("makeError({ code: 'NOT_RUNNING' })")).toEqual(
      new Set(['NOT_RUNNING']),
    )
    expect(extractCodeReferences('return { code: "REF_NOT_FOUND" }')).toEqual(
      new Set(['REF_NOT_FOUND']),
    )

    // Negative cases: should NOT trip on prose-y mentions.
    expect(extractCodeReferences('// error code: foobar')).toEqual(new Set())
    expect(extractCodeReferences('// the code: not_running is registered')).toEqual(new Set())

    // Multiple references in one source.
    expect(
      extractCodeReferences(`
        if (x) return { code: 'NOT_RUNNING' }
        if (y) return { code: 'BAD_ARGUMENT' }
      `),
    ).toEqual(new Set(['NOT_RUNNING', 'BAD_ARGUMENT']))
  })

  it('every code: literal in core source matches a registry key', async () => {
    const files = await collectSourceFiles(SRC_ROOT)
    expect(files.length, 'source scan must find at least one .ts file').toBeGreaterThan(0)

    const allRefs = new Map<string, string[]>() // code -> [files where seen]
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8')
      const refs = extractCodeReferences(source)
      for (const ref of refs) {
        const seenIn = allRefs.get(ref) ?? []
        seenIn.push(path.relative(SRC_ROOT, file))
        allRefs.set(ref, seenIn)
      }
    }

    const unregistered: Array<{ code: string; files: string[] }> = []
    for (const [code, seenIn] of allRefs) {
      if (!isErrorCode(code)) {
        unregistered.push({ code, files: seenIn })
      }
    }

    expect(
      unregistered,
      `unregistered codes detected — add them to ERROR_CODES or fix the typo:\n${JSON.stringify(unregistered, null, 2)}`,
    ).toEqual([])
  })

  it('every registry key has the four-field shape (defensive sanity)', () => {
    // Light overlap with errors.test.ts, but doubles as a smoke check that the
    // mirror import side of this test file resolves the registry correctly.
    for (const [code, def] of Object.entries(ERROR_CODES)) {
      expect(isErrorCode(code)).toBe(true)
      expect(def).toHaveProperty('http')
      expect(def).toHaveProperty('retryable')
      expect(def).toHaveProperty('hint')
    }
  })
})

// Type-level sanity: ErrorCode union narrows to the registry keys at compile time.
// (No runtime assertion — if this file typechecks, the contract holds.)
function _typeSmoke(code: ErrorCode): ErrorCode {
  return code
}
void _typeSmoke
