# @electron-stagewright/plugin-production

Validate a packaged **macOS** app for production readiness and get back structured results. Where
the rest of Electron Stagewright drives a _running_ app, this plugin (ADR-012, built on the ADR-004
plugin contract) inspects the **build artifact on disk** — is the `.app` a well-formed bundle, is it
code-signed, will Gatekeeper accept it — the failures that only bite on a user's machine.

One tool, `production_validate`, runs a set of checks against an app path and returns each as
`pass`, `fail`, or `unknown`. The load-bearing distinction is **`unknown` (missing evidence)** —
a required tool is absent, a file is missing, or the host is not macOS — versus **`fail` (verified
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
(`codesign`, `spctl`) against a path on disk, not into app code.

## Tool

The loader namespaces the tool under the plugin name `production`:

- **`production_validate`** `{ appPath, checks? }` — validate the packaged `.app` at `appPath`
  (absolute path). `checks` optionally names a subset (`bundle-structure`, `code-signing`,
  `notarization`, `gatekeeper`); omit to run all. Returns:

  ```json
  {
    "ok": true,
    "app_path": "/path/to/My.app",
    "passed": false,
    "summary": { "pass": 1, "fail": 2, "unknown": 1 },
    "checks": [
      {
        "id": "bundle-structure",
        "title": "macOS app bundle structure",
        "status": "pass",
        "detail": "…"
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
      { "id": "gatekeeper", "title": "Gatekeeper assessment", "status": "unknown", "detail": "…" }
    ]
  }
  ```

  The envelope `ok` is `true` whenever validation **ran**; the app's own verdict is `passed` (no
  failed checks — `unknown` checks do not flip it, but `summary` reports them). A `fail` carries
  `next_actions` with remediation. Errors: `ABSOLUTE_PATH_REQUIRED` (relative `appPath`),
  `production.APP_NOT_FOUND` (no file/dir at `appPath`), `production.NOT_A_BUNDLE` (`appPath` is not
  a directory).

## Checks

| id                 | What it verifies                                                        | How                                 |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------- |
| `bundle-structure` | The `.app` has `Contents/Info.plist` and a `Contents/MacOS/` executable | Filesystem (cross-platform)         |
| `code-signing`     | The signature is present and valid                                      | `codesign --verify --deep --strict` |
| `notarization`     | A valid notarization ticket is stapled to the bundle                    | `xcrun stapler validate`            |
| `gatekeeper`       | Gatekeeper will accept the app for execution                            | `spctl --assess --type execute`     |

Forthcoming: updater feeds, custom protocol schemes, crash-reporter configuration, and field-level
`Info.plist` checks (bundle id / version).

## Platform

macOS is the first-class target — that is where signing/notarization pain lives. On a non-macOS
host the `codesign` / `xcrun stapler` / `spctl` checks report `unknown` (the tools are absent), not
`fail`; the bundle-structure check still runs everywhere. Notarization is also `unknown` on macOS
when the developer toolchain is incomplete — `xcrun` runs but cannot find `stapler`, or
`xcode-select` points at an invalid path — since the ticket cannot be verified. Each external
command is timeout-bounded
(`commandTimeoutMs`) so a hung tool cannot wedge the call.

`xcrun stapler validate` inspects the notarization ticket **embedded** in the bundle and needs no
network, so a notarization `fail` is authoritative — the ticket is genuinely missing or invalid,
not a transient online lookup.
