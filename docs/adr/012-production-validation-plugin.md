# ADR-012: Production validation plugin

Status: Accepted. Current checks cover bundle structure, Info.plist fields, code signing,
notarization (`xcrun stapler validate`), and Gatekeeper.

## Context

Electron's sharpest production pain is distribution: an app that runs fine in development fails on a
user's machine because it is unsigned, not notarized, or its bundle is malformed — and the failure
is opaque. Stagewright drives _running_ apps; nothing inspects the _build artifact_. The production
validation plugin closes that: given a packaged `.app`, report — structured — whether it is
production-ready.

The acceptance criteria carry one subtle requirement: **distinguish missing evidence from failed
evidence.** "I checked and the signature is invalid" and "I could not check (no toolchain here)"
are different answers; collapsing them produces false confidence or false alarms.

## Decision

### 1. A three-valued evidence model

Every check returns `status: 'pass' | 'fail' | 'unknown'`:

- `pass` — verified good.
- `fail` — verified bad (a real packaging/signing defect); carries `next_actions` remediation.
- `unknown` — could not be determined: a required CLI is absent, a command times out, or the host
  is not macOS. **Missing evidence, never conflated with `fail`.**

The tool returns `{ ok, app_path, passed, summary: { pass, fail, unknown }, checks }`. The envelope
`ok` is `true` whenever validation RAN; the app's verdict is `passed` (no `fail`). `unknown` checks
do not flip `passed`, but `summary` discloses them so a green-with-skips result is never mistaken
for full verification. Only a bad input (no app at `appPath`) is a tool error
(`production.APP_NOT_FOUND` / `production.NOT_A_BUNDLE`) — a failed CHECK is data, not an error,
matching the AC's "return structured failures".

### 2. Shell out to the toolchain, not into app code

The checks invoke the macOS toolchain (`codesign --verify --deep --strict`, `spctl --assess`,
`xcrun stapler validate`, `plutil -convert json`) rather than evaluating app JavaScript. So the
plugin needs **no `--allow-eval`** and **no running session** — it inspects a path on disk. Every
spawn is timeout-bounded via a shared `runCommand`
(execFile + timeout + capped output) that never rejects; a command-not-found or timeout becomes
`spawnError`, which the checks map to `unknown`. There is deliberately **no platform branch**: on a
non-macOS host the tools are simply absent (ENOENT → `unknown`), which also lets tests drive every
branch through a fake `runCommand` on any OS.

### 3. macOS first; bundle structure stays dependency-free

macOS is the first-class target. The bundle-structure check is pure filesystem (Info.plist +
`Contents/MacOS/` executable present), so it runs anywhere and needs no plist parser. The
notarization check uses `xcrun stapler validate` to confirm a ticket is stapled to the bundle
(offline, so a non-zero exit is a real `fail`, never `unknown`); a `pass` reads the `spctl`
`source=` line as best-effort evidence. The info-plist check shells out to
`plutil -convert json` (which reads both XML and binary plists) and verifies CFBundleIdentifier
(reverse-DNS), CFBundleShortVersionString, and a CFBundleExecutable that exists under
`Contents/MacOS/`. Still deferred: updater feeds, protocol schemes, crash reporter.

## Alternatives considered

- **Boolean pass/fail only** — cannot express "couldn't check", the exact distinction the AC wants.
- **Parse signing/plist data in-process** (no shell-out) — would reimplement `codesign`/`spctl`
  semantics and a binary-plist parser; the system tools are the source of truth on macOS.
- **Gate behind `--allow-eval`** — unnecessary; this runs external CLIs against a file, not app
  code. (It DOES spawn processes — a capability documented in the README — but that is not eval.)

## Consequences

- New package `@electron-stagewright/plugin-production` with one tool, `production_validate`, and
  two error codes. No core change.
- The full value (a `pass` on signing/Gatekeeper) needs a real signed app; unit tests use a fake
  `runCommand` (pass/fail/unknown) + a synthetic bundle, and a gated smoke runs the real CLIs.
- Spawning external processes is a new capability for the plugin surface; it is bounded and
  documented, and runs only when the operator loads this plugin.

## Related decisions

- ADR-004 (plugin model) — the contract this is built on.
- ADR-006 (error code registry) — the namespaced `production.*` codes.

## References

- `packages/plugin-production/src/checks.ts` — the `CheckResult` model + the production checks.
- `packages/plugin-production/src/command.ts` — the bounded `runCommand`.
- `packages/plugin-production/src/index.ts` — the plugin + `production_validate`.
