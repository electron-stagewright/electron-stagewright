# ADR-023: Visual baseline plugin

- **Status**: Accepted
- **Date**: 2026-07-13
- **Deciders**: johnny4young

## Context

The core screenshot tool is evidence capture: it writes a PNG to an
operator-chosen location but deliberately has no opinion about a known-good UI
state. A visual regression capability needs more than a pixel comparator. It
must distinguish diagnostic capture from changing the expected state, avoid
silently blessing a regression, make a mismatch reviewable, and avoid comparing
images produced in incompatible environments.

It also writes two kinds of durable data. Baselines are accepted project
artifacts; actual and diff images are diagnostic artifacts. Unbounded paths,
path traversal, or symlink resolution could turn a normal comparison into an
unexpected filesystem read or write. A renderer target has a related fidelity
constraint: the existing transport screenshot contract is `WindowRef`-scoped.
It cannot correctly crop an iframe, webview, or `WebContentsView` from a
selected renderer surface.

## Decision

1. **Visual regression is an explicitly loaded plugin.**
   `@electron-stagewright/plugin-visual` follows ADR-004. It exposes exactly
   three namespaced tools: `visual_capture` records diagnostic evidence,
   `visual_expect` compares against an existing baseline, and
   `visual_update_baseline` changes the expected state. Loading the plugin does
   not create, update, or discover baselines.

2. **Capture and baseline mutation are separate operations.**
   `visual_expect` never creates or updates a baseline; a missing baseline is a
   `visual.BASELINE_NOT_FOUND` error. `visual_update_baseline` requires an
   explicit confirmation argument in addition to an explicit tool call. It
   writes a PNG and metadata atomically per file and serializes operations for
   the same baseline name. A metadata SHA-256 of the PNG makes an interrupted or
   externally mixed image/sidecar pair detectable rather than a source of a
   misleading diff.

3. **All filesystem targets are confined to configured roots.**
   The plugin receives separate operator-configured baseline and artifact
   directories. Baseline names are strict leaf names, never paths; generated
   names cannot contain traversal segments. Reads reject symlinks and
   non-regular baseline files. Writes use unique temporary files and atomic
   replacement inside a canonicalized root. Mismatch artifacts use unique
   attempt directories, atomically published only after both actual and diff
   images are complete, so concurrent checks preserve complete evidence sets.

4. **Comparison requires a compatible capture environment.**
   Every baseline sidecar records PNG dimensions, platform, architecture,
   Electron user-agent version, viewport, device-pixel ratio, color scheme,
   locale, and an optional operator-supplied font fingerprint. The plugin
   rejects changed metadata with `visual.ENV_MISMATCH` before computing a diff.
   This favors an explicit environment fix over a plausible-looking but invalid
   cross-platform comparison.

5. **The comparator is bounded and reviewable.**
   PNGs are decoded with `pngjs` and compared with `pixelmatch`. Calls choose a
   bounded perceptual threshold and allowed differing-pixel count or ratio.
   On a real mismatch the plugin atomically preserves the actual PNG and a diff
   PNG, then returns `visual.MISMATCH` with their paths and measured counts.
   The default allows no differing pixels.

6. **Capture fidelity follows the existing surface contract.**
   Before capture the plugin reads the explicit active renderer surface. It only
   proceeds for a selected `window` surface, then calls the transport's existing
   `WindowRef` screenshot API. A selected frame, webview, or `WebContentsView`
   fails with `visual.SURFACE_UNSUPPORTED` rather than returning a host-window
   image labeled as that surface. A fixed renderer-owned preparation step can
   wait for layout, disable animations, hide the caret, apply bounded CSS, and
   mask bounded CSS-selector matches only for the capture; it is not arbitrary
   agent JavaScript and does not require the eval flag.

## Alternatives considered

| Alternative                                             | Why rejected                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Add visual comparison to `electron_screenshot`          | It would conflate evidence capture with an expected-state mutation and burden every core installation.                              |
| Create a baseline when `visual_expect` cannot find one  | A first run would silently accept a regression and CI could mutate a repository.                                                    |
| Accept arbitrary output paths per call                  | Operator-configured roots permit useful artifacts without turning an agent request into unrestricted filesystem access.             |
| Compare across every platform by default                | Font rendering, DPR, Chromium, and color differences make a pixel result misleading; metadata mismatch is honest.                   |
| Crop iframe or webview screenshots from window geometry | Existing screenshots are WindowRef-scoped, and frame geometry is not a reliable host-window crop contract.                          |
| Use a browser test-runner assertion directly            | The MCP server needs a runtime package with structured envelopes and operator-owned artifact paths, not a Playwright-test-only API. |

## Consequences

- The core remains lean and does not gain image-decoding dependencies or baseline state.
- Operators must configure and version-control baseline roots intentionally; CI has read-only
  comparison behavior unless it explicitly calls the destructive update tool.
- A mismatch is a structured error with reproducible artifacts, while a metadata mismatch is
  distinguishable from a pixel difference.
- Visual comparison initially targets BrowserWindow roots only. Support for other renderer roots
  requires a transport-level image contract and an amendment to this ADR.

## References

- [ADR-003](./003-transport-abstraction.md) — `WindowRef` screenshot seam.
- [ADR-004](./004-plugin-model.md) — explicit optional plugins.
- [ADR-007](./007-agent-native-ux-principles.md) — bounded, recoverable tool responses.
- [ADR-014](./014-security-posture-and-threat-model.md) — filesystem and renderer-evaluation posture.
- [ADR-022](./022-renderer-surface-targeting.md) — explicit renderer targeting and screenshot scope.
- [pixelmatch](https://github.com/mapbox/pixelmatch) — pixel-level comparison options and diff output.
- [pngjs](https://www.npmjs.com/package/pngjs) — Node PNG decoding and encoding.
