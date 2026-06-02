// Bundle the framework fixtures that need a build step into self-contained renderer
// scripts the fixtures' index.html load via <script src>. Vanilla needs no build and is
// skipped here. Output goes under each fixture's dist/ (gitignored). Run by the `matrix`
// script before the runner launches the apps.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Fixtures whose renderer is bundled. Each entry maps a JSX/TS entry to a dist bundle. */
const BUNDLED = [
  {
    name: 'react',
    entry: join(here, 'fixtures/react/app.jsx'),
    outfile: join(here, 'fixtures/react/dist/renderer.js'),
  },
]

for (const fixture of BUNDLED) {
  await build({
    entryPoints: [fixture.entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: fixture.outfile,
    jsx: 'automatic',
    jsxImportSource: 'react',
    loader: { '.jsx': 'jsx' },
    legalComments: 'none',
    logLevel: 'warning',
  })
  process.stderr.write(`built ${fixture.name} fixture -> ${fixture.outfile}\n`)
}
