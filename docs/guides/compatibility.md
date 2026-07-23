# Compatibility

Use this page to distinguish package compatibility from combinations Electron Stagewright actually
proves in CI. “Supported” means the project accepts regressions for that surface; “real-runtime
verified” means a required hosted job launches Electron and drives the complete gated suite.

## Runtime matrix

| Operating system | Node 24            | Node 26            | Real Electron      | Notes                                                              |
| ---------------- | ------------------ | ------------------ | ------------------ | ------------------------------------------------------------------ |
| Ubuntu latest    | Unit + integration | Unit + integration | Node 24 under Xvfb | Also proves the Linux native-addon runtime fixture.                |
| macOS latest     | Unit + integration | Unit + integration | Node 24 native     | Also proves the macOS native-addon runtime fixture and packed CLI. |
| Windows latest   | Unit + integration | Unit + integration | Node 24 native     | Native-addon ABI recovery is not yet part of the Windows fixture.  |

The package requires Node 24 or newer. CI exercises Node 24 and 26; versions newer than 26 may work
but are not yet part of the maintained matrix.

The repository currently develops and validates against Electron 42 and Playwright 1.61. Published
peer ranges remain broader to allow compatible applications, but those ranges are not a claim that
every Electron/Playwright pair has been exercised. Run `electron-stagewright doctor --json` against
your installation and keep Electron and Playwright aligned with your target app.

## Transport matrix

| Transport  | Launch/attach model                                 | Hosted evidence                                                                       | Important limits                                                            |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Playwright | Launches Electron through Playwright `_electron`.   | Complete real-Electron suite on Ubuntu, macOS, and Windows.                           | Default and broadest capability surface.                                    |
| CDP        | Attaches to an exposed Chromium debugging endpoint. | Real attach, renderer, console, network, and lifecycle smokes run in the gated suite. | Cannot reach Electron main-process-only APIs.                               |
| Injector   | Attaches through the Node inspector.                | Unit and integration coverage for implemented main-process capabilities.              | Not represented as full renderer automation or as hosted end-to-end parity. |

Transport capability flags remain authoritative at runtime. A platform row being green does not make
an unsupported transport method available.

## Platform-specific capabilities

- `@electron-stagewright/plugin-production` validates packaged macOS `.app` bundles. Windows signing
  and Linux signing are not currently implemented.
- Native-addon ABI recovery is real-runtime verified on Linux and macOS, not Windows.
- `@electron-stagewright/plugin-native-ui` follows Electron's application menu, notification, and
  tray APIs; operating-system presentation and behavior can still differ.
- Visual comparisons bind baselines to environment metadata. Do not share one baseline across
  operating systems and expect pixel identity.

## Validate your own combination

1. Run `electron-stagewright doctor --json` with the same package set and app root your MCP host uses.
2. Run the packaged demo or your smallest real workflow: launch, snapshot, interact, assert, stop.
3. If the app has native addons, launch with `runtime: "project"` and verify the reported Electron,
   Node, V8, and `NODE_MODULE_VERSION` facts.
4. Treat a combination outside the table as unverified until that workflow passes in your own CI.

Compatibility policy is recorded in [ADR-025](../adr/025-compatibility-confidence.md).
