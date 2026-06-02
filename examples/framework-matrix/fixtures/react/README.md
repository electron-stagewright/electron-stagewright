# react fixture

The same UI contract as the vanilla fixture (a "Your name" input, a "Greet" button, a
`#status` line), implemented in React and bundled with esbuild.

It exercises the framework quirks that most often break naive automation:

- **Controlled input** — the name field's value lives in React state and is re-rendered
  on every change. The harness types real keystrokes, which fire the per-character
  `input` events React's `onChange` listens to, so the controlled value updates the way
  it would for a user. (A raw value-set that skipped events would leave React's state
  stale.)
- **Synthetic events** — the button uses React's `onClick`, dispatched through React's
  delegated event system rather than a direct DOM listener. A real click reaches it all
  the same.
- **Virtual DOM** — the `#status` text is React-rendered; the snapshot walker reads the
  committed DOM, so the assertion sees the rendered output.

The renderer is built to `dist/renderer.js` by `build-fixtures.mjs` (run automatically
by `pnpm matrix`). That bundle is gitignored.
