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

### Source resolution (not a qualification claim)

Source-resolved Electron: `42.11.10`; Playwright: `1.63.0`.

These exact development versions come from the `packages/core` importer in the frozen lockfile.
A unit consistency test checks only this source-resolution field. Installation or source checking
does not promote a combination to real-runtime verified compatibility.

### Qualified compatibility evidence

- Previous guide assertion at source `6598c945a126eaf7cff40c9e816897ba044eaaac`:
  Electron 42 / Playwright 1.61
- Last qualified SHA and hosted run: **not recorded in the previous guide**. The source SHA above
  identifies the historical wording, not a recovered exact-head qualification certificate
- Qualified review head: `fbb7e6af10de50e07bd1741b281e4573615ffc36` (PR #86),
  Electron 42.11.10 / Playwright 1.63.0. Hosted checkout
  `8a10fa13e4b57846e60a6333b340ceed9fed7291` has the same tree
  `e34dccac316ff807b971601b31c8c678dee4a49f` as that head.
- [Real-Electron run 37556388351](https://github.com/electron-stagewright/electron-stagewright/actions/runs/37556388351)
  passed: Linux/macOS each executed 34 scenarios; Windows executed 33 and explicitly skipped
  the native-addon scenario. Packed CLI passed on all three platforms. The Linux framework
  matrix passed vanilla, React, Vue and Angular with 10 MCP round-trips each.
- [CI run 37556388404](https://github.com/electron-stagewright/electron-stagewright/actions/runs/37556388404)
  and [docs run 37556388443](https://github.com/electron-stagewright/electron-stagewright/actions/runs/37556388443)
  also passed. These results certify that review tree, not every later edit, sibling-PR
  combination, or release. PR #86 was subsequently merged.

For a new tree, qualification remains pending until its own required Ubuntu/macOS/Windows
real-Electron results, packed-CLI evidence and four-framework real-MCP result are recorded.
Retain native-addon platform limitations. No successful unit result, fixture build or peer-range
declaration replaces those checks.

Published peer ranges remain broader to allow compatible applications, but those ranges are not a
claim that every Electron/Playwright pair has been exercised. Run `electron-stagewright doctor --json`
against your installation and keep Electron and Playwright aligned with your target app.

## Transport matrix

| Transport  | Launch/attach model                                                                   | Hosted evidence                                                                              | Important limits                                                            |
| ---------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Playwright | Launches a development `main` through Playwright `_electron`.                         | Complete real-Electron suite on Ubuntu, macOS, and Windows.                                  | Default and broadest capability surface.                                    |
| CDP        | Launches an executable-only packaged app or attaches to an exposed loopback endpoint. | Real launch/attach, renderer, console, network, and lifecycle smokes run in the gated suite. | No Electron main-process APIs or embedded-surface hierarchy targeting.      |
| Injector   | Attaches through the Node inspector.                                                  | Unit and integration coverage for implemented main-process capabilities.                     | Not represented as full renderer automation or as hosted end-to-end parity. |

Transport capability flags remain authoritative at runtime. A platform row being green does not make
an unsupported transport method available.

## Transport × tool matrix

This table names agent-facing tool families rather than protocol primitives. “Root page” means CDP
selects one page target by default; it does not claim iframe, webview, or `WebContentsView`
hierarchy discovery.

| Tool family                                                | Playwright launch       | CDP packaged/attach          | Injector                |
| ---------------------------------------------------------- | ----------------------- | ---------------------------- | ----------------------- |
| `electron_launch`                                          | ✓ development `main`    | ✓ executable only            | —                       |
| `electron_attach` / `electron_inject`                      | —                       | ✓ attach                     | ✓ inject                |
| `electron_snapshot` / `electron_find`                      | ✓ selected surface      | ✓ selected root page         | —                       |
| Renderer reads, waits, expectations, and interactions      | ✓ selected surface      | ✓ selected root page         | —                       |
| Window list, switch, and screenshot                        | ✓                       | ✓                            | list only               |
| `electron_surfaces_list` / `electron_switch_surface`       | ✓ page/frame hierarchy  | —                            | —                       |
| `electron_eval_renderer`                                   | ✓                       | ✓                            | —                       |
| `electron_eval_main`                                       | ✓ Electron main process | Protocol browser target only | ✓ Electron main process |
| Console and dialog observation                             | ✓                       | ✓                            | console only            |
| Network capture/stubbing and storage plugin transport seam | ✓                       | ✓                            | —                       |
| Clock and native-UI plugin transport seam                  | ✓                       | —                            | —                       |

Every successful launch, attach, or inject response includes the transport's raw `capabilities`
record. Use it for machine decisions; use the table for the narrower behavioral limits that one
boolean cannot express.

## Platform-specific capabilities

- `@electron-stagewright/plugin-production` validates packaged macOS `.app` bundles, Windows
  Authenticode signatures and AppImage embedded signatures. Platform tools and artifact type
  determine which checks can execute; unavailable prerequisites produce an explicit unknown result.
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
