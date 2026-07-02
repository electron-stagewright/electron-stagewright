/**
 * Minimal, dependency-free semver range matcher for the plugin core-compatibility check
 * (ADR-004). The plugin loader uses this to decide whether a plugin's declared
 * `coreVersionRange` admits the running core version, so a plugin can pin a supported range
 * (`^0.1.0`, `>=0.1.2 <0.3.0`) instead of only `*` or an exact string.
 *
 * Supported grammar (a practical subset of node-semver, enough for core-compat pinning):
 *
 * - `*` or `x` — any version.
 * - exact: `1.2.3`.
 * - comparators: `>1.2.3`, `>=1.2.3`, `<2.0.0`, `<=1.5.0`, `=1.2.3`.
 * - caret: `^1.2.3` → `>=1.2.3 <2.0.0`; `^0.2.3` → `>=0.2.3 <0.3.0`; `^0.0.3` → `>=0.0.3 <0.0.4`.
 * - tilde: `~1.2.3` → `>=1.2.3 <1.3.0`; `~1.2` → `>=1.2.0 <1.3.0`.
 * - partial versions in carets/tildes/exacts: `^1`, `~1.2`, `1.x` (a missing part is 0 in the
 *   lower bound and widens the upper bound).
 * - AND: space-separated comparators must all hold — `>=1.2.0 <2.0.0`.
 * - OR: `||`-separated ranges — any one satisfied range matches — `^1.0.0 || ^2.0.0`.
 *
 * Prerelease and build metadata (`-beta.1`, `+build`) are stripped before comparison — core
 * releases are plain `major.minor.patch`, and treating a prerelease as its release version is
 * the conservative choice for a compatibility gate. An unparseable range throws so a typo in a
 * plugin manifest fails the load loudly rather than silently admitting or rejecting the core.
 *
 * @module
 */

/** A parsed `major.minor.patch` triple. */
interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/** Parse a version string to a triple, or `null` when it is not `major[.minor[.patch]]`. */
function parseVersion(raw: string): Version | null {
  // Strip build metadata and prerelease; compare on the release triple only.
  const core = raw.trim().split('+')[0]?.split('-')[0] ?? ''
  const parts = core.split('.')
  if (parts.length === 0 || parts.length > 3) return null
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => Number.isNaN(n))) return null
  return { major: nums[0] ?? 0, minor: nums[1] ?? 0, patch: nums[2] ?? 0 }
}

/** -1 / 0 / 1 comparison of two versions by major, then minor, then patch. */
function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

/** A lower (inclusive) / upper (exclusive) bound pair, either side optional. */
interface Bound {
  readonly gte?: Version
  readonly gt?: Version
  readonly lt?: Version
  readonly lte?: Version
}

/**
 * Parse `major[.minor[.patch]]` allowing a trailing `x`/`*` wildcard, returning the lower bound
 * (missing parts → 0) and the number of specified numeric parts (so caret/tilde can widen).
 */
function parsePartial(
  raw: string,
): { readonly version: Version; readonly specified: number } | null {
  const core = raw.trim().split('+')[0]?.split('-')[0] ?? ''
  const parts = core.split('.')
  if (parts.length === 0 || parts.length > 3) return null
  let specified = 0
  const nums: number[] = []
  for (const part of parts) {
    if (part === 'x' || part === 'X' || part === '*' || part === '') break
    if (!/^\d+$/.test(part)) return null
    nums.push(Number(part))
    specified += 1
  }
  // A caret/tilde/exact needs at least the major part; `^`, `~`, or a bare wildcard here is a typo.
  if (specified === 0) return null
  return {
    version: { major: nums[0] ?? 0, minor: nums[1] ?? 0, patch: nums[2] ?? 0 },
    specified,
  }
}

/** The exclusive upper bound for a caret range on a partial version (semver `^` semantics). */
function caretUpper(v: Version, specified: number): Version {
  if (v.major > 0 || specified === 1) return { major: v.major + 1, minor: 0, patch: 0 }
  if (v.minor > 0 || specified === 2) return { major: 0, minor: v.minor + 1, patch: 0 }
  return { major: 0, minor: 0, patch: v.patch + 1 }
}

/** The exclusive upper bound for a tilde range on a partial version (semver `~` semantics). */
function tildeUpper(v: Version, specified: number): Version {
  if (specified >= 2) return { major: v.major, minor: v.minor + 1, patch: 0 }
  return { major: v.major + 1, minor: 0, patch: 0 }
}

/** The exclusive upper bound for a bare X-range (`1`, `1.2`, `1.x`): increment the last specified part. */
function xRangeUpper(v: Version, specified: number): Version {
  if (specified >= 2) return { major: v.major, minor: v.minor + 1, patch: 0 }
  return { major: v.major + 1, minor: 0, patch: 0 }
}

/** Parse one comparator token (`^1.2`, `~1.2.3`, `>=1.0.0`, `1.2.3`, `x`) into a bound, or `null` for "any". */
function parseComparator(token: string): Bound | null | undefined {
  const t = token.trim()
  if (t === '' || t === '*' || t === 'x' || t === 'X') return null // matches anything
  if (t.startsWith('^')) {
    const p = parsePartial(t.slice(1))
    if (p === null) return undefined
    return { gte: p.version, lt: caretUpper(p.version, p.specified) }
  }
  if (t.startsWith('~')) {
    const p = parsePartial(t.slice(1))
    if (p === null) return undefined
    return { gte: p.version, lt: tildeUpper(p.version, p.specified) }
  }
  const opMatch = /^(>=|<=|>|<|=)?(.*)$/.exec(t)
  if (opMatch === null) return undefined
  const op = opMatch[1] ?? ''
  const rest = opMatch[2] ?? ''
  // A BARE token (no comparator operator) may be an X-range: `1`, `1.2`, `1.x`, `1.2.x` widen to
  // an implicit range; only a fully-specified `1.2.3` is an exact pin.
  if (op === '') {
    const p = parsePartial(rest)
    if (p === null) return undefined
    if (p.specified >= 3) return { gte: p.version, lte: p.version } // exact
    return { gte: p.version, lt: xRangeUpper(p.version, p.specified) }
  }
  const version = parseVersion(rest)
  if (version === null) return undefined
  switch (op) {
    case '>':
      return { gt: version }
    case '>=':
      return { gte: version }
    case '<':
      return { lt: version }
    case '<=':
      return { lte: version }
    default:
      // explicit `=`: pin both bounds to the same version.
      return { gte: version, lte: version }
  }
}

/** Whether `v` satisfies a single bound. */
function withinBound(v: Version, b: Bound): boolean {
  if (b.gte !== undefined && compare(v, b.gte) < 0) return false
  if (b.gt !== undefined && compare(v, b.gt) <= 0) return false
  if (b.lt !== undefined && compare(v, b.lt) >= 0) return false
  if (b.lte !== undefined && compare(v, b.lte) > 0) return false
  return true
}

/**
 * Whether `version` satisfies `range`. Throws `Error` on an unparseable range or version so the
 * plugin loader can surface a precise failure. An empty range (or `*`) matches any version.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  if (v === null) throw new Error(`Not a valid version: "${version}"`)
  // OR across `||`; AND across whitespace within each alternative.
  const alternatives = range.split('||')
  for (const alt of alternatives) {
    const tokens = alt
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0)
    if (tokens.length === 0) return true // empty alternative (e.g. bare `||`) matches anything
    let all = true
    for (const token of tokens) {
      const bound = parseComparator(token)
      if (bound === undefined) throw new Error(`Unparseable version range token: "${token}"`)
      if (bound === null) continue // wildcard comparator — always satisfied
      if (!withinBound(v, bound)) {
        all = false
        break
      }
    }
    if (all) return true
  }
  return false
}
