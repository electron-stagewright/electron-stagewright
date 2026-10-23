/**
 * Generated from tracked public guides by scripts/build-agent-resources.mjs.
 * Do not edit manually; run pnpm build:resources from packages/core after changing a source guide.
 */

export const GENERATED_AGENT_RESOURCE_DOCUMENTS = [
  {
    uri: 'stagewright://docs/quickstart',
    name: 'quickstart',
    title: 'Electron Stagewright quickstart',
    description: 'Start an Electron app session and drive its UI safely.',
    source: 'docs/guides/getting-started.md',
    text: '## Agent quick reference: first Electron session\n\n1. Start a session with `electron_launch` (or `electron_attach` for an existing app) and retain\n   its `session_id`.\n2. Read the UI with `electron_snapshot`; use `electron_find` with role/name when you need a\n   specific element. Prefer returned refs to guessed selectors.\n3. Interact through granular tools such as `electron_click`, `electron_type`, and\n   `electron_select_option`.\n4. Assert the result with an `electron_expect_*` tool rather than a client-side polling loop.\n5. On an error, branch on its stable `code`; follow `hint`, `next_actions`, and `similar_refs`\n   instead of parsing error prose.\n6. Call `electron_stop` on every completion and failure path.\n\nThe default server exposes no arbitrary JavaScript execution. Enable only the narrow eval target\nyour flow needs (`--allow-eval=renderer` or `--allow-eval=main`) after reading the security guide.\n`tools/list` is the exact live schema; this resource is a workflow summary, not a substitute for\ntool contracts.\n',
  },
  {
    uri: 'stagewright://docs/concepts',
    name: 'concepts',
    title: 'Electron Stagewright concepts',
    description: 'Agent-native concepts: sessions, snapshots, refs, errors, and plugins.',
    source: 'docs/guides/concepts.md',
    text: "## Agent quick reference: core model\n\n- A **session** owns one app connection. Launch, attach, or inject creates it; `electron_stop`\n  releases it.\n- A **snapshot** is the agent's accessibility-tree view of the selected renderer surface. It yields\n  stable refs for ordinary re-renders; refresh after a renderer reload or a stale-ref error.\n- **Refs** are preferred handles from snapshots. Use selectors only when their target is genuinely\n  stable and known.\n- Every tool result is an `{ ok, … }` envelope. Branch on the stable error `code`, then use\n  `retryable`, `hint`, and `next_actions` to recover.\n- `electron_expect_*` keeps polling inside one server call, reducing agent round-trips.\n- Eval and plugins are explicit opt-ins. A tool profile narrows core availability but never grants\n  eval or auto-loads a plugin.\n\nUse `tools/list` for live schemas and `stagewright://manifest/profile` for the active availability\nsummary. Resources are optional host context: the server's instructions and tools remain complete\nwhen a client neither lists nor reads them.\n",
  },
  {
    uri: 'stagewright://docs/verify-desktop-change',
    name: 'verify-desktop-change',
    title: 'Verify a desktop change',
    description: 'The call sequence that checks a UI change: launch, act, assert, capture, stop.',
    source: 'docs/guides/verify-desktop-change.md',
    text: '## The recipe at a glance\n\nEvery step is an ordinary tool call; stop or change course between any two.\n\n1. `electron_launch { main, env, instrumentNative: true }` against a throwaway profile.\n2. `storage_local_set { key, value }` for flags, language and theme, then\n   `electron_reload { waitForSelector }`.\n3. `electron_dialog_handler { action: "dismiss" }`; `electron_find` the telemetry or tour button\n   (read `hints` when it matches nothing); `electron_click`.\n4. `native_file_dialog_arm { responses }` before an import or export.\n5. `electron_snapshot { format: "text" }` as the baseline.\n6. Act: `electron_click`, `electron_keyboard_type { text, requireEditable: true }`,\n   `native_menu_invoke`, or `electron_set_window_size` (check `clamped`).\n7. `electron_snapshot { format: "text", since: "last" }` to see what changed.\n8. `electron_expect_*` on the result; `native_file_dialog_events` for dialogs.\n9. `electron_console_logs { type: "error" }`.\n10. `electron_expect_visible` on the changed element, then `electron_screenshot { path }` with a path\n    no other capture uses.\n11. `electron_stop`.\n\nEach step, with example calls and the traps the tools report, is under _Step by step_ in\n`docs/guides/verify-desktop-change.md`.\n',
  },
  {
    uri: 'stagewright://docs/security',
    name: 'security',
    title: 'Electron Stagewright security model',
    description: 'Trust boundaries, eval opt-in, and safe operating guidance.',
    source: 'docs/guides/security-model.md',
    text: '## Agent quick reference: safe operation\n\n- Treat the server as a privileged local tool. Only a trusted local MCP host should invoke it.\n- Keep the stdio transport local; do not place it behind a network endpoint without a separate\n  security design.\n- Leave eval disabled unless necessary. Grant only `--allow-eval=renderer` or\n  `--allow-eval=main` for the target that needs it.\n- Treat tool input, screenshots, console output, traces, and capture results as potentially\n  sensitive. Configure plugin redaction before capture.\n- Set `--app-root` when an agent can select application paths, and write artifacts to an\n  operator-controlled directory.\n- For a target-owned Electron runtime, configure `--app-root` yourself and use\n  `runtime: "project"`; never make the project root an agent-supplied value.\n- Load only trusted first-party or reviewed plugins. Plugins are in-process code, not sandboxed.\n\nResource reads expose only bundled public guidance. They never read the operator\'s filesystem,\nsession data, logs, or plugin configuration.\n',
  },
] as const
