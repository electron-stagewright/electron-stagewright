/**
 * Structural (AST) inspection of eval payloads — the defence-in-depth pass that catches the
 * formatting and computed-access bypasses the substring blocklist misses (`process . exit`,
 * `process['exit']`, `eval ('…')`). It targets the SAME threat set as the keyword blocklist,
 * matched in the parse tree rather than as raw text, plus the constructor-`Function` escape and
 * dynamic `import()`.
 *
 * This is NOT a sound analyzer. It is static and conservative: dynamic or computed access whose key
 * it cannot resolve at parse time (`globalThis['pro'+'cess']`), aliasing (`const f = Function;
 * f('…')`), and payloads assembled from strings at runtime all still pass. The `--allow-eval` opt-in
 * and the privileged-local-tool trust boundary remain the primary controls (ADR-014). On a parse
 * failure the inspector returns `null` — it defers to the substring pass and the remote eval (which
 * surfaces a genuine syntax error as `EVAL_SYNTAX_ERROR`), so it is never worse than the blocklist
 * alone.
 *
 * @module
 */

import { parse } from 'acorn'

/** A blocked construct found in an eval payload, named for the rejection's error detail. */
export interface EvalConstructFinding {
  /** Human-readable label of the construct, e.g. `process.exit`, `Function()`, `import()`. */
  readonly label: string
}

/** A parsed AST node: every acorn node has a string `type`; other fields are walked structurally. */
interface AstNode {
  readonly type: string
  readonly [key: string]: unknown
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

/** Depth-first walk over every node in the tree (arrays and nested nodes), the root included. */
function* walk(node: AstNode): Generator<AstNode> {
  yield node
  for (const key of Object.keys(node)) {
    if (key === 'type') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) yield* walk(item)
    } else if (isNode(child)) {
      yield* walk(child)
    }
  }
}

/** The called/constructed global name, when the callee is statically resolvable. */
function calleeName(node: AstNode): string | null {
  const callee = node['callee']
  if (!isNode(callee)) return null
  if (callee.type === 'Identifier') {
    const name = callee['name']
    return typeof name === 'string' ? name : null
  }
  if (callee.type === 'MemberExpression' && isKnownGlobalObject(callee['object'])) {
    return memberPropertyName(callee)
  }
  return null
}

/**
 * The accessed property name of a `MemberExpression`, whether dotted (`a.b`) or a computed
 * STRING-LITERAL key (`a['b']`). Returns `null` for a dynamic computed key the analysis cannot
 * resolve statically — the documented limitation.
 */
function memberPropertyName(node: AstNode): string | null {
  const property = node['property']
  if (!isNode(property)) return null
  if (node['computed'] === true) {
    const value = property['value']
    return property.type === 'Literal' && typeof value === 'string' ? value : null
  }
  const name = property['name']
  return property.type === 'Identifier' && typeof name === 'string' ? name : null
}

/** `process` members that terminate or destabilise the host process — the blocklist's intent. */
const PROCESS_LETHAL = new Set(['exit', 'kill', 'abort'])

/** Global objects whose statically-resolved dangerous members are equivalent to bare globals. */
function isKnownGlobalObject(value: unknown): value is AstNode {
  return (
    isNode(value) &&
    value.type === 'Identifier' &&
    (value['name'] === 'globalThis' || value['name'] === 'global' || value['name'] === 'window')
  )
}

/** Whether this expression resolves to the global `process` object in forms we can statically see. */
function isProcessObject(node: AstNode): boolean {
  if (node.type === 'Identifier') return node['name'] === 'process'
  if (node.type !== 'MemberExpression') return false
  const prop = memberPropertyName(node)
  if (prop !== 'process') return false
  const object = node['object']
  return isKnownGlobalObject(object)
}

/** The Function-constructor escape: `[].constructor.constructor('…')()`. */
function isConstructorConstructorAccess(node: AstNode): boolean {
  if (node.type !== 'MemberExpression' || memberPropertyName(node) !== 'constructor') return false
  const object = node['object']
  return (
    isNode(object) &&
    object.type === 'MemberExpression' &&
    memberPropertyName(object) === 'constructor'
  )
}

/** Match a single node against the blocked-construct set; returns the label or `null`. */
function blockedConstruct(node: AstNode): string | null {
  if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    const name = calleeName(node)
    if (name === 'eval') return 'eval()'
    if (name === 'Function') return node.type === 'NewExpression' ? 'new Function()' : 'Function()'
    if (name === 'require') return 'require()'
  }
  // Dynamic import() — the module-escape vector.
  if (node.type === 'ImportExpression') return 'import()'
  if (node.type === 'MemberExpression') {
    const prop = memberPropertyName(node)
    if (isConstructorConstructorAccess(node)) return '.constructor.constructor'
    if (prop !== null && PROCESS_LETHAL.has(prop)) {
      const object = node['object']
      if (isNode(object) && isProcessObject(object)) {
        return `process.${prop}`
      }
    }
  }
  return null
}

/**
 * Inspect an eval payload's source for a blocked construct. Returns the first finding, or `null`
 * when the source is clean OR cannot be parsed. Parses as a script with top-level `return`/`await`
 * allowed, since eval bodies routinely use them.
 */
export function inspectEvalAst(source: string): EvalConstructFinding | null {
  let root: AstNode
  try {
    root = parse(source, {
      ecmaVersion: 'latest',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    }) as unknown as AstNode
  } catch {
    return null
  }
  for (const node of walk(root)) {
    const label = blockedConstruct(node)
    if (label !== null) return { label }
  }
  return null
}
