/**
 * Production-readiness checks for a packaged macOS app (ADR-012).
 *
 * Each check returns a {@link CheckResult} whose `status` encodes the load-bearing distinction the
 * acceptance criteria demand: `pass` (verified good), `fail` (verified bad — a real packaging or
 * signing defect), and `unknown` (could not be determined — a required CLI is absent, a command
 * times out, or the host is not macOS; i.e. MISSING evidence, not a failure). The shell-out checks
 * derive `unknown` from the command runner's `spawnError` rather than a platform branch, so on a
 * non-macOS host the tools are simply absent (`unknown`) and tests can drive every branch through
 * a fake {@link RunCommand}.
 *
 * @module
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import type { CommandResult, RunCommand } from './command.js'

/** Outcome class of a check: verified good, verified bad, or could-not-determine. */
export type CheckStatus = 'pass' | 'fail' | 'unknown'

/**
 * The result of one production-readiness check.
 *
 * - `status` — `pass` (verified good), `fail` (verified bad: a real defect), or `unknown` (missing
 *   evidence — a CLI absent, a command timeout, or a non-macOS host; never conflate with `fail`).
 * - `detail` — one human-readable sentence explaining the outcome.
 * - `evidence` — a short justifying snippet (a tool's output line, the signing authority) when one
 *   is available; omitted otherwise.
 * - `next_actions` — remediation steps; present only on `fail`.
 */
export interface CheckResult {
  readonly id: CheckId
  readonly title: string
  readonly status: CheckStatus
  readonly detail: string
  readonly evidence?: string
  readonly next_actions?: readonly string[]
}

/**
 * The checks this plugin runs, in a stable display order that mirrors the real build pipeline
 * (structure → Info.plist metadata → declared URL schemes → updater feed → crash machinery →
 * sign → notarize → the Gatekeeper launch gate): configuration is validated before the signing
 * gates that seal it. Doubles as the `checks` argument enum.
 */
export const CHECK_IDS = [
  'bundle-structure',
  'info-plist',
  'protocol-schemes',
  'updater-feed',
  'crash-reporter',
  'code-signing',
  'notarization',
  'gatekeeper',
] as const

/** A check identifier — one of {@link CHECK_IDS}. */
export type CheckId = (typeof CHECK_IDS)[number]

/** First non-empty line of a tool's output, trimmed — a compact `evidence` snippet. */
function firstLine(value: string): string {
  const trimmed = value.trim()
  const nl = trimmed.indexOf('\n')
  return nl === -1 ? trimmed : trimmed.slice(0, nl)
}

/**
 * Cap on how long any single untrusted value (a feed URL, a provider name, a scheme) may run
 * inside a `detail` / `evidence` string before {@link clip} truncates it (token economy, ADR-007).
 */
const MAX_UNTRUSTED_VALUE_LENGTH = 120

/**
 * Clip a value read from an untrusted file before embedding it in a `detail` or `evidence`
 * string, so one corrupted multi-kilobyte field cannot bloat the structured payload past the
 * agent's token budget. Clipping never changes a verdict — only how it is reported.
 */
function clip(value: string): string {
  return value.length <= MAX_UNTRUSTED_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_UNTRUSTED_VALUE_LENGTH)}…`
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

async function hasMacOSExecutable(dir: string): Promise<boolean> {
  let entries: readonly string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    const missing =
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { readonly code?: unknown }).code === 'ENOENT'
    if (missing) return false
    throw err
  }
  for (const entry of entries) {
    if ((await isFile(path.join(dir, entry))) === true) return true
  }
  return false
}

const BUNDLE_TITLE = 'macOS app bundle structure'

/**
 * Verify the `.app` is a well-formed bundle: a `Contents/Info.plist` file plus at least one entry
 * under `Contents/MacOS/`. Pure filesystem — no external tool — so it is cross-platform and
 * fixture-testable. (Field-level Info.plist field checks — bundle id, version — are the separate
 * info-plist check.) A missing piece is a `fail` (the bundle is broken); an unreadable path is
 * `unknown`. The tool validates the app path exists before any check runs, so that case is handled
 * upstream.
 */
export async function checkBundleStructure(appPath: string): Promise<CheckResult> {
  const id = 'bundle-structure' as const
  try {
    const infoPresent = await isFile(path.join(appPath, 'Contents', 'Info.plist'))
    const hasExecutable = await hasMacOSExecutable(path.join(appPath, 'Contents', 'MacOS'))
    if (infoPresent && hasExecutable) {
      return {
        id,
        title: BUNDLE_TITLE,
        status: 'pass',
        detail: 'The bundle has Contents/Info.plist and at least one Contents/MacOS executable.',
      }
    }
    const missing: string[] = []
    if (!infoPresent) missing.push('Contents/Info.plist')
    if (!hasExecutable) missing.push('a Contents/MacOS executable')
    return {
      id,
      title: BUNDLE_TITLE,
      status: 'fail',
      detail: `The app bundle is missing ${missing.join(' and ')}.`,
      next_actions: [
        'Repackage the app as a well-formed .app (Contents/Info.plist plus Contents/MacOS/<binary>).',
      ],
    }
  } catch (err) {
    return {
      id,
      title: BUNDLE_TITLE,
      status: 'unknown',
      detail: `Could not inspect the bundle: ${err instanceof Error ? err.message : String(err)}.`,
    }
  }
}

const INFO_PLIST_TITLE = 'Info.plist metadata'

/** The Info.plist identity keys a distributable macOS app must declare (present and non-empty). */
const REQUIRED_PLIST_KEYS = [
  'CFBundleIdentifier',
  'CFBundleShortVersionString',
  'CFBundleExecutable',
] as const

/**
 * Reverse-DNS shape for `CFBundleIdentifier` — at least two dot-separated labels of
 * alphanumerics / hyphen / underscore (e.g. `com.acme.app`). Deliberately lenient: Apple is strict
 * about the character set, but the defect worth catching is a bare word with no namespace.
 */
const REVERSE_DNS_BUNDLE_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/

/** Read `key` as a trimmed non-empty string, or `undefined` when absent / empty / non-string. */
function readPlistString(plist: Record<string, unknown>, key: string): string | undefined {
  const value = plist[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A CFBundleExecutable value is a file name, not a path. Reject traversal before joining. */
function isPlainFileName(value: string): boolean {
  return value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

/** A parsed plist root that is a dictionary (object) — the only shape with inspectable keys. */
function isPlistDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Outcome of reading a bundle's `Contents/Info.plist` as JSON via `plutil -convert json`. Shared
 * by every plist-backed check (info-plist, protocol-schemes) so the spawn / exit / parse / shape
 * classification can never drift between them. Each kind maps onto the three-valued model the
 * SAME way in every consumer:
 *
 * - `ok` — a parsed dictionary root, ready to inspect.
 * - `spawn-error` — `plutil` could not run (absent off-macOS, or a timeout) → `unknown`.
 * - `exit-error` — `plutil` exited non-zero (the plist is missing or malformed) → `fail`.
 * - `unparseable` — `plutil` exited cleanly but its output was not JSON (defensive) → `unknown`.
 * - `not-dictionary` — parsed, but the root is not a dictionary → `fail`.
 */
type PlistReadOutcome =
  | { readonly kind: 'ok'; readonly plist: Record<string, unknown> }
  | { readonly kind: 'spawn-error'; readonly spawnError: string }
  | { readonly kind: 'exit-error'; readonly output: string }
  | { readonly kind: 'unparseable' }
  | { readonly kind: 'not-dictionary' }

/** Read `Contents/Info.plist` as a JSON dictionary through the bounded `plutil` shell-out. */
async function readInfoPlist(appPath: string, run: RunCommand): Promise<PlistReadOutcome> {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist')
  const res = await run('plutil', ['-convert', 'json', '-o', '-', plistPath])
  if (res.spawnError !== undefined) {
    return { kind: 'spawn-error', spawnError: res.spawnError }
  }
  if (!res.ok) {
    return { kind: 'exit-error', output: res.stderr.trim() !== '' ? res.stderr : res.stdout }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    return { kind: 'unparseable' }
  }
  if (!isPlistDictionary(parsed)) return { kind: 'not-dictionary' }
  return { kind: 'ok', plist: parsed }
}

/**
 * Verify the bundle's `Contents/Info.plist` declares the identity fields a distributable macOS app
 * needs, by converting it to JSON with `plutil -convert json` (which reads both XML and binary
 * plists, so no extra dependency). Confirms `CFBundleIdentifier`, `CFBundleShortVersionString`, and
 * `CFBundleExecutable` are present and non-empty, that the identifier is reverse-DNS, and that the
 * declared executable is a plain file name that actually exists under `Contents/MacOS/`.
 *
 * Classification: a clean parse with every field valid is `pass` (evidence = the bundle id +
 * version); a parsed plist that is missing fields, has a non-reverse-DNS id, or names a
 * non-existent executable is `fail` (a real packaging defect, with remediation); a non-zero
 * `plutil` exit (missing or unparseable plist) is `fail`; a spawn failure — `plutil` absent
 * (non-macOS) or a timeout — is `unknown`. `plutil` ships with the macOS base system, so on macOS
 * it is always present; only off-macOS does this report `unknown`.
 */
export async function checkInfoPlist(appPath: string, run: RunCommand): Promise<CheckResult> {
  const id = 'info-plist' as const
  const read = await readInfoPlist(appPath, run)
  if (read.kind === 'spawn-error') {
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'unknown',
      detail: `plutil could not run (${read.spawnError}); Info.plist fields are only verifiable on macOS.`,
    }
  }
  if (read.kind === 'exit-error') {
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'fail',
      detail: 'plutil could not parse Contents/Info.plist: the file is missing or malformed.',
      ...(read.output.trim() !== '' ? { evidence: firstLine(read.output) } : {}),
      next_actions: ['Repackage the app with a well-formed Contents/Info.plist.'],
    }
  }
  if (read.kind === 'unparseable') {
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'unknown',
      detail: 'plutil exited cleanly but did not produce parseable JSON for Contents/Info.plist.',
    }
  }
  if (read.kind === 'not-dictionary') {
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'fail',
      detail: 'Contents/Info.plist is not a property-list dictionary.',
      next_actions: ['Repackage the app with a Contents/Info.plist whose root is a dictionary.'],
    }
  }
  const plist = read.plist

  const problems: string[] = []
  const missing = REQUIRED_PLIST_KEYS.filter((key) => readPlistString(plist, key) === undefined)
  if (missing.length > 0) problems.push(`missing or empty ${missing.join(', ')}`)

  const bundleId = readPlistString(plist, 'CFBundleIdentifier')
  if (bundleId !== undefined && !REVERSE_DNS_BUNDLE_ID.test(bundleId)) {
    problems.push(`CFBundleIdentifier "${bundleId}" is not a reverse-DNS identifier`)
  }

  const executable = readPlistString(plist, 'CFBundleExecutable')
  if (executable !== undefined) {
    if (!isPlainFileName(executable)) {
      problems.push(`CFBundleExecutable "${executable}" must be a file name, not a path`)
    } else if (!(await isFile(path.join(appPath, 'Contents', 'MacOS', executable)))) {
      problems.push(`CFBundleExecutable "${executable}" is not a file under Contents/MacOS/`)
    }
  }

  if (problems.length > 0) {
    return {
      id,
      title: INFO_PLIST_TITLE,
      status: 'fail',
      detail: `Contents/Info.plist has problems: ${problems.join('; ')}.`,
      next_actions: [
        'Set a reverse-DNS CFBundleIdentifier, a CFBundleShortVersionString, and a CFBundleExecutable that names the binary under Contents/MacOS/.',
      ],
    }
  }

  const version = readPlistString(plist, 'CFBundleShortVersionString')
  const build = readPlistString(plist, 'CFBundleVersion')
  const name = readPlistString(plist, 'CFBundleName')
  const evidence = [
    bundleId,
    version !== undefined ? `v${version}` : undefined,
    build !== undefined ? `(build ${build})` : undefined,
    name !== undefined ? `"${name}"` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ')
  return {
    id,
    title: INFO_PLIST_TITLE,
    status: 'pass',
    detail:
      'Contents/Info.plist declares a reverse-DNS bundle id, a version, and an executable that exists.',
    ...(evidence !== '' ? { evidence } : {}),
  }
}

const PROTOCOL_TITLE = 'URL scheme declarations'

/**
 * RFC 3986 scheme shape: a letter followed by letters, digits, `+`, `-`, or `.`. A declared
 * scheme outside this shape is silently ignored by the OS, so the deep link never opens the app.
 */
const URL_SCHEME_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*$/

/**
 * Schemes owned by the system or other well-known handlers. An Electron app declaring one of
 * these as its own custom scheme is (almost always) a copy-paste defect that hijacks — or loses
 * to — the system handler, so it is classified as a `fail` rather than silently accepted.
 */
const WELL_KNOWN_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'file',
  'ftp',
  'mailto',
  'tel',
  'ws',
  'wss',
])

/** Cap on how many schemes the `evidence` lists before eliding (token economy, ADR-007). */
const MAX_EVIDENCE_SCHEMES = 8

/**
 * Validate the bundle's deep-link declarations: every `CFBundleURLTypes` entry must be a
 * dictionary whose `CFBundleURLSchemes` is a non-empty array of RFC-3986-shaped scheme strings,
 * with no duplicates across entries and no shadowing of well-known schemes (http, mailto, …).
 *
 * Declaring NO custom schemes is a `pass` ("declares no custom URL schemes") — the plist was read
 * and affirmatively contains none, which is a verified-good outcome, not missing evidence. A
 * malformed declaration is a `fail`: the OS ignores entries it cannot read, so `myapp://` links
 * silently stop opening the app. Plist read outcomes classify exactly as in the info-plist check
 * (each check is independent because `runChecks` supports subsets).
 */
export async function checkProtocolSchemes(appPath: string, run: RunCommand): Promise<CheckResult> {
  const id = 'protocol-schemes' as const
  const read = await readInfoPlist(appPath, run)
  if (read.kind === 'spawn-error') {
    return {
      id,
      title: PROTOCOL_TITLE,
      status: 'unknown',
      detail: `plutil could not run (${read.spawnError}); URL scheme declarations are only verifiable on macOS.`,
    }
  }
  if (read.kind === 'exit-error') {
    return {
      id,
      title: PROTOCOL_TITLE,
      status: 'fail',
      detail: 'plutil could not parse Contents/Info.plist: the file is missing or malformed.',
      ...(read.output.trim() !== '' ? { evidence: firstLine(read.output) } : {}),
      next_actions: ['Repackage the app with a well-formed Contents/Info.plist.'],
    }
  }
  if (read.kind === 'unparseable') {
    return {
      id,
      title: PROTOCOL_TITLE,
      status: 'unknown',
      detail: 'plutil exited cleanly but did not produce parseable JSON for Contents/Info.plist.',
    }
  }
  if (read.kind === 'not-dictionary') {
    return {
      id,
      title: PROTOCOL_TITLE,
      status: 'fail',
      detail: 'Contents/Info.plist is not a property-list dictionary.',
      next_actions: ['Repackage the app with a Contents/Info.plist whose root is a dictionary.'],
    }
  }

  const urlTypes = read.plist['CFBundleURLTypes']
  if (urlTypes === undefined || (Array.isArray(urlTypes) && urlTypes.length === 0)) {
    return {
      id,
      title: PROTOCOL_TITLE,
      status: 'pass',
      detail: 'The app declares no custom URL schemes (CFBundleURLTypes is absent or empty).',
    }
  }
  if (!Array.isArray(urlTypes)) {
    return {
      id,
      title: PROTOCOL_TITLE,
      status: 'fail',
      detail: 'CFBundleURLTypes is not an array; the OS ignores the declaration entirely.',
      next_actions: [
        'Declare CFBundleURLTypes as an array of dictionaries with CFBundleURLSchemes.',
      ],
    }
  }

  const problems: string[] = []
  const seen = new Set<string>()
  const schemes: string[] = []
  for (let index = 0; index < urlTypes.length; index++) {
    const entry: unknown = urlTypes[index]
    if (!isPlistDictionary(entry)) {
      problems.push(`entry ${index} is not a dictionary`)
      continue
    }
    const declared = entry['CFBundleURLSchemes']
    if (!Array.isArray(declared) || declared.length === 0) {
      problems.push(`entry ${index} has no CFBundleURLSchemes array (or it is empty)`)
      continue
    }
    for (const scheme of declared) {
      if (typeof scheme !== 'string' || scheme.trim() === '') {
        problems.push(`entry ${index} declares a non-string or empty scheme`)
        continue
      }
      const normalised = scheme.trim().toLowerCase()
      if (!URL_SCHEME_SHAPE.test(normalised)) {
        problems.push(`scheme "${clip(scheme)}" is not a valid URL scheme (RFC 3986)`)
        continue
      }
      if (WELL_KNOWN_SCHEMES.has(normalised)) {
        problems.push(`scheme "${normalised}" shadows a well-known system scheme`)
        continue
      }
      if (seen.has(normalised)) {
        problems.push(`scheme "${clip(normalised)}" is declared more than once`)
        continue
      }
      seen.add(normalised)
      schemes.push(normalised)
    }
  }

  if (problems.length > 0) {
    return {
      id,
      title: PROTOCOL_TITLE,
      status: 'fail',
      detail: `CFBundleURLTypes has problems: ${problems.join('; ')}.`,
      next_actions: [
        'Declare each deep link as { CFBundleURLName, CFBundleURLSchemes: ["<app-scheme>"] } with a unique RFC-3986 scheme.',
      ],
    }
  }
  const listed = schemes.slice(0, MAX_EVIDENCE_SCHEMES).map(clip).join(', ')
  const elided = schemes.length - Math.min(schemes.length, MAX_EVIDENCE_SCHEMES)
  return {
    id,
    title: PROTOCOL_TITLE,
    status: 'pass',
    detail: `The app declares ${schemes.length} well-formed custom URL scheme(s).`,
    evidence: elided > 0 ? `${listed} (+${elided} more)` : listed,
  }
}

const UPDATER_TITLE = 'Updater feed configuration'

/** Where electron-updater embeds its packaged feed configuration inside a macOS bundle. */
const APP_UPDATE_YML = path.join('Contents', 'Resources', 'app-update.yml')

/**
 * Upper bound for a plausible `app-update.yml` before the check refuses to read it. Real
 * electron-updater configs are under 1 KB; this keeps the pure-fs check bounded (the shell-out
 * checks get the same property from the command timeout) so a corrupted multi-hundred-MB file
 * cannot be slurped into memory.
 */
const MAX_FEED_FILE_BYTES = 256 * 1024

/**
 * Extract top-level scalar fields (`key: value` at column 0) from a YAML document. This is a
 * TARGETED extraction, not a YAML parser: electron-updater's `app-update.yml` is a flat scalar map
 * (provider, url, owner, repo, bucket, channel, …), and reading just those lines avoids taking a
 * YAML dependency — the same no-new-deps trade the info-plist check made with `plutil` (ADR-012
 * §2). Indented lines, list items, and nested maps are deliberately ignored; surrounding quotes
 * are stripped. Inline `#` is NOT treated as a comment (URLs legitimately contain fragments).
 */
function extractYamlScalars(text: string): Record<string, string> {
  // Null-prototype: keys come from an untrusted file, and on a plain object a
  // line like `__proto__: x` would silently hit the prototype setter and drop
  // the key instead of storing it.
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/.exec(line)
    if (match === null) continue
    const key = match[1] ?? ''
    let value = (match[2] ?? '').trim()
    if (
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (key !== '' && value !== '') out[key] = value
  }
  return out
}

/**
 * Per-provider required fields — the matrix that catches "feed declared but unfetchable":
 * `generic` needs the feed `url`, `github` needs `owner`+`repo`, `s3`/`spaces` need `bucket`.
 * Providers outside the matrix pass on provider presence alone (forward-compatible with new
 * electron-updater providers).
 */
const PROVIDER_REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  generic: ['url'],
  github: ['owner', 'repo'],
  s3: ['bucket'],
  spaces: ['bucket'],
}

/**
 * Validate the packaged auto-update feed configuration. electron-updater embeds
 * `Contents/Resources/app-update.yml` at build time; this check verifies it declares a `provider`,
 * the provider's required fields (see {@link PROVIDER_REQUIRED_FIELDS}), and that any feed `url`
 * is `https://` — macOS App Transport Security blocks plain HTTP at runtime, so an `http://` feed
 * means the app silently never updates.
 *
 * A bundle WITHOUT the file is `unknown`, not `fail`: Electron's built-in autoUpdater
 * (Squirrel.Mac) configures its feed at runtime via `setFeedURL`, which a static scan cannot see —
 * that is missing evidence, never a defect. Pure filesystem: runs on any host.
 */
export async function checkUpdaterFeed(appPath: string): Promise<CheckResult> {
  const id = 'updater-feed' as const
  const ymlPath = path.join(appPath, APP_UPDATE_YML)
  let text: string
  try {
    const info = await stat(ymlPath)
    if (!info.isFile()) {
      return {
        id,
        title: UPDATER_TITLE,
        status: 'fail',
        detail:
          'Contents/Resources/app-update.yml exists but is not a regular file — the updater cannot read a feed configuration from it.',
        next_actions: [
          'Regenerate the package so electron-builder writes Contents/Resources/app-update.yml as a regular file.',
        ],
      }
    }
    if (info.size > MAX_FEED_FILE_BYTES) {
      return {
        id,
        title: UPDATER_TITLE,
        status: 'fail',
        detail: `Contents/Resources/app-update.yml is implausibly large (${info.size} bytes) for an electron-updater feed config — the packaged file is corrupted.`,
        next_actions: [
          'Regenerate the package so electron-builder writes a normal (sub-kilobyte) app-update.yml.',
        ],
      }
    }
    text = await readFile(ymlPath, 'utf8')
  } catch (err) {
    const missing =
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { readonly code?: unknown }).code === 'ENOENT'
    if (missing) {
      return {
        id,
        title: UPDATER_TITLE,
        status: 'unknown',
        detail:
          'No static updater feed configuration found (Contents/Resources/app-update.yml is absent). electron-updater embeds this file at build time; the built-in autoUpdater sets its feed at runtime, which a static scan cannot verify.',
      }
    }
    return {
      id,
      title: UPDATER_TITLE,
      status: 'unknown',
      detail: `Could not read Contents/Resources/app-update.yml: ${err instanceof Error ? err.message : String(err)}.`,
    }
  }

  if (text.trim() === '') {
    return {
      id,
      title: UPDATER_TITLE,
      status: 'fail',
      detail:
        'Contents/Resources/app-update.yml exists but is empty — the updater has no feed to poll.',
      next_actions: [
        'Regenerate the package with a publish configuration (provider + its fields) so electron-builder writes a complete app-update.yml.',
      ],
    }
  }

  const fields = extractYamlScalars(text)
  const provider = fields['provider']
  const problems: string[] = []
  if (provider === undefined) {
    problems.push('no provider is declared')
  } else {
    // hasOwn, not a bare lookup: a provider value colliding with an
    // Object.prototype member (__proto__, constructor, toString, …) would
    // otherwise resolve to an inherited non-array and crash the check instead
    // of classifying the file.
    const key = provider.toLowerCase()
    const required = Object.hasOwn(PROVIDER_REQUIRED_FIELDS, key)
      ? (PROVIDER_REQUIRED_FIELDS[key] ?? [])
      : []
    const missing = required.filter((field) => fields[field] === undefined)
    if (missing.length > 0) {
      problems.push(`provider "${clip(provider)}" requires ${missing.join(', ')}`)
    }
  }
  const url = fields['url']
  if (url !== undefined) {
    let parsed: URL | undefined
    try {
      parsed = new URL(url)
    } catch {
      problems.push(`url "${clip(url)}" is not a valid URL`)
    }
    if (parsed !== undefined && parsed.protocol !== 'https:') {
      problems.push(
        `url "${clip(url)}" is not https — App Transport Security blocks it at runtime, so updates silently never arrive`,
      )
    }
  }

  if (problems.length > 0) {
    return {
      id,
      title: UPDATER_TITLE,
      status: 'fail',
      detail: `app-update.yml has problems: ${problems.join('; ')}.`,
      next_actions: [
        'Fix the publish configuration (provider plus its required fields, https URLs) and repackage.',
      ],
    }
  }

  const evidenceField = (name: string): readonly string[] => {
    const value = fields[name]
    return value !== undefined ? [`${name}=${clip(value)}`] : []
  }
  const evidence = [
    `provider=${clip(provider ?? '')}`,
    ...evidenceField('url'),
    ...evidenceField('owner'),
    ...evidenceField('repo'),
    ...evidenceField('bucket'),
    ...evidenceField('channel'),
  ].join(' ')
  return {
    id,
    title: UPDATER_TITLE,
    status: 'pass',
    detail: 'app-update.yml declares a provider with its required fields.',
    evidence,
  }
}

const CRASH_TITLE = 'Crash reporter machinery'

/** The framework bundle every packaged Electron app ships on macOS. */
const ELECTRON_FRAMEWORK = path.join('Contents', 'Frameworks', 'Electron Framework.framework')

/** The crashpad handler executable name inside the framework's per-version Helpers directory. */
const CRASHPAD_HANDLER = 'chrome_crashpad_handler'

/**
 * Verify the crash-capture machinery ships intact: the crashpad handler executable must exist
 * (and be executable, on POSIX hosts) under one of the Electron Framework's
 * `Versions/<v>/Helpers/` directories. A repackaging step that prunes or zip-roundtrips the
 * framework can drop the handler or strip its execute bit — either way `crashReporter.start()`
 * silently captures nothing in production.
 *
 * Classification: handler present and executable → `pass` (the detail notes that the runtime
 * submission endpoint — `crashReporter.start({ submitURL })` — is runtime configuration a static
 * scan cannot verify); framework present but handler missing or non-executable → `fail`; no
 * `Electron Framework.framework` at all → `unknown` (not an Electron-shaped bundle — the
 * machinery's expected location does not apply). Pure filesystem: runs on any host.
 */
export async function checkCrashReporter(appPath: string): Promise<CheckResult> {
  const id = 'crash-reporter' as const
  const frameworkPath = path.join(appPath, ELECTRON_FRAMEWORK)
  const versionsPath = path.join(frameworkPath, 'Versions')

  let frameworkInfo: Awaited<ReturnType<typeof stat>>
  try {
    frameworkInfo = await stat(frameworkPath)
  } catch {
    return {
      id,
      title: CRASH_TITLE,
      status: 'unknown',
      detail:
        'No Electron Framework.framework was found in Contents/Frameworks; this does not look like a packaged Electron app, so the crash-capture machinery has no expected location to verify.',
    }
  }
  if (!frameworkInfo.isDirectory()) {
    return {
      id,
      title: CRASH_TITLE,
      status: 'fail',
      detail:
        'Electron Framework.framework exists but is not a directory; the crashpad handler cannot be present at its expected packaged location.',
      next_actions: ['Repackage the app with the full Electron Framework.framework bundle intact.'],
    }
  }

  let versions: readonly string[]
  try {
    versions = await readdir(versionsPath)
  } catch (err) {
    const missing =
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      ['ENOENT', 'ENOTDIR'].includes(String((err as { readonly code?: unknown }).code))
    if (missing) {
      return {
        id,
        title: CRASH_TITLE,
        status: 'fail',
        detail:
          'Electron Framework.framework is present but has no Versions directory, so the crashpad handler is missing from its expected packaged location.',
        next_actions: [
          'Repackage without pruning Electron Framework.framework/Versions/<v>/Helpers/, then re-sign the app.',
        ],
      }
    }
    return {
      id,
      title: CRASH_TITLE,
      status: 'unknown',
      detail: `Could not inspect Electron Framework.framework/Versions: ${err instanceof Error ? err.message : String(err)}.`,
    }
  }

  let foundNonExecutable: string | undefined
  for (const version of versions) {
    const handlerPath = path.join(versionsPath, version, 'Helpers', CRASHPAD_HANDLER)
    let info
    try {
      info = await stat(handlerPath)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const relative = path.join('Versions', version, 'Helpers', CRASHPAD_HANDLER)
    // Windows hosts report no meaningful POSIX mode bits; skip the executability probe there.
    const executable = process.platform === 'win32' || (info.mode & 0o111) !== 0
    if (!executable) {
      foundNonExecutable = relative
      continue
    }
    return {
      id,
      title: CRASH_TITLE,
      status: 'pass',
      detail:
        'The crashpad handler ships intact; whether the app calls crashReporter.start with a submission endpoint is runtime configuration a static scan cannot verify.',
      evidence: relative,
    }
  }

  if (foundNonExecutable !== undefined) {
    return {
      id,
      title: CRASH_TITLE,
      status: 'fail',
      detail: `The crashpad handler exists but is not executable (${foundNonExecutable}) — a zip-based repackaging step likely stripped the execute bit, silently disabling crash capture.`,
      next_actions: [
        'Repackage with a tool that preserves POSIX file modes (or restore with chmod +x) and re-sign the app.',
      ],
    }
  }
  return {
    id,
    title: CRASH_TITLE,
    status: 'fail',
    detail:
      'Electron Framework.framework is present but its crashpad handler (Versions/<v>/Helpers/chrome_crashpad_handler) is missing — crash capture is disabled by packaging.',
    next_actions: [
      'Repackage without pruning the Electron Framework helpers, then re-sign the app.',
    ],
  }
}

const SIGNING_TITLE = 'Code signing'

/** Best-effort signing authority from `codesign -dvvv` (printed on stderr), for `evidence`. */
async function readSigningIdentity(appPath: string, run: RunCommand): Promise<string | undefined> {
  const res = await run('codesign', ['-dvvv', appPath])
  return res.stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('Authority='))
}

/**
 * Verify the app's code signature with `codesign --verify --deep --strict`. A clean run is `pass`
 * (with the signing authority as evidence when readable); a non-zero exit is `fail` (signature
 * missing/invalid/broken seal); a spawn failure — `codesign` absent (non-macOS) or a timeout — is
 * `unknown`.
 *
 * The `pass` path makes a SECOND `codesign -dvvv` call for the signing authority, so a pass costs
 * up to 2× the command timeout; that read is best-effort — if it fails, the `pass` simply carries
 * no `evidence`.
 */
export async function checkCodeSigning(appPath: string, run: RunCommand): Promise<CheckResult> {
  const id = 'code-signing' as const
  const res = await run('codesign', ['--verify', '--deep', '--strict', appPath])
  if (res.spawnError !== undefined) {
    return {
      id,
      title: SIGNING_TITLE,
      status: 'unknown',
      detail: `codesign could not run (${res.spawnError}); code signing is only verifiable on macOS with the developer toolchain installed.`,
    }
  }
  if (res.ok) {
    const identity = await readSigningIdentity(appPath, run)
    return {
      id,
      title: SIGNING_TITLE,
      status: 'pass',
      detail: 'The app passed codesign --verify --deep --strict.',
      ...(identity !== undefined ? { evidence: identity } : {}),
    }
  }
  return {
    id,
    title: SIGNING_TITLE,
    status: 'fail',
    detail: 'codesign --verify failed: the signature is missing, invalid, or the seal is broken.',
    ...(res.stderr.trim() !== '' ? { evidence: firstLine(res.stderr) } : {}),
    next_actions: [
      'Sign the app with a valid Developer ID Application certificate (codesign --deep --options runtime).',
      'Re-run codesign --verify --deep --strict to confirm the seal.',
    ],
  }
}

const NOTARIZATION_TITLE = 'Notarization'

/**
 * Detect the "toolchain unavailable" outcome of `xcrun stapler validate`: xcrun itself ran (so it
 * is not a `spawnError`) but could not find the `stapler` utility, or the active developer
 * directory is invalid (a misconfigured `xcode-select`). That is MISSING evidence — an incomplete
 * developer toolchain → `unknown`, not a real "no stapled ticket" defect → `fail`. Both share a
 * non-zero exit, so they are told apart by the xcrun diagnostic text rather than the exit code.
 */
function isStaplerToolchainUnavailable(res: CommandResult): boolean {
  const output = `${res.stderr}\n${res.stdout}`.toLowerCase()
  return (
    output.includes('unable to find utility "stapler"') ||
    output.includes("unable to find utility 'stapler'") ||
    output.includes('invalid active developer path')
  )
}

/**
 * Best-effort notarization source from `spctl --assess --type execute --verbose` (printed on
 * stderr), for `evidence` on a pass — the `source=Notarized Developer ID` line corroborates that
 * the stapled ticket is Apple-issued.
 */
async function readNotarizationSource(
  appPath: string,
  run: RunCommand,
): Promise<string | undefined> {
  const res = await run('spctl', ['--assess', '--type', 'execute', '--verbose', appPath])
  return res.stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('source='))
}

/**
 * Verify a valid notarization ticket is STAPLED to the bundle via `xcrun stapler validate`. A clean
 * run is `pass` (with the spctl notarization source as evidence when readable); a non-zero exit is
 * `fail` (no/invalid stapled ticket); a spawn failure — `xcrun` absent (non-macOS) or a timeout —
 * is `unknown`.
 *
 * `stapler validate` is OFFLINE — it inspects the ticket embedded in the bundle, with no network
 * lookup — so a non-zero exit reliably means "no valid stapled ticket" (a real defect) and is
 * classified `fail`, never softened to `unknown`. The output stream varies by toolchain version, so
 * the verdict is driven purely by the exit code and `evidence` reads whichever stream is non-empty.
 *
 * The `pass` path makes a SECOND `spctl` call for the notarization source, so a pass costs up to 2×
 * the command timeout; that read is best-effort — if it fails, the `pass` simply carries no
 * `evidence`.
 */
export async function checkNotarization(appPath: string, run: RunCommand): Promise<CheckResult> {
  const id = 'notarization' as const
  const res = await run('xcrun', ['stapler', 'validate', appPath])
  if (res.spawnError !== undefined) {
    return {
      id,
      title: NOTARIZATION_TITLE,
      status: 'unknown',
      detail: `xcrun stapler could not run (${res.spawnError}); notarization is only verifiable on macOS with the developer toolchain installed.`,
    }
  }
  if (isStaplerToolchainUnavailable(res)) {
    return {
      id,
      title: NOTARIZATION_TITLE,
      status: 'unknown',
      detail:
        'xcrun ran, but stapler is unavailable or the active developer directory is invalid; notarization is only verifiable with a working macOS developer toolchain.',
      ...(res.stderr.trim() !== '' ? { evidence: firstLine(res.stderr) } : {}),
    }
  }
  if (res.ok) {
    const source = await readNotarizationSource(appPath, run)
    return {
      id,
      title: NOTARIZATION_TITLE,
      status: 'pass',
      detail: 'A valid notarization ticket is stapled to the app (xcrun stapler validate passed).',
      ...(source !== undefined ? { evidence: source } : {}),
    }
  }
  // stapler prints to stdout in some toolchain versions and stderr in others; read whichever is
  // non-empty so the evidence survives either.
  const failOutput = res.stderr.trim() !== '' ? res.stderr : res.stdout
  return {
    id,
    title: NOTARIZATION_TITLE,
    status: 'fail',
    detail:
      'No valid notarization ticket is stapled to the app (xcrun stapler validate failed): it was never notarized, or the ticket was not stapled into the bundle.',
    ...(failOutput.trim() !== '' ? { evidence: firstLine(failOutput) } : {}),
    next_actions: [
      'Notarize the app with the Apple notary service (xcrun notarytool submit --wait).',
      'Staple the issued ticket into the bundle (xcrun stapler staple) so it validates offline.',
      'Re-run xcrun stapler validate to confirm the ticket is attached.',
    ],
  }
}

const GATEKEEPER_TITLE = 'Gatekeeper assessment'

/**
 * Assess whether Gatekeeper will accept the app for execution via `spctl --assess --type execute`.
 * Acceptance is `pass`; rejection is `fail` (unsigned, not notarized, or untrusted); a spawn
 * failure — `spctl` absent (non-macOS) or a timeout — is `unknown`.
 */
export async function checkGatekeeper(appPath: string, run: RunCommand): Promise<CheckResult> {
  const id = 'gatekeeper' as const
  const res = await run('spctl', ['--assess', '--type', 'execute', '--verbose', appPath])
  if (res.spawnError !== undefined) {
    return {
      id,
      title: GATEKEEPER_TITLE,
      status: 'unknown',
      detail: `spctl could not run (${res.spawnError}); Gatekeeper assessment is only available on macOS.`,
    }
  }
  if (res.ok) {
    return {
      id,
      title: GATEKEEPER_TITLE,
      status: 'pass',
      detail: 'Gatekeeper accepts the app for execution (spctl --assess passed).',
    }
  }
  return {
    id,
    title: GATEKEEPER_TITLE,
    status: 'fail',
    detail:
      'Gatekeeper rejected the app (spctl --assess failed): it is unsigned, not notarized, or the signature is not trusted.',
    ...(res.stderr.trim() !== '' ? { evidence: firstLine(res.stderr) } : {}),
    next_actions: [
      'Notarize the app with the Apple notary service and staple the ticket (xcrun notarytool + stapler).',
      'Re-run spctl --assess --type execute to confirm acceptance.',
    ],
  }
}

/** Maps each id to its runner. Bundle ignores the command runner (pure filesystem). */
const RUNNERS: Readonly<
  Record<CheckId, (appPath: string, run: RunCommand) => Promise<CheckResult>>
> = {
  'bundle-structure': (appPath) => checkBundleStructure(appPath),
  'info-plist': (appPath, run) => checkInfoPlist(appPath, run),
  'protocol-schemes': (appPath, run) => checkProtocolSchemes(appPath, run),
  'updater-feed': (appPath) => checkUpdaterFeed(appPath),
  'crash-reporter': (appPath) => checkCrashReporter(appPath),
  'code-signing': (appPath, run) => checkCodeSigning(appPath, run),
  notarization: (appPath, run) => checkNotarization(appPath, run),
  gatekeeper: (appPath, run) => checkGatekeeper(appPath, run),
}

/**
 * Run the selected checks (default: all) against `appPath`, always in the canonical
 * {@link CHECK_IDS} order regardless of the order requested, and deduped — so the result is
 * deterministic. Checks run sequentially; each is independent and self-classifying.
 */
export async function runChecks(
  appPath: string,
  run: RunCommand,
  ids: readonly CheckId[] = CHECK_IDS,
): Promise<readonly CheckResult[]> {
  const requested = new Set(ids)
  const results: CheckResult[] = []
  for (const id of CHECK_IDS) {
    if (requested.has(id)) results.push(await RUNNERS[id](appPath, run))
  }
  return results
}
