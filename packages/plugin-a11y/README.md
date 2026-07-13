# @electron-stagewright/plugin-a11y

Run bounded, surface-scoped automated accessibility audits against real Electron
renderers. The plugin contributes one tool, `a11y_audit`, powered by the
installed [axe-core](https://github.com/dequelabs/axe-core) runtime.

It is deliberately an **audit**, not a conformance certificate: it returns
violations and incomplete checks that an agent can triage, while making the
remaining manual and product-specific work explicit.

## Install and load

Install the core, launch peers, and plugin together, then load the plugin
explicitly:

```sh
npm install @electron-stagewright/core @electron-stagewright/plugin-a11y playwright electron
electron-stagewright --plugin @electron-stagewright/plugin-a11y
```

From a checkout after building:

```sh
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-a11y
```

Or load it programmatically:

```js
import { createServer } from '@electron-stagewright/core'
import a11yPlugin from '@electron-stagewright/plugin-a11y'

const server = await createServer({ plugins: [a11yPlugin] })
```

`a11y_audit` needs a launched Playwright session with both renderer evaluation
and renderer-surface targeting. It does **not** require `--allow-eval`: the
plugin sends a fixed axe-core engine plus structured selectors, rule names, and
bounds. It never accepts agent-provided JavaScript.

## Typical flow

1. Launch the app and call `electron_surfaces_list`.
2. Select the BrowserWindow, WebContentsView, webview, or iframe to inspect
   with `electron_switch_surface`.
3. Call `a11y_audit` with an optional CSS scope, rule/tag filter, impact floor,
   and return bounds.
4. Fix the reported selector paths, then repeat the audit. Switch and repeat
   for every renderer surface that matters to the flow.

Example:

```json
{
  "scope": "#settings-panel",
  "tags": ["wcag2a", "wcag2aa"],
  "impactMin": "serious",
  "maxViolations": 30,
  "maxNodesPerViolation": 3
}
```

`scope` and `include` are alternatives. `tags` and exact axe `rules` are also
alternatives. Selectors, lists, finding counts, and node paths are bounded so a
single audit stays actionable in an agent context.

## Result shape and cache measurements

Successful responses contain the selected `surface_id`, a bounded
`violations` list, a bounded `incomplete` list, and a summary with the true
pre-truncation counts. Finding nodes expose selector paths only; raw DOM HTML
is not returned. Each node caps selector paths, path components, and component
length; `targetsTruncated` marks any clipping within that node.

The `engine` object reports the axe version, whether the renderer cache was
warm, and `transferred_bytes`. The initial audit of a surface sends the fixed
engine source; a warm audit sends only the compact audit body. A renderer reload
is detected and reinjected once automatically.

Errors are namespaced and stable:

- `a11y.UNSUPPORTED` — the selected transport cannot evaluate a targetable
  renderer surface.
- `a11y.INVALID_SELECTOR` — correct a malformed CSS selector.
- `a11y.SCOPE_NOT_FOUND` — resnapshot or select a scope that exists on this
  surface.
- `a11y.ENGINE_FAILED` — wait for the renderer to settle and retry, or use a
  narrower surface.

## Scope and limitations

- **One selected surface at a time.** The plugin does not merge an ambiguous
  result across cross-origin frames, webviews, or WebContentsViews. Discover,
  select, and audit each surface deliberately.
- **Automated checks are partial.** Zero violations is not WCAG conformance.
  Review `incomplete` findings and perform keyboard, screen-reader, visual,
  and product-specific testing.
- **Shadow DOM and hidden UI need intent.** axe can inspect open shadow roots.
  Closed shadow roots and inactive/hidden content require explicit product or
  test setup before they can be assessed meaningfully.
- **No arbitrary evaluation grant.** The fixed engine is a first-party plugin
  capability; agent arguments are validated data, never code. Load it only in
  a trusted local Electron Stagewright server like every other plugin.
- **Existing globals stay intact.** axe-core temporarily uses its conventional
  `window.axe` name while installing; the plugin restores any app-owned value
  and retains its engine under a private global symbol.

## Third-party notices

`axe-core` is a runtime dependency distributed under MPL-2.0. See
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) in this package for the
notice and source-location details.
