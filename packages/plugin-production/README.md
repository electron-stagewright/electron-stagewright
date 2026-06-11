# @electron-stagewright/plugin-production

Validate a packaged **macOS** app for production readiness and get back structured results. Where
the rest of Electron Stagewright drives a _running_ app, this plugin (ADR-012, built on the ADR-004
plugin contract) inspects the **build artifact on disk** — is the `.app` a well-formed bundle, does
its Info.plist identify the app and declare well-formed deep links, is its auto-update feed
coherent, does the crash-capture machinery ship intact, is it code-signed and notarized, will
Gatekeeper accept it — the failures that only bite on a user's machine.

One tool, `production_validate`, runs a set of checks against an app path and returns each as
`pass`, `fail`, or `unknown`. The load-bearing distinction is **`unknown` (missing evidence)** —
a required tool is absent, a command times out, or the host is not macOS — versus **`fail` (verified
bad)**. A green result with `unknown` checks is never silently mistaken for full verification: the
summary discloses every category.

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

It needs **no `--allow-eval`** and **no running app session** — it shells out to the macOS toolchain
(`plutil`, `codesign`, `xcrun stapler`, `spctl`) against a path on disk, not into app code.

## Tool

The loader namespaces the tool under the plugin name `production`:

- **`production_validate`** `{ appPath, checks? }` — validate the packaged `.app` at `appPath`
  (absolute path). `checks` optionally names a subset (`bundle-structure`, `info-plist`,
  `protocol-schemes`, `updater-feed`, `crash-reporter`, `code-signing`, `notarization`,
  `gatekeeper`); omit to run all. Returns:

  ```json
  {
    "ok": true,
    "app_path": "/path/to/My.app",
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
  `production.APP_NOT_FOUND` (no file/dir at `appPath`), `production.NOT_A_BUNDLE` (`appPath` is not
  a directory).

## Checks

| id                 | What it verifies                                                                                               | How                                 | Runs on                |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------- |
| `bundle-structure` | The `.app` has `Contents/Info.plist` and a `Contents/MacOS/` executable                                        | Filesystem                          | Any host               |
| `info-plist`       | Info.plist declares the required identity fields                                                               | `plutil -convert json`              | macOS (else `unknown`) |
| `protocol-schemes` | `CFBundleURLTypes` deep-link declarations are well-formed, unique, and shadow no system scheme                 | `plutil -convert json`              | macOS (else `unknown`) |
| `updater-feed`     | A packaged `app-update.yml` declares a provider with its required fields and `https` URLs (absent → `unknown`) | Filesystem                          | Any host               |
| `crash-reporter`   | The crashpad handler ships intact and executable inside `Electron Framework.framework`                         | Filesystem                          | Any host               |
| `code-signing`     | The signature is present and valid                                                                             | `codesign --verify --deep --strict` | macOS (else `unknown`) |
| `notarization`     | A valid notarization ticket is stapled to the bundle                                                           | `xcrun stapler validate`            | macOS (else `unknown`) |
| `gatekeeper`       | Gatekeeper will accept the app for execution                                                                   | `spctl --assess --type execute`     | macOS (else `unknown`) |

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

macOS is the first-class target — that is where signing/notarization pain lives. On a non-macOS
host the `codesign` / `xcrun stapler` / `spctl` / `plutil` checks report `unknown` (the tools are
absent), not `fail`; the pure-filesystem checks (`bundle-structure`, `updater-feed`,
`crash-reporter`) run everywhere — see the "Runs on" column above for what `unknown` means per
check on an off-macOS CI host. Notarization is also `unknown` on macOS when the developer
toolchain is incomplete — `xcrun` runs but cannot find `stapler`, or `xcode-select` points at an
invalid path — since the ticket cannot be verified. Each external command is timeout-bounded
(`commandTimeoutMs`) so a hung tool cannot wedge the call.

`xcrun stapler validate` inspects the notarization ticket **embedded** in the bundle and needs no
network, so a notarization `fail` is authoritative — the ticket is genuinely missing or invalid,
not a transient online lookup.
