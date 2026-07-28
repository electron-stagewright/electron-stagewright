# @electron-stagewright/plugin-production

Validate packaged **macOS, Windows, and Linux** artifacts for production readiness and get back
structured results. Where
the rest of Electron Stagewright drives a _running_ app, this plugin (ADR-012, built on the ADR-004
plugin contract) inspects the **build artifact on disk**. It checks macOS bundle integrity,
signing, notarization, and Gatekeeper; Windows Authenticode; and AppImage embedded signatures —
the failures that only bite on a user's machine.

One tool, `production_validate`, runs a set of checks against an app path and returns each as
`pass`, `fail`, or `unknown`. The load-bearing distinction is **`unknown` (missing evidence)** —
a required platform tool or public key is absent, or a command times out — versus **`fail`
(verified bad)**. A green result with `unknown` checks is never silently mistaken for full
verification: the summary discloses every category.

## Use it without MCP

The checks are a public library API and a CI-friendly CLI. Install this package beside
`@electron-stagewright/core`, then run:

```sh
electron-stagewright production validate \
  --app /absolute/path/to/My.AppImage \
  --json
```

The package also installs a direct binary with the same parser and report contract:

```sh
electron-stagewright-production validate \
  --app C:/absolute/path/to/MySetup.exe \
  --checks windows-authenticode \
  --json
```

JSON mode writes exactly one `electron-stagewright-production-validation` version-1 report to
stdout. Diagnostics stay on stderr. Exit codes are stable for CI:

- `0` — validation ran and no check failed (`unknown` remains visible in the summary);
- `1` — validation ran and at least one check failed;
- `2` — invalid command usage, path, options, or an unavailable validation entrypoint.

Programmatic consumers use the same engine directly:

```js
import { validateProductionApp } from '@electron-stagewright/plugin-production'

const report = await validateProductionApp('/absolute/path/to/My.AppImage', {
  commandTimeoutMs: 15_000,
})
```

`validateProductionApp()` detects the artifact family and returns
`{ app_path, artifact_type, passed, summary, checks }`. Omit `checks` to run the artifact-aware
defaults, or provide an explicit subset. Verified defects remain check data; caller errors throw
`ProductionValidationError` with a stable `code`.

## Load it

```sh
# By package name (once installed):
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-production

# Configure (optional): per-command timeout in ms (default 10000):
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-production \
  --plugin-config production='{"commandTimeoutMs":15000}'
```

Programmatically:

```js
import { createServer } from '@electron-stagewright/core'
import productionPlugin from '@electron-stagewright/plugin-production'

const server = await createServer({ plugins: [productionPlugin] })
```

The MCP tool delegates to the same `validateProductionApp()` API used by the standalone CLI, so
check ordering, verdicts, timeouts, and summaries cannot drift between delivery channels.

It needs **no `--allow-eval`** and **no running app session**. It invokes bounded platform
validators against a path on disk and never executes the inspected artifact.

## Tool

The loader namespaces the tool under the plugin name `production`:

- **`production_validate`** `{ appPath, checks? }` — validate a packaged `.app`, `.exe`, `.msi`, or
  `.AppImage` at an absolute `appPath`. `checks` optionally names a subset; omit it to run the
  defaults for the detected artifact family. Returns:

  ```json
  {
    "ok": true,
    "app_path": "/path/to/My.app",
    "artifact_type": "macos-app",
    "passed": false,
    "summary": { "pass": 5, "fail": 3, "unknown": 0 },
    "checks": [
      {
        "id": "bundle-structure",
        "title": "macOS app bundle structure",
        "status": "pass",
        "detail": "…"
      },
      {
        "id": "info-plist",
        "title": "Info.plist metadata",
        "status": "pass",
        "detail": "…",
        "evidence": "com.example.app v1.2.3"
      },
      {
        "id": "protocol-schemes",
        "title": "URL scheme declarations",
        "status": "pass",
        "detail": "…",
        "evidence": "exampleapp"
      },
      {
        "id": "updater-feed",
        "title": "Updater feed configuration",
        "status": "pass",
        "detail": "…",
        "evidence": "provider=github owner=acme repo=exampleapp"
      },
      {
        "id": "crash-reporter",
        "title": "Crash reporter machinery",
        "status": "pass",
        "detail": "…",
        "evidence": "Versions/A/Helpers/chrome_crashpad_handler"
      },
      {
        "id": "code-signing",
        "title": "Code signing",
        "status": "fail",
        "detail": "…",
        "evidence": "…",
        "next_actions": ["…"]
      },
      {
        "id": "notarization",
        "title": "Notarization",
        "status": "fail",
        "detail": "…",
        "next_actions": ["…"]
      },
      {
        "id": "gatekeeper",
        "title": "Gatekeeper assessment",
        "status": "fail",
        "detail": "…",
        "next_actions": ["…"]
      }
    ]
  }
  ```

  The envelope `ok` is `true` whenever validation **ran**; the app's own verdict is `passed` (no
  failed checks — `unknown` checks do not flip it, but `summary` reports them). A `fail` carries
  `next_actions` with remediation. Errors: `ABSOLUTE_PATH_REQUIRED` (relative `appPath`),
  `production.APP_NOT_FOUND` (no file/dir at `appPath`), `production.NOT_A_BUNDLE` (a `.app` path
  is not a directory), or `production.UNSUPPORTED_ARTIFACT` (unsupported file type).

## Checks

| id                     | What it verifies                                                                                               | How                                 | Runs on                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------ |
| `bundle-structure`     | The `.app` has `Contents/Info.plist` and a `Contents/MacOS/` executable                                        | Filesystem                          | Any host                 |
| `info-plist`           | Info.plist declares the required identity fields                                                               | `plutil -convert json`              | macOS (else `unknown`)   |
| `protocol-schemes`     | `CFBundleURLTypes` deep-link declarations are well-formed, unique, and shadow no system scheme                 | `plutil -convert json`              | macOS (else `unknown`)   |
| `updater-feed`         | A packaged `app-update.yml` declares a provider with its required fields and `https` URLs (absent → `unknown`) | Filesystem                          | Any host                 |
| `crash-reporter`       | The crashpad handler ships intact and executable inside `Electron Framework.framework`                         | Filesystem                          | Any host                 |
| `code-signing`         | The macOS signature is present and valid                                                                       | `codesign --verify --deep --strict` | macOS (else `unknown`)   |
| `notarization`         | A valid notarization ticket is stapled to the bundle                                                           | `xcrun stapler validate`            | macOS (else `unknown`)   |
| `gatekeeper`           | Gatekeeper will accept the app for execution                                                                   | `spctl --assess --type execute`     | macOS (else `unknown`)   |
| `windows-authenticode` | Windows reports a valid Authenticode signature                                                                 | `Get-AuthenticodeSignature`         | Windows (else `unknown`) |
| `appimage-signature`   | The embedded AppImage OpenPGP signature validates against an available public key                              | AppImageKit `validate` helper       | Linux (else `unknown`)   |

Two `unknown` semantics worth knowing:

- **`updater-feed`** is `unknown` when no `Contents/Resources/app-update.yml` exists — Electron's
  built-in autoUpdater configures its feed **at runtime** (`setFeedURL`), which a static scan
  cannot see. The check only turns `fail` when a packaged feed file exists and is incoherent
  (no provider, missing provider fields, or a non-`https` URL that App Transport Security would
  block at runtime).
- **`crash-reporter`** is `unknown` when no `Electron Framework.framework` exists (not an
  Electron-shaped bundle). It is a `fail` when the framework is present but the crashpad handler
  is missing or lost its execute bit (zip-roundtrip repackaging does this) — either condition
  silently disables crash capture in production. Whether the app actually calls
  `crashReporter.start` with a submission endpoint is runtime configuration, outside a static
  scan's reach.

## Platform

Artifact-aware defaults avoid irrelevant cross-platform failures:

- a `.app` directory runs the eight macOS bundle and trust checks;
- a `.exe` or `.msi` file runs `windows-authenticode`;
- a `.AppImage` file runs `appimage-signature`.

Windows validation uses the built-in Windows PowerShell
`Get-AuthenticodeSignature -LiteralPath` cmdlet. The artifact path is passed as base64 data rather
than interpolated into PowerShell code. `Valid` passes; unsigned, hash-mismatched, invalid, or
untrusted signatures fail; unsupported formats and unavailable tooling remain `unknown`.

AppImage's own `--appimage-signature` flag only displays a signature and would execute untrusted
artifact code. This plugin never invokes it. Instead, it uses AppImageKit's external `validate`
helper and requires both a zero exit and a `Good signature` marker. A missing public key is
`unknown`; an absent or bad embedded signature is `fail`.

On a host without the relevant toolchain, platform checks report `unknown`, not `fail`. Each
external command is timeout-bounded (`commandTimeoutMs`) so a hung tool cannot wedge the call.

`xcrun stapler validate` inspects the notarization ticket **embedded** in the bundle and needs no
network, so a notarization `fail` is authoritative — the ticket is genuinely missing or invalid,
not a transient online lookup.
