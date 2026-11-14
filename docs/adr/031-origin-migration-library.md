# ADR-031: Origin migration library

- **Status:** Proposed
- **Date:** 2026-11-13

## Context

An Electron app that moves its renderer from `file://` to a custom scheme (for the V8 code cache, a
real origin, CORS, or a stricter file policy) changes its storage origin. Chromium keys
`localStorage`, the origin private file system (OPFS), IndexedDB and cookies by origin, so the
first launch on the new scheme starts empty. Settings reset and local databases disappear.

The copy has to happen once, in the user's own profile, at startup, and it must survive a crash,
a full disk or a quit in the middle. A second launch must not repeat it, and a later launch must
not bring back data the user deleted. An older build must still open with its `file://` data.

One app has shipped this copy and proved it with a real-profile smoke. The code is generic apart
from a few names.

## Decision

Ship `@electron-stagewright/origin-migration`, a library the app calls from its own main process.
It is not a Stagewright plugin and registers no MCP tool.

- **Library, not plugin.** The migration runs inside the shipped app on every user's machine, on
  the first launch of the new build. A plugin runs in an agent or CI session against a test
  profile and cannot do that. Verifying the result already needs no new tool: `plugin-storage`
  reads `localStorage`, and the smoke reads OPFS through renderer eval.
- **Two hidden, sandboxed pages do the copy.** One loads an empty document from a private temp
  folder (the `file://` origin), the other loads an empty document the app serves on the new
  origin. Main moves data between them with fixed scripts through `executeJavaScript`. The pages
  have no preload, cannot navigate, and deny window opening.
- **Never overwrite, never edit the source.** A `localStorage` key the new origin already holds
  keeps its value. The `file://` copy is never written.
- **Files are staged, then moved.** Each OPFS file is copied in 1 MiB chunks into a staging file,
  and only when every file is staged do the moves begin. A database and its `.wal` move as a
  group, database first; the target's own WAL is set aside and restored if the database move
  fails. A WAL without its database is never copied. Only `<name>.wal` sidecars (DuckDB) are
  grouped; SQLite's `-wal`, `-journal` and `-shm` are out of scope for now.
- **A marker in `userData` owns retries.** It is written before any page opens, so a crash spends
  an attempt. It records each completed group, so a retry never restores a group the user deleted
  after it landed. Three attempts in all; then the app stops trying. Only a missing marker starts
  a copy: one that exists but cannot be read counts as done, since a fresh copy would replace
  current data with stale data. The marker name is an option,
  so an app that already shipped its own marker keeps it.
- **Errors are recorded by name or code only.** Messages can carry paths.
- **v0 scope is `localStorage` and OPFS.** IndexedDB and cookies are not copied until each has its
  own real-Electron test.
- **Electron is a peer dependency, used for types only.** The app passes its `BrowserWindow` and
  `session`, so the package never imports Electron at run time and its tests run in Node.

## Alternatives considered

- **Copy the LevelDB and OPFS folders on disk before Chromium starts.** Faster, but the on-disk
  layout and origin keys are Chromium internals that change between versions, and Chromium creates
  `Local Storage` before any page loads, so a disk probe cannot tell a fresh profile from an old
  one.
- **A Stagewright tool that performs the migration in a session.** Rejected: users never run
  Stagewright, so the data would never move on their machines.
- **A standalone repository**, as first sketched. Rejected: this monorepo already runs real Electron
  on three systems in CI, and the smoke belongs there.

## Consequences

- The app must serve an empty document on the new origin (`blankDocumentResponse()` helps) and run
  the migration before its renderer loads from that origin.
- A `file://` page needs the `GrantFileProtocolExtraPrivileges` fuse to read `localStorage`. With
  the fuse off, the copy records `localStorageUnreadable` and still moves OPFS files. The release
  that migrates must keep the fuse on.
- Destroying the only open window fires `window-all-closed`, so the app should create its main
  window (hidden) before the migration opens and closes its pages.
- The library ships in the app's production bundle, unlike every other package here. Its only
  runtime dependencies are Node built-ins.
