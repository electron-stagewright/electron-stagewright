# Deep project review — July 2026

A full-surface review of Electron Stagewright across **security, correctness, performance, architecture,
maintainability, and world-class roadmap**. It was produced by reading the actual source (not the
docstrings) across `packages/core` and every first-party plugin, cross-checked against the test suite.

The headline: this is an unusually well-engineered codebase. Type safety is near-perfect (zero `any`/`as any`
in `src`), the error-envelope discipline is uniform, every external command shells out safely, eval is
default-deny and per-target gated, and untrusted inputs are size-bounded. There were **no critical or high
remote-code-execution defects**. The findings below are the sharp edges worth filing down, and the roadmap
is about the infrastructure _around_ the code, which is where the remaining distance to "world-class" lives.

This document records:

1. What was **implemented** in the accompanying change (with tests).
2. The findings **deferred** (with rationale and a proposed fix), so nothing is lost.
3. A prioritized **world-class roadmap** (P0/P1/P2).

---

## 1. Implemented in this change

Every item below ships with a regression test and passes `build` + `lint` + `typecheck` + the full suite.

### Security

| Area                  | Fix                                                                                                                                                                                                                                                                                                                            | Files                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Path confinement      | `electron_drop_file` / `electron_set_files` now enforce the same `--app-root` confinement that `electron_launch` applies, so a tool call cannot read a host file outside the configured project root (e.g. `~/.ssh/id_rsa`) and surface it into the app.                                                                       | `tools/app-root.ts` (new, shared with launch), `tools/interaction/{dropfile,form}.ts`, `tools/lifecycle/launch.ts` |
| Eval DoS              | The eval `code` field is capped at 100 KB. The dispatcher AST-preflights every eval payload synchronously (acorn parse) on the event loop, which the operation-timeout backstop cannot preempt; the cap bounds the parse before it runs, mirroring `regex-safety`'s length cap.                                                | `tools/eval/eval.ts`                                                                                               |
| Trace integrity       | `redactValue` builds redaction output with a null prototype (`Object.create(null)`), so an arg key literally named `__proto__` becomes an own property instead of silently vanishing through the `Object.prototype` setter.                                                                                                    | `plugin-trace/src/recorder.ts`                                                                                     |
| CLI fail-closed       | A security/confinement flag present with a missing value (`--app-root --allow-eval`) now throws at startup instead of silently parsing as "no confinement".                                                                                                                                                                    | `core/src/cli.ts`                                                                                                  |
| SSRF defence-in-depth | The loopback invariant for `attach` is re-asserted at the transport boundary (`CDPTransport.attach`, `InjectorTransport.attach`) via a shared `assertLoopbackAttachTarget`, instead of relying solely on the `electron_attach` tool schema — a direct API caller can no longer point the discovery probe at an arbitrary host. | `transports/loopback.ts` (new), `transports/{cdp,injector,index}.ts`, `tools/lifecycle/attach.ts`                  |

### Correctness

| Severity | Fix                                                                                                                                                                                                                                                                                                                                        | Files                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| HIGH     | `electron_expect_count` (role mode) walked the DOM — which **clears and renumbers every `data-sw-ref`** — without reconciling/retagging, silently desyncing the DOM tags from the stored snapshot baseline so a later `click({ ref })` could hit the wrong element. It now routes through `reconcileRetagAndStore` like `snapshot`/`find`. | `tools/expect/count.ts`                 |
| MEDIUM   | A malformed/raced dialog handle whose getter threw was never accepted **or** dismissed, leaving the renderer blocked on the modal forever (Playwright's auto-dismiss is off once a listener is attached). It is now always dismissed; it is not recorded when its fields are unreadable.                                                   | `transports/playwright-electron.ts`     |
| MEDIUM   | The CDP `#inflight` request map grew unbounded when completion events never arrived (target destroyed mid-flight, SSE/long-poll streams). It is now capped with oldest-eviction.                                                                                                                                                           | `transports/cdp.ts`                     |
| LOW      | Thrown `StagewrightError`s lost `_meta.session_id` because only the handler ran inside the session context, not the catch. The error mapping now runs inside the context too.                                                                                                                                                              | `server/dispatcher.ts`                  |
| LOW      | `readyTimeoutMs` was unbounded and could outlast the 120 s dispatch backstop, turning a _successful_ launch into a retryable `OPERATION_TIMEOUT`. Capped at 60 s like the wait family.                                                                                                                                                     | `tools/lifecycle/launch.ts`             |
| LOW      | `classifyTargetError` did not recognize Playwright strict-mode violations (`resolved to N elements`) or the modern `waiting for locator` phrasing, misclassifying a duplicate-match/missing-element as a retryable visibility timeout. Both now map to `SELECTOR_NO_MATCH` (which carries `similar_refs`).                                 | `tools/target.ts`                       |
| LOW      | The JPEG dimension parser treated length-less standalone markers (`RSTn`, `EOI`, `TEM`, `FF` padding) as length-bearing, so it could misread width/height. It now advances past standalone markers correctly.                                                                                                                              | `tools/observe/screenshot.ts`           |
| LOW      | `parseKeyChord` could not express a literal `+` key (`'+'`, `'Control++'`) — it rejected them as "no key" while the Playwright transport accepts them.                                                                                                                                                                                     | `transports/cdp-interaction.ts`         |
| LOW      | A plugin whose config validation (or setup) threw still had its `teardown` hook invoked against state it never built. Teardown now only runs the user hook when setup actually ran (codes are still unregistered).                                                                                                                         | `plugins/loader.ts`, `plugins/types.ts` |
| LOW      | `electron_drop_file` dereferenced the renderer eval result without an optional guard, so a transport returning `undefined`/`null` would throw a misleading `INTERNAL_ERROR`. Now `result?.ok`.                                                                                                                                             | `tools/interaction/dropfile.ts`         |

### Performance

| Impact | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Files                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| HIGH   | The ~30 KB accessibility-walker bundle was re-parsed and re-executed by the renderer on **every** snapshot / find / read / probe call, even though it only installs `globalThis.__stagewrightWalk` / `__stagewrightProbe` once. The eval body now wraps the bundle in a per-document version marker (keyed to the bundle's content hash), so the renderer parses+runs it once per document and reuses the installed globals; a server upgrade shipping a different bundle re-installs automatically, and a renderer reload clears the marker. | `tools/snapshot/inject.ts` |

---

## 2. Deferred findings (with proposed fixes)

These were verified as real but not implemented here — each either needs live E2E validation the sandbox
can't run, changes a public contract, or is a larger refactor best done deliberately. Recorded so they
are not lost.

### Correctness — transport lifecycle (need real-Electron E2E to validate safely)

- **Network stub detach/attach race (MEDIUM).** `detachStubRoutes` clears the `stubbedPages` bookkeeping
  _before_ the awaited per-page `unroute`/`Fetch.disable` loop completes, so a concurrently registered
  stub can re-attach and then be torn down by the still-running detach loop — leaving a registered stub
  with no interceptor (requests silently hit the real network). _Fix:_ re-check `networkStubs.length !== 0`
  before each `unroute`, or serialize attach/detach behind a per-session epoch/promise chain.
  (`transports/playwright-electron.ts`, `transports/cdp.ts`.)
- **`forceKill` during a hung graceful stop is a silent no-op (MEDIUM).** `stopGracefully` sets
  `disposed = true` on entry; the escalation path `forceKill()` → `stopGracefully({force:true})` hits the
  `if (disposed) return { escalated:false }` guard and returns without sending SIGKILL. _Fix:_ store the
  in-flight stop promise; a `force` call while a graceful stop is pending should SIGKILL immediately and
  await the stored promise. (`playwright-electron.ts`, `cdp.ts`, `injector.ts`.)
- **Force-kill awaits `app.close()` unbounded (MEDIUM).** The `force` branch has no timeout, unlike the
  graceful branch — a wedged Playwright driver pipe after an abrupt child death never resolves. _Fix:_
  `await timedOut(app.close().catch(()=>{}), POST_KILL_SETTLE_MS)`. (`playwright-electron.ts`.)
- **`clock_install` re-install / backwards `clock_set_time` throw (MEDIUM, PLAUSIBLE).** Playwright throws
  on a second `clock.install()` and on `pauseAt` earlier than the current fake time, but the tool
  descriptions promise reinstall/arbitrary set. _Fix:_ treat "already installed" as reinstall and order
  `setSystemTime`/`pauseAt` so a backwards set can't leave `Date` half-applied. (`playwright-electron.ts`,
  `plugin-clock/src/index.ts`.)
- **Clock ops target the current active page, not the install page (LOW/MEDIUM, PLAUSIBLE).** In a
  multi-window app the clock can be installed on window A but advanced against window B. _Fix:_ pin the
  `PWPage` at install time. (`playwright-electron.ts`.)
- **CDP graceful stop treats a non-timeout `Browser.close` failure as success (LOW).** Only `CDP_TIMEOUT`
  escalates; a protocol rejection is swallowed and reported as a clean stop while the app keeps running.
  _Fix:_ escalate (when a pid exists) on any rejection that isn't `CDP_DISCONNECTED`. (`cdp.ts`.)
- **`windowsList` fabricates `visible:true` / `focused: index===0` (LOW).** The Playwright and CDP
  transports report fabricated visibility/focus while the injector reads the real values — an agent
  branching on those fields acts on wrong state. _Fix:_ read real visibility/focus via a main-process
  evaluate, or omit the fields where unknowable. (`playwright-electron.ts`, `cdp.ts`.)
- **Merged response headers can carry case-duplicate keys (LOW, PLAUSIBLE).** `responseReceivedExtraInfo`
  (raw names) and `responseReceived` (normalized) are merged by exact string, so `Content-Type` and
  `content-type` can coexist. _Fix:_ lowercase header names before merging. (`cdp-network.ts`.)

### Correctness — core (need concurrency harness or shadow-DOM E2E)

- **Shadow-DOM refs are unreachable outside `click` (MEDIUM).** The snapshot walker deliberately recurses
  open shadow roots and hands the agent refs for those elements, but every non-Playwright resolver
  (`buildRetagBody`, the read/wait/expect/drop/screenshot probe bodies) uses `document.querySelector`,
  which cannot pierce shadow roots. Result: a ref the snapshot issued for a shadow element works with
  `electron_click` (Playwright's shadow-piercing engine) but returns `SELECTOR_NO_MATCH` from
  `get_state`/`wait_for_state`/`expect_text`/`drop_file`/element-screenshot. _Fix:_ add a shadow-piercing
  `querySelector`/retag helper to the injected bundle and use it in those bodies.
  (`tools/snapshot/inject.ts`, `snapshot/renderer-entry.ts`, and the probe consumers.)
- **Concurrent tool calls race the walk→retag→store pipeline (MEDIUM, PLAUSIBLE).** The pipeline is two
  evaluate round-trips plus a `store.set` with no per-session mutex; interleaved snapshot/find (or a
  failing click's `gatherSimilarRefs` re-walk) can leave DOM tags matching neither stored snapshot.
  _Fix:_ serialize walk+retag+store per session (a keyed lock in `SnapshotStore` or `refs.ts`).
- **`electron_launch` single-instance/session-cap checks are TOCTOU-racy (LOW/MEDIUM, PLAUSIBLE).** Both
  read `sessions.size` before the long `await transport.launch(...)`; two concurrent launches both observe
  `size === 0`. _Fix:_ reserve a slot synchronously (a `pendingLaunches` counter) before the await.
- **Screenshot element clip uses viewport-relative coords (LOW, PLAUSIBLE).** `getBoundingClientRect()`
  feeds `clip` directly; if the transport interprets `clip` in page coordinates, a below-the-fold element
  on a scrolled page clips the wrong region. _Fix:_ add `scrollX/scrollY` in the probe, or match the
  transport's coordinate space. (`tools/observe/screenshot.ts`.)

### Consistency

- **`plugin-ipc` eval tools are visible without `--allow-eval` (INFORMATIONAL).** Unlike core eval tools
  and `plugin-storage`'s web-storage tools (hidden when the flag is absent), the IPC main-eval tools appear
  in `tools/list` and reject at call time with `ipc.EVAL_REQUIRED`. Not a bypass — the runtime guard fires
  before any main JS runs — but inconsistent. _Fix (deferred, changes a plugin's visibility contract and
  its tests):_ declare the IPC tools `requiresEvalFlag: true, evalTarget: 'main'` so the dispatcher hides
  them uniformly.

### Performance (larger, hot-path refactors)

- **Walker layout thrashing + repeated ancestor walks (HIGH).** The per-candidate enrichment interleaves
  DOM reads (`getComputedStyle` up the ancestor chain, `getBoundingClientRect`) with a `setAttribute`
  write, forcing a synchronous style/layout recalc per candidate; and each candidate independently walks
  its full ancestor chain three times (visibility, disabled, roles) with no memoization. _Fix:_ split the
  walk into a pure read phase then a single write phase; thread a per-walk `Map<Element, role/visibility>`
  cache; prefer `element.checkVisibility()` on Chromium with the current code as jsdom fallback.
  (`snapshot/walker.ts`, `snapshot/state.ts`.) This is the single biggest wall-clock win on the hottest
  path and deserves a dedicated, benchmarked change.
- **Every tool result is serialized 3× and transmitted 2× (HIGH).** `makeSuccess` stringifies the payload
  for `estimateTokens`, `toCallToolResult` stringifies the envelope into `content[0].text`, and the SDK
  serializes the whole `CallToolResult` — which carries the payload twice (escaped text block +
  `structuredContent`). _Fix:_ stringify the envelope once, derive `estimated_tokens` from `text.length/4`,
  and size-gate `structuredContent`. (`server/dispatcher.ts`, `errors/envelope.ts`.) Note this also makes
  `estimated_tokens` match what a dual-rendering client actually feeds the model.
- **Retag / probe do full-document `querySelector` per ref (MEDIUM).** Ties into the shadow-DOM fix above;
  a single `querySelectorAll('[data-sw-ref]')` → `Map` makes retag O(n + retags) instead of O(retags × n).
- **CDP does an HTTP `/json/list` discovery fetch on every renderer evaluate (MEDIUM).** Cache the
  first-target id and reuse the pooled connection while alive; refresh on close. (`transports/cdp.ts`.)

---

## 3. World-class roadmap

Internal code quality is already at or above best-in-class MCP-server standard. The gap to "world-class" is
almost entirely _around_ the code: attested releases, enforced quality gates, a versioned plugin contract,
cross-OS parity, and reusable scaffolding. Prioritized:

### P0 — trust & quality gates

1. **Release automation with npm provenance.** Add a `release.yml` using Changesets + OIDC trusted
   publishing + `npm publish --provenance`, folding in the MCP-registry publish step. MCP servers are
   executed by agents on user machines — a verifiable supply chain is table stakes, and it removes the
   documented `workspace:*` foot-gun in `RELEASING.md`.
2. **Enforce coverage thresholds in CI.** Set `coverage.thresholds` in `vitest.config.ts` (~85/78 to match
   current reality) and run `pnpm test:coverage` in one CI cell. Backfill the weakest spots first:
   `lifecycle/signature.ts` (13% lines) and `plugin-production/src/command.ts` (60%, 20% branches — it
   shells out to `codesign`/`spctl`, exactly where a quoting bug becomes a security bug).
3. **Gate performance regressions in CI.** The `bench` package already measures real BPE tokens, tool-call
   counts, latency and RSS over the real stdio protocol, with deterministic floors — but `pnpm bench --check`
   never runs in CI. Add a job; add a large-DOM snapshot-latency scenario so the walker hot-path fixes
   (and future regressions) are visible.
4. **Lock the type-safety discipline with lint.** The codebase passes at zero `any`/non-null-assertion
   violations, but `eslint.config.js` only checks `no-unused-vars`. Enable `recommendedTypeChecked` +
   `no-explicit-any` + `no-non-null-assertion` + `consistent-type-imports` now, while it's free, to prevent
   silent regression.

### P1 — capability & DX parity

5. **Versioned plugin contract.** Ship semver-range `coreVersionRange` (currently only `*`/exact) and export
   a `PLUGIN_API_VERSION` (or a type-only `@electron-stagewright/plugin-api` package) so third-party plugins
   have a stable, independently-versioned surface instead of "whatever core exports."
6. **`@electron-stagewright/test-kit` package.** Publish `FakeTransport`/`FakeSession`, `FULL_CAPS`,
   `fixtureMain`, and the server-teardown harness currently duplicated across 5 plugin test suites and
   reached via `../../core/tests/helpers/`; also extract the per-plugin boilerplate (`PluginMeta`,
   `sessionField`, the capability-guard factory — the `const meta = {…}` construction appears 51×). This is
   the single biggest third-party-DX unlock.
7. **Plugin tools in the generated catalog.** `gen-tool-reference.ts` builds the server _without_ plugins, so
   the drift-tested `TOOL-REFERENCE.md` covers only core's ~53 tools; the ~40 plugin tools live only in
   hand-written per-plugin READMEs. Load first-party plugins and emit per-plugin sections with the same drift
   test — extending single-source-of-truth to all ~90 tools.
8. **Windows/Linux production-check parity.** `plugin-production` is macOS-first. Add Authenticode/`signtool`
   - MSIX/NSIS on Windows and AppImage/deb/rpm + desktop-file checks on Linux. Cross-platform is Electron's
     whole pitch and the packaged-app story is this project's moat vs. Playwright MCP — deepen it.
9. **macOS + Windows E2E lanes.** `e2e-electron.yml` is ubuntu/xvfb only; native-ui (menus/tray/notifications)
   and production checks are exactly the surfaces that only break on those OSes. Add gated (even scheduled)
   macOS/Windows jobs.
10. **Session persistence/resume.** A server restart loses all session state (module-level `Map`s in every
    plugin). Persist session descriptors (CDP endpoint, window refs, armed captures) so an agent can resume
    after an MCP-client restart — a real differentiator for long agent runs.

### P2 — reach & robustness

11. **Video/GIF capture of sessions.** You have screenshots + a trace JSONL/viewer; add frame-sequence or
    `page.video` capture surfaced as a `trace_video`/`electron_record` tool. Motion makes flaky-desktop
    debugging dramatically easier (and doubles as marketing via the existing trace viewer).
12. **Runner integration (WDIO / Playwright-test adapter).** A thin fixture/service that drives the same tool
    layer programmatically lets teams adopt the snapshot/expect engine in CI suites, not just via agents.
13. **Fuzz the security boundaries.** `errors/eval-ast-guard.ts` and `tools/regex-safety.ts` are your
    highest-severity surfaces and have example-based tests only; add property-based/fuzz suites (fast-check),
    consider OSS-Fuzz once stable.
14. **Docs versioning + examples gallery + community automation.** Version-select (or per-release doc
    snapshots) on the docs site; promote the `examples/*-shape` apps into a browsable gallery with per-example
    trace recordings; enable Discussions + a labeler/stale bot; write a telemetry ADR (the envelope already
    carries `estimated_tokens`) _before_ adding any opt-in telemetry.

---

## Things the project already does exceptionally well

- **No shell anywhere** — every external command (`codesign`, `spctl`, `xcrun stapler`, `plutil`) uses
  `execFile` with an argv array, `timeout`, `maxBuffer`, and `windowsHide`.
- **Eval is default-deny, per-target, and hidden from `tools/list`**; the keyword blocklist + AST pass run
  on every dispatch regardless of visibility; the audit breadcrumb logs a length + hash, never the payload.
- **Launch hardening** — denied runtime-altering env keys (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `LD_*`,
  `DYLD_*`), absolute-path preflight, `--app-root` confinement, concurrent-session cap.
- **Secret redaction on by default** — network `authorization`/`cookie`/`set-cookie`, cookie values;
  bodies are opt-in, byte-capped, content-type-gated.
- **Bounded everything** — operation-timeout backstop with `unref`'d timers, capped buffers with overflow
  counters, 64 MB trace-read cap, ReDoS length caps.
- **Near-perfect type safety** — zero `any`/`as any`/non-null-assertions in `src`; the single `unknown→T`
  cast is centralized in `defineTool`.
- **Uniform agent-native error envelopes**, registry-backed codes with namespacing, and a Zod
  single-source-of-truth that generates `tools/list` and (for core) `TOOL-REFERENCE.md` with a drift test.
- **Bench methodology** — real MCP stdio protocol, real BPE token counts alongside the char/4 heuristic,
  same-task baseline-vs-optimized contrasts with floors.
