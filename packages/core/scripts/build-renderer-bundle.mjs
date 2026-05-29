// Bundle the renderer-injected snapshot walker into a single self-contained IIFE.
//
// The renderer cannot resolve ESM imports, so the walker plus its helpers
// (accname, fingerprint, state, roles, dom-utils) are bundled by esbuild into
// one script. The snapshot tool reads dist/snapshot/injected-walker.js and
// injects it via session.evaluate('renderer', …). Run as part of `pnpm build`,
// after tsc has emitted the rest of dist.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/snapshot/renderer-entry.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/snapshot/injected-walker.js',
  legalComments: 'none',
  logLevel: 'warning',
})
