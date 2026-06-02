# vue fixture

The same UI contract as the other fixtures (a "Your name" input, a "Greet" button, a
`#status` line), implemented as a Vue 3 single-file component and bundled with esbuild
via the official `@vue/compiler-sfc` (a small inline loader in `build-fixtures.mjs`, no
third-party plugin).

It exercises Vue's reactivity model:

- **`v-model` controlled input** — the name field is two-way bound to reactive state.
  The harness types real keystrokes, which fire the `input` events Vue's `v-model`
  listens to, so the bound state updates the way it would for a user.
- **Reactive text** — the `#status` line is `{{ status }}`; Vue patches the committed DOM
  when the ref changes, and the snapshot walker reads that DOM.
- **Template-compiled render** — the SFC's `<template>` is compiled to a render function
  at build time (inlined into setup), so no runtime template compiler is shipped.

The renderer is built to `dist/renderer.js` by `build-fixtures.mjs` (run automatically
by `pnpm matrix`). That bundle is gitignored.
