/**
 * AST structural inspection of eval payloads (ADR-014). The guard catches the formatting and
 * computed-access bypasses the substring blocklist misses (`process . exit`, `process['exit']`,
 * `eval ('…')`), plus the constructor-Function escape and dynamic `import()`. These tests pin the
 * blocked set, the precision on benign code (no false positives on ordinary DOM/Node-free code), and
 * the parse-failure defer (returns null rather than throwing, so it is never worse than the
 * blocklist alone). They also document the honest limits: aliasing and dynamic keys still pass.
 */

import { describe, expect, it } from 'vitest'

import { inspectEvalAst } from '../src/errors/eval-ast-guard.js'

describe('inspectEvalAst — blocked constructs', () => {
  const blocked: ReadonlyArray<readonly [desc: string, source: string, label: string]> = [
    ['direct eval', "eval('1 + 1')", 'eval()'],
    ['global eval computed string-literal', "window['eval']('1 + 1')", 'eval()'],
    ['Function constructor call', "Function('return 1')()", 'Function()'],
    [
      'global Function computed string-literal',
      "globalThis['Function']('return 1')()",
      'Function()',
    ],
    ['new Function', "new Function('return 1')", 'new Function()'],
    ['require', "return require('fs')", 'require()'],
    ['global require computed string-literal', "global['require']('fs')", 'require()'],
    ['process.exit dotted', 'process.exit(0)', 'process.exit'],
    ['process.exit with whitespace', 'process . exit(0)', 'process.exit'],
    ['process[exit] computed string-literal', "process['exit'](0)", 'process.exit'],
    [
      'globalThis[process][exit] computed string-literals',
      "globalThis['process']['exit'](0)",
      'process.exit',
    ],
    ['process.kill', 'process.kill(1)', 'process.kill'],
    ['process[abort] computed', 'process["abort"]()', 'process.abort'],
    [
      'constructor escape (fold B)',
      "[].constructor.constructor('return 1')()",
      '.constructor.constructor',
    ],
    ['dynamic import (fold D)', "import('node:fs')", 'import()'],
  ]
  for (const [desc, source, label] of blocked) {
    it(`blocks ${desc}`, () => {
      expect(inspectEvalAst(source)).toEqual({ label })
    })
  }
})

describe('inspectEvalAst — benign code passes (no false positives)', () => {
  const benign = [
    'return 1 + 1',
    "return document.querySelector('.x')?.textContent",
    'return window.location.href',
    'return arg.value',
    'return arg.constructor?.name',
    'const x = { a: 1 }; return x.a',
    'return [1, 2, 3].map((n) => n * 2)',
    'await fetch("/api")',
    // A dangerous-looking NAME inside a string literal is not an executed construct — the AST pass is
    // more precise than the substring blocklist here (the substring pass, which runs first in the
    // real pipeline, still flags it; this asserts the AST guard alone does not).
    'return "I will not call process.exit from here"',
  ]
  for (const source of benign) {
    it(`passes: ${source}`, () => {
      expect(inspectEvalAst(source)).toBeNull()
    })
  }
})

describe('inspectEvalAst — parse failures defer to the substring pass (no throw)', () => {
  for (const source of ['return )(', 'function (', '<<<<', 'const ;']) {
    it(`returns null for unparseable ${JSON.stringify(source)}`, () => {
      expect(inspectEvalAst(source)).toBeNull()
    })
  }
})

describe('inspectEvalAst — documented limits (still passes; not a sound analyzer)', () => {
  it('does not catch a dynamic computed key it cannot resolve statically', () => {
    // globalThis['pro' + 'cess'] — the key is built at runtime; the static analysis cannot resolve
    // it. This is the honest limitation; the --allow-eval opt-in stays the primary control.
    expect(inspectEvalAst("return globalThis['pro' + 'cess']")).toBeNull()
  })

  it('does not catch an aliased dangerous identifier', () => {
    // const f = Function; f('…') — aliasing defeats the call-site match. Documented limit.
    expect(inspectEvalAst("const f = Function; return f('return 1')")).toBeNull()
  })
})
