/**
 * Mirror test — asserts every error-code literal referenced in source matches a
 * registered code, so adding a code to a tool without registering it fails CI
 * in the same change.
 *
 * Implemented as a TypeScript AST traversal (`ts.createSourceFile` + a syntax
 * walk — no type checker, no `eval()`), which the regex v1 could not do:
 *
 * - **Comments and prose are invisible** — a docstring mentioning `code: 'X'`
 *   can never false-positive, so no file needs to be excluded for its comments.
 * - **More reference shapes are covered** — besides `code: 'X'` property
 *   assignments, the walk checks `new StagewrightError('X', …)` and
 *   `makeError('X', …)` first arguments, which the regex never saw.
 * - **Plugin packages are scanned too** (the condition that gated this
 *   upgrade): every `makePluginError('<ns>.<KEY>', …)` literal in a
 *   `packages/plugin-*` source must name a KEY declared in that same package's
 *   `errorCodes` manifest object.
 *
 * Scope note: dynamic references (`code: someVar`) are invisible to any static
 * scan; they remain an anti-pattern this rule discourages.
 */

import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import ts from 'typescript'

import { ERROR_CODES, type ErrorCode, isErrorCode } from '../src/errors/registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE_SRC = path.resolve(HERE, '..', 'src')
const PACKAGES_ROOT = path.resolve(HERE, '..', '..')

/** SCREAMING_SNAKE_CASE — the only shape a core code literal can have. */
const CORE_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/
/** `<namespace>.<KEY>` — the shape of a namespaced plugin code literal. */
const PLUGIN_CODE = /^([a-z][a-z0-9-]*)\.([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/

/** Recursively collect the non-test `.ts` sources under a directory. */
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
    out.push(fullPath)
  }
  return out
}

/** The src roots of every `packages/plugin-…` package in this workspace. */
async function collectPluginSrcRoots(): Promise<string[]> {
  const entries = await fs.readdir(PACKAGES_ROOT, { withFileTypes: true })
  const roots: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('plugin-')) continue
    const src = path.join(PACKAGES_ROOT, entry.name, 'src')
    try {
      await fs.access(src)
      roots.push(src)
    } catch {
      // A plugin package without src/ has nothing to scan.
    }
  }
  return roots
}

/** Everything one source file references and declares, found by the AST walk. */
export interface SourceCodeRefs {
  /** Core code literals: `code: 'X'`, `new StagewrightError('X')`, `makeError('X')`. */
  readonly coreRefs: ReadonlySet<string>
  /** Namespaced literals passed to `makePluginError('ns.KEY')`. */
  readonly pluginRefs: ReadonlySet<string>
  /** Keys declared under an `errorCodes: { … }` object literal (plugin manifests). */
  readonly declaredPluginKeys: ReadonlySet<string>
}

/** The callee identifier text of a call expression, or null. */
function calleeName(node: ts.CallExpression | ts.NewExpression): string | null {
  const expr = node.expression
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return null
}

/** Walk one source file's AST and extract every code reference/declaration. */
function extractCodeReferences(source: string, fileName = 'scan.ts'): SourceCodeRefs {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const coreRefs = new Set<string>()
  const pluginRefs = new Set<string>()
  const declaredPluginKeys = new Set<string>()

  const visit = (node: ts.Node): void => {
    // code: 'X' in property-assignment position.
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'code' &&
      ts.isStringLiteral(node.initializer) &&
      CORE_CODE.test(node.initializer.text)
    ) {
      coreRefs.add(node.initializer.text)
    }
    // new StagewrightError('X', …)
    if (ts.isNewExpression(node) && calleeName(node) === 'StagewrightError') {
      const first = node.arguments?.[0]
      if (first !== undefined && ts.isStringLiteral(first) && CORE_CODE.test(first.text)) {
        coreRefs.add(first.text)
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      const first = node.arguments[0]
      // makeError('X', …)
      if (name === 'makeError' && first !== undefined && ts.isStringLiteral(first)) {
        if (CORE_CODE.test(first.text)) coreRefs.add(first.text)
      }
      // makePluginError('ns.KEY', …)
      if (name === 'makePluginError' && first !== undefined && ts.isStringLiteral(first)) {
        if (PLUGIN_CODE.test(first.text)) pluginRefs.add(first.text)
      }
    }
    // errorCodes: { KEY: {…}, … } — a plugin manifest's declarations.
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'errorCodes' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
          CORE_CODE.test(prop.name.text)
        ) {
          declaredPluginKeys.add(prop.name.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { coreRefs, pluginRefs, declaredPluginKeys }
}

describe('errors-mirror — every referenced code is registered (AST scan)', () => {
  it('extractCodeReferences finds assignments, constructor and factory calls — never prose', () => {
    const refs = extractCodeReferences(`
      // a comment mentioning code: 'NOT_A_REAL_REF' must be invisible
      /** docs citing makeError('ALSO_NOT_A_REF') too */
      const a = makeError('NOT_RUNNING', {})
      throw new StagewrightError('BAD_ARGUMENT', 'msg', { code: 'REF_NOT_FOUND' })
      const env = { code: 'SELECTOR_NO_MATCH' }
      const prose = { code: 'not screaming case' }
    `)
    expect(refs.coreRefs).toEqual(
      new Set(['NOT_RUNNING', 'BAD_ARGUMENT', 'REF_NOT_FOUND', 'SELECTOR_NO_MATCH']),
    )

    const plugin = extractCodeReferences(`
      const manifest = { errorCodes: { EVAL_REQUIRED: { http: 403 }, INVOKE_FAILED: { http: 422 } } }
      return makePluginError('ipc.EVAL_REQUIRED', {})
    `)
    expect(plugin.pluginRefs).toEqual(new Set(['ipc.EVAL_REQUIRED']))
    expect(plugin.declaredPluginKeys).toEqual(new Set(['EVAL_REQUIRED', 'INVOKE_FAILED']))
  })

  it('every core code literal in packages/core/src matches a registry key', async () => {
    const files = await collectSourceFiles(CORE_SRC)
    expect(files.length, 'source scan must find at least one .ts file').toBeGreaterThan(0)

    const unregistered: Array<{ code: string; file: string }> = []
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8')
      const { coreRefs } = extractCodeReferences(source, file)
      for (const code of coreRefs) {
        if (!isErrorCode(code)) {
          unregistered.push({ code, file: path.relative(CORE_SRC, file) })
        }
      }
    }
    expect(
      unregistered,
      `unregistered codes detected — add them to ERROR_CODES or fix the typo:\n${JSON.stringify(unregistered, null, 2)}`,
    ).toEqual([])
  })

  it('every plugin package code reference is declared in that package errorCodes manifest', async () => {
    const roots = await collectPluginSrcRoots()
    expect(roots.length, 'expected at least one packages/plugin-*/src').toBeGreaterThan(0)

    const problems: string[] = []
    for (const root of roots) {
      const files = await collectSourceFiles(root)
      const declared = new Set<string>()
      const refs = new Map<string, string[]>() // 'ns.KEY' -> files
      for (const file of files) {
        const source = await fs.readFile(file, 'utf8')
        const extracted = extractCodeReferences(source, file)
        for (const key of extracted.declaredPluginKeys) declared.add(key)
        for (const ref of extracted.pluginRefs) {
          const seenIn = refs.get(ref) ?? []
          seenIn.push(path.relative(root, file))
          refs.set(ref, seenIn)
        }
        // Core codes referenced from a plugin (StagewrightError / code:) must be
        // registered core codes too.
        for (const code of extracted.coreRefs) {
          if (!isErrorCode(code)) {
            problems.push(`${path.relative(PACKAGES_ROOT, file)}: unregistered core code "${code}"`)
          }
        }
      }
      for (const [ref, seenIn] of refs) {
        const match = PLUGIN_CODE.exec(ref)
        const key = match?.[2] ?? ''
        if (!declared.has(key)) {
          problems.push(
            `${path.relative(PACKAGES_ROOT, root)}: "${ref}" is used (${seenIn.join(', ')}) but "${key}" is not declared in errorCodes`,
          )
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('every registry key has the three-field shape (defensive sanity)', () => {
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
