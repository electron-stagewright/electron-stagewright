# Load, configure, and diagnose plugins

Use a plugin when the core Electron-driving workflow needs accessibility audits, visual baselines,
traces and replay, IPC, network interception, virtual time, storage, native UI, or packaged-app validation. This
how-to shows how to load one, grant its narrowest gate, and inspect what the server enabled.

The core never discovers plugins automatically. Installing a package is not enough: explicitly name
every plugin with `--plugin` (or pass it to `createServer`).

## Install and load a plugin

Install the core, its launch peers, and the plugin together. For example, load trace support through
`npx`:

```sh
npx -y \
  --package @electron-stagewright/core \
  --package @electron-stagewright/plugin-trace \
  --package playwright \
  --package electron \
  electron-stagewright --plugin @electron-stagewright/plugin-trace
```

For an MCP client, preserve the same package and flag order in its `args`:

```json
[
  "-y",
  "--package",
  "@electron-stagewright/core",
  "--package",
  "@electron-stagewright/plugin-trace",
  "--package",
  "playwright",
  "--package",
  "electron",
  "electron-stagewright",
  "--plugin",
  "@electron-stagewright/plugin-trace"
]
```

Repeat `--plugin` to load more than one. A plugin may also be a trusted local package or file path;
the server imports only the values you specify and rejects a bad manifest before it exposes tools.

From code, pass imported plugin objects directly:

```js
import { createServer } from '@electron-stagewright/core'
import tracePlugin from '@electron-stagewright/plugin-trace'

const server = await createServer({ plugins: [tracePlugin] })
```

## Configure safely

Each plugin owns a Zod config schema. The CLI receives JSON keyed by the plugin namespace:

```sh
electron-stagewright \
  --plugin @electron-stagewright/plugin-network \
  --plugin-config network='{"redactHeaders":["x-api-key"],"redactBodies":true}'
```

Visual baselines use two operator-owned absolute roots. Keep accepted baselines under version
control and send diagnostic captures elsewhere:

```sh
electron-stagewright \
  --plugin @electron-stagewright/plugin-visual \
  --plugin-config visual='{"baselineDir":"/abs/project/visual-baselines","artifactsDir":"/abs/project/visual-artifacts","fontFingerprint":"linux-ci-fonts-v1"}'
```

The programmatic equivalent is `pluginConfigs`:

```js
const server = await createServer({
  plugins: [visualPlugin],
  pluginConfigs: {
    visual: {
      baselineDir: '/abs/project/visual-baselines',
      artifactsDir: '/abs/project/visual-artifacts',
      fontFingerprint: 'linux-ci-fonts-v1',
    },
  },
})
```

Configuration is parsed once, cloned, and frozen for that server. Invalid values fail closed with
`PLUGIN_CONFIG_INVALID`; the details include a Zod path such as `$.maxRecords` and name the exact
`--plugin-config <name>=<json>` or `pluginConfigs.<name>` input to correct. A server with a partial
plugin set never starts.

`electron_plugins` never returns raw operator configuration. A plugin explicitly allowlists every
top-level field it considers safe. An absent field means only that it is not disclosed — never treat
it as proof that the field is unset or non-sensitive.

## Inspect actual availability

After at least one plugin loads, call `electron_plugins` before launching an app. It needs no session
and returns a deterministic, per-server snapshot:

```json
{
  "ok": true,
  "plugins": [
    {
      "name": "storage",
      "version": "…",
      "state": "enabled",
      "tools": [
        { "name": "storage_cookies", "state": "enabled" },
        {
          "name": "storage_local_get",
          "state": "disabled",
          "disabledReason": { "kind": "eval_policy_disabled", "target": "renderer" }
        }
      ],
      "errorCodes": ["storage.EVAL_REQUIRED", "storage.UNSUPPORTED"],
      "requirements": {
        "evalTargets": ["renderer"],
        "transportCapabilities": ["canAccessStorage", "supportsRendererEval"]
      },
      "effectiveConfig": { "redactValues": false, "revealValues": false }
    }
  ]
}
```

- `state: "enabled"` means the plugin passed validation and setup. A failed plugin is never listed.
- A tool with `state: "disabled"` was intentionally hidden by the eval policy. Restart with the
  narrow target in `disabledReason`, such as `--allow-eval=renderer`.
- `requirements` is the conservative union of gates used by **at least one** plugin tool. It does
  not mean every tool requires every listed capability. Capability checks run against the launched
  or attached transport and return the plugin's documented error code when unsupported.
- `errorCodes` are stable namespaced codes the plugin can return. Branch on the code, not prose.
- `effectiveConfig` contains only allowlisted safe fields after defaults and validation.

On a plugin-free server, `electron_plugins` itself is absent. This is intentional: the core keeps
that manifest lean. Load the required plugin and restart, then inspect this tool again.

## Grant the narrowest gate

Loading a plugin does not grant eval or transport powers. Start with no eval and opt into only the
target a tool needs:

```sh
# IPC instrumentation needs main-process eval.
electron-stagewright --plugin @electron-stagewright/plugin-ipc --allow-eval=main

# Per-key Web Storage and IndexedDB need renderer eval.
electron-stagewright --plugin @electron-stagewright/plugin-storage --allow-eval=renderer
```

| Plugin                                    | Primary gate or scope                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@electron-stagewright/plugin-a11y`       | `supportsRendererEval` + `supportsSurfaceTargeting`; fixed engine, no `--allow-eval`; audit one selected surface at a time.                                        |
| `@electron-stagewright/plugin-visual`     | `supportsRendererEval` + `supportsSurfaceTargeting`; fixed BrowserWindow capture preparation, no `--allow-eval`; configure baseline and artifact roots before use. |
| `@electron-stagewright/plugin-trace`      | No eval; records, promotes, and replays sessions.                                                                                                                  |
| `@electron-stagewright/plugin-production` | No running session; validates a packaged macOS `.app`.                                                                                                             |
| `@electron-stagewright/plugin-ipc`        | `--allow-eval=main` and `supportsMainEval`.                                                                                                                        |
| `@electron-stagewright/plugin-network`    | `canIntercept`; no eval.                                                                                                                                           |
| `@electron-stagewright/plugin-clock`      | `canControlClock`; no eval.                                                                                                                                        |
| `@electron-stagewright/plugin-storage`    | Cookies/snapshots need `canAccessStorage`; per-key Web Storage and IndexedDB additionally need renderer eval and `supportsRendererEval`.                           |
| `@electron-stagewright/plugin-native-ui`  | `canAccessNativeUI`; no eval.                                                                                                                                      |

Read the [security model](./security-model.md) before enabling eval or a plugin that reads sensitive
app state. See [`TOOL-REFERENCE.md`](../../TOOL-REFERENCE.md) for full namespaced tool schemas.

## Troubleshoot a missing tool

1. If `electron_plugins` is absent, no plugin is loaded. Confirm the package is installed, add the
   explicit `--plugin` flag, and restart.
2. If the plugin is listed but a tool is disabled, apply its `disabledReason.target` with
   `--allow-eval=main` or `--allow-eval=renderer`, then restart with that narrow grant.
3. If an enabled tool returns `*.UNSUPPORTED`, call `electron_info` after launch or attach and choose
   a transport whose capability matrix satisfies the plugin requirement.
4. If startup reports `PLUGIN_CONFIG_INVALID`, correct the reported field path in the named config
   input. Do not remove a security setting merely to make startup succeed.

For trace workflows, continue with [Capture diagnostics](./capture-diagnostics.md). For trust
boundaries, read the [security model](./security-model.md).
