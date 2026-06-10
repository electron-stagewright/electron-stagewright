/**
 * Best-effort guard against catastrophic-backtracking ("ReDoS") regular expressions supplied as
 * tool arguments by the (untrusted) agent.
 *
 * The dangerous case for this server is a client-supplied pattern that is both COMPILED and
 * EXECUTED on the Node event loop (the `electron_console_logs` `match` filter): a pattern such as
 * `(a+)+$` against a moderately long line backtracks super-linearly and freezes the single-threaded
 * server — and the dispatcher's operation-timeout backstop cannot fire, because that timer is
 * queued on the very event loop the regex is monopolising. JavaScript has no per-call regex
 * timeout, so the only defence without a non-backtracking engine (RE2) is to refuse patterns whose
 * shape admits exponential backtracking before they are ever run.
 *
 * Like the eval keyword blocklist, this is DEFENCE-IN-DEPTH, not a complete decision procedure: it
 * reliably rejects the dominant family — a quantifier nested inside a quantified group, e.g.
 * `(a+)+`, `(a*)*`, `([a-z]+)*`, `(\d+){2,}` — which covers the practical attacks, but it does not
 * model every super-linear construct (e.g. alternation overlap like `(a|ab)+`). Combine it with the
 * length cap here and an input-size cap at the call site for the server-side matcher.
 *
 * @module
 */

/** Hard cap on the length of an agent-supplied regular-expression source string. */
export const MAX_USER_REGEX_LENGTH = 1000

/** A repetition quantifier that can drive backtracking: `*`, `+`, or a `{...}` brace count. `?` is
 *  excluded — it makes a token optional, it does not repeat, so it cannot blow up on its own. */
function isQuantifierStart(ch: string | undefined): boolean {
  return ch === '*' || ch === '+' || ch === '{'
}

/** Advance past a quantifier token at `i` (`*`/`+`, or `{...}`), including a trailing lazy/possessive `?`/`+`. */
function skipQuantifier(source: string, i: number): number {
  let j = i
  if (source[j] === '{') {
    while (j < source.length && source[j] !== '}') j += 1
    j += 1 // past '}'
  } else {
    j += 1 // past '*' or '+'
  }
  if (source[j] === '?' || source[j] === '+') j += 1 // lazy or possessive modifier
  return j
}

/**
 * Whether `source` nests a backtracking quantifier inside a quantified group — the canonical
 * catastrophic-backtracking shape. Walks the pattern once, honouring `\` escapes and `[...]`
 * character classes, tracking per-group whether the group's body contains a quantifier; a group
 * whose body has a quantifier AND that is itself quantified is reported unsafe. Body-quantifier
 * status propagates to the enclosing group on pop, so deeper nestings (`((a+))+`) are caught too.
 */
function hasNestedQuantifier(source: string): boolean {
  const stack: { bodyHasQuantifier: boolean }[] = []
  const markEnclosing = (): void => {
    const top = stack[stack.length - 1]
    if (top !== undefined) top.bodyHasQuantifier = true
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2 // skip the escaped char; an escaped quantifier is a literal, not a repetition
      continue
    }
    if (ch === '[') {
      i += 1
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1
      i += 1 // past ']'
      if (isQuantifierStart(source[i])) {
        markEnclosing() // a quantified character class is a quantifier in the enclosing group
        i = skipQuantifier(source, i)
      }
      continue
    }
    if (ch === '(') {
      stack.push({ bodyHasQuantifier: false })
      i += 1
      continue
    }
    if (ch === ')') {
      const frame = stack.pop()
      i += 1
      const quantified = isQuantifierStart(source[i])
      if (frame?.bodyHasQuantifier === true && quantified) return true
      // Propagate: the enclosing group's body now contains a quantifier if this group did, or if
      // this group is itself a repetition.
      if (frame?.bodyHasQuantifier === true || quantified) markEnclosing()
      if (quantified) i = skipQuantifier(source, i)
      continue
    }
    if (isQuantifierStart(ch)) {
      markEnclosing()
      i = skipQuantifier(source, i)
      continue
    }
    i += 1
  }
  return false
}

/**
 * Describe why an agent-supplied regex source is unsafe to run, or return `null` when it passes the
 * best-effort checks. Callers reject a non-null reason with `BAD_ARGUMENT` before compiling/running
 * the pattern. The string is safe to surface to the agent (no internals).
 */
export function describeRegexSafety(source: string): string | null {
  if (source.length > MAX_USER_REGEX_LENGTH) {
    return `pattern is too long (${source.length} > ${MAX_USER_REGEX_LENGTH} characters)`
  }
  if (hasNestedQuantifier(source)) {
    return 'pattern nests a repetition inside a repeated group (e.g. "(a+)+"), which can backtrack catastrophically; rewrite it without nested quantifiers'
  }
  return null
}
