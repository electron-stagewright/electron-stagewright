# ADR-024: Target app runtime selection

- **Status**: Accepted
- **Date**: 2026-07-14
- **Deciders**: johnny4young

## Context

Electron applications can load native addons that were compiled for a particular Electron
`NODE_MODULE_VERSION`. A server-launched default Electron binary can differ from the app's installed
runtime, which can turn an otherwise valid launch into a native-module ABI failure. Operators need a
way to select the target project's Electron binary without allowing an agent to choose arbitrary
host paths or execute project dependency code during preflight.

The same problem needs observable diagnostics. A version string alone is not enough: Node, V8, and
`NODE_MODULE_VERSION` determine native compatibility, while an addon inventory is useful evidence but
cannot safely be an unbounded filesystem crawl.

## Decision

1. **`runtime: "project"` is an explicit launch mode.**
   When `electron_launch` resolves the app-root runtime, it requires an app `main` entry and an
   operator-configured `--app-root`. The agent cannot provide or replace the root. If an explicit
   `executablePath` is present, it remains authoritative for compatibility with reviewed packaged
   binary launches.

2. **Resolution is metadata-only and root-confined.**
   The server resolves `electron/package.json` from the app root, reads Electron's package metadata
   and `path.txt`, canonicalizes the manifest and binary, and rejects either path when it escapes the
   canonical root. It never imports the target app or Electron's package entry: importing that entry
   can execute dependency code or attempt to download a missing runtime.

3. **The existing transport launch seam remains unchanged.**
   The lifecycle tool passes the selected canonical path through `LaunchOptions.executablePath` to
   the Playwright transport. Runtime selection is a tool-layer authorization and resolution policy,
   not a transport capability; attach-only transports do not participate.

4. **Diagnostics are additive and non-mutating.**
   `doctor --json` and `electron_doctor` return `runtime.server` facts (core, Playwright, default
   Electron, Node, V8, ABI) and, when an app root is configured, `runtime.project` facts (declared and
   installed Electron, fixed target-binary probe, bounded potential-native-addon inventory). The
   target probe has a fixed expression, narrow allowlisted environment, timeout, and output cap.
   Alignment and inventory failures warn; a safety-limit marker remains explicit in the inventory
   without turning an otherwise healthy preflight into a failure. Existing required preflight failures
   alone determine `doctor_ok` and the CLI exit code.

5. **Addon inventory is bounded evidence.**
   It never follows symlinks, skips repository metadata, prioritizes app build and direct dependency
   paths before pnpm's large store, and caps depth, directories, and returned paths. Its `truncated`
   field makes incompleteness explicit rather than claiming that no hidden addon exists.

## Alternatives considered

| Alternative                                                        | Why rejected                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Always use the server's default Electron                           | Breaks apps whose native addons require the target Electron ABI.                                          |
| Let the agent provide a project root or binary without confinement | Turns a runtime preference into arbitrary host path selection and process execution.                      |
| Import `require("electron")` to discover its executable            | Electron's package entry can execute code or download a runtime during a diagnostic/launch preflight.     |
| Rebuild native addons automatically                                | Mutates the target project, can select the wrong toolchain, and obscures the operator's intended runtime. |
| Scan every project file for `.node` binaries                       | Makes a diagnostic unbounded and still cannot prove which addons the app will load.                       |

## Consequences

- Operators can make target-runtime selection an intentional, auditable launch choice without
  granting the agent a broader root.
- A monorepo package whose Electron dependency is hoisted above its selected root is refused by
  design. Configure the workspace root or use an explicitly reviewed executable instead.
- Doctor can flag likely native-ABI risk before launch while preserving existing strict failures for
  missing Node, launch peers, display, or configured paths.
- Native addon results are potential evidence. Consumers must read the bounded list and its
  `truncated` marker rather than treating it as an exhaustive runtime dependency graph.

## References

- [ADR-003](./003-transport-abstraction.md) — the existing transport launch seam.
- [ADR-007](./007-agent-native-ux-principles.md) — explicit recovery and honest diagnostic state.
- [ADR-014](./014-security-posture-and-threat-model.md) — app-root and privileged-local-tool posture.
- [Launch, attach, or inject](../guides/launch-or-attach.md) — operator workflow and recovery steps.

## Status Update — 2026-07-15: `path.txt` is a hint, not the source of truth

Decision 2 described resolution as reading Electron's `path.txt` to identify the installed binary,
and the first implementation required that file. Measurement showed the requirement was wrong.

`path.txt` is written by Electron's install script. An install can legitimately skip that script and
still lay the binary down at its conventional `dist/` location, and Playwright launches such an
install without complaint. Requiring the file therefore reported a working runtime as missing: in one
`electron_doctor` session the `electron` check failed with `ENOENT ... path.txt` while
`electron_launch` in that same session succeeded, and `electron_info` showed the app running from
`node_modules/electron/dist/`. The published `npx` quickstart provisions exactly that shape, so the
diagnostic contradicted the very path the documentation recommends.

Resolution now consults `path.txt` first and falls back to the platform's conventional `dist/`
executable when it is absent. Every property this record relies on is unchanged: resolution stays
metadata-only (the package entry is still never imported), the candidate must still resolve inside
`dist/`, project resolution still confines it to the app root, and a package with neither a recorded
nor a conventional binary still fails honestly.
