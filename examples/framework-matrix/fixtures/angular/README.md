# angular fixture

The same UI contract as the other fixtures (a "Your name" input, a "Greet" button, a
`#status` line), implemented as a standalone Angular component and bundled with esbuild.

It exercises the Angular-specific machinery:

- **zone.js change detection** — the `#status` line updates because zone.js notices the
  click handler ran and triggers change detection. The harness's real click drives that
  loop the same as a user's.
- **`[value]` + `(input)` binding** — the input is bound without `FormsModule`; real
  keystrokes fire the `(input)` event that updates the component field.
- **Runtime (JIT) compilation** — there is no Angular CLI or AOT step here. esbuild only
  transpiles the `@Component` decorator (`experimentalDecorators`); the template is
  compiled at runtime by `@angular/compiler` (imported in `main.ts`). This keeps the
  fixture light, at the cost of shipping the compiler in the bundle.

The renderer is built to `dist/renderer.js` by `build-fixtures.mjs` (run automatically
by `pnpm matrix`). That bundle is gitignored.
