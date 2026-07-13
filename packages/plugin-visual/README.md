# `@electron-stagewright/plugin-visual`

Optional visual-regression tools for [Electron Stagewright](https://github.com/electron-stagewright/electron-stagewright).
The plugin captures selected `BrowserWindow` surfaces as PNGs, compares them to
operator-owned baselines with `pixelmatch`, and preserves bounded mismatch evidence.

## Install and configure

Install the core, this plugin, and Electron launch peers together. Configure absolute roots before
calling a visual tool:

```sh
electron-stagewright \
  --plugin @electron-stagewright/plugin-visual \
  --plugin-config visual='{"baselineDir":"/abs/project/visual-baselines","artifactsDir":"/abs/project/visual-artifacts","fontFingerprint":"linux-ci-fonts-v1"}'
```

`baselineDir` stores accepted `<name>.png` and `<name>.meta.json` pairs. `artifactsDir` stores
unique capture, actual, and diff images. Roots are optional at server startup so an operator can
inspect the plugin manifest first, but each relevant tool refuses to run until its root is supplied.

## Tools

- `visual_capture` writes a unique diagnostic PNG and metadata artifact. It never creates or changes
  a baseline.
- `visual_expect` compares with an existing baseline. A missing baseline is
  `visual.BASELINE_NOT_FOUND`; it never writes or updates one. A mismatch returns
  `visual.MISMATCH` with unique actual and diff artifact paths.
- `visual_update_baseline` replaces a baseline only with an explicit `confirm: true` argument. Use
  it after reviewing a deliberate UI change, never as an automatic CI recovery.

All tools accept bounded `masks`, `style`, `animations`, `caret`, and `settleMs` capture controls.
The fixed renderer preparation is temporary and is not arbitrary agent JavaScript, so it does not
need `--allow-eval`. Capture CSS cannot use `@import` or `url()`, so it cannot fetch external
resources while a screenshot is prepared.

## Fidelity and safety

- A selected `window` surface is required. Frames, webviews, and `WebContentsView` surfaces return
  `visual.SURFACE_UNSUPPORTED` instead of being mislabeled as a host-window crop.
- Metadata binds a baseline to PNG dimensions, platform, architecture, Electron user agent and
  version, viewport, DPR, color scheme, locale, capture profile, and optional font fingerprint.
  `visual.ENV_MISMATCH` stops before any pixel diff when these are incompatible.
- Baseline names are strict root-level leaf names. Reads reject symlinks and non-regular files; all
  writes use unique temporary files and atomic rename under configured canonical roots.
- PNGs are bounded to 64 MiB encoded and 16 million pixels. A baseline sidecar stores the PNG's
  SHA-256, so an interrupted or externally mixed sidecar pair is rejected as
  `visual.BASELINE_INVALID` rather than compared misleadingly.

Visual checks are pixel comparisons, not a substitute for accessibility, interaction, or semantic
assertions. Pair them with `a11y_audit`, snapshots, and `electron_expect_*` tools.
