// Bundle the framework fixtures that need a build step into self-contained renderer
// scripts the fixtures' index.html load via <script src>. Vanilla needs no build and is
// skipped here. Each fixture's renderer is bundled to its own gitignored dist/. Run by
// the `matrix` script before the runner launches the apps.
//
// Each BUNDLED entry carries its own esbuild overrides (JSX for React, a Vue SFC plugin
// + feature-flag defines for Vue, a decorator-aware tsconfigRaw for Angular), so adding
// a bundled framework is just one more entry.
import { build } from 'esbuild'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Minimal single-file-component loader for esbuild: compiles a `.vue` file's
 * `<script setup>` + `<template>` into one self-contained module via the official
 * `@vue/compiler-sfc` (no third-party plugin). `inlineTemplate` folds the compiled
 * render function into setup, so no separate template module is needed.
 *
 * Scoped styles are NOT handled (no `compileStyle` call), so the loader rejects a `.vue`
 * with `<style scoped>` rather than emitting a silently-unstyled bundle. The scope `id`
 * is derived per-file so a second SFC can't collide, and the esbuild loader follows the
 * block's `lang` so a TS `<script setup lang="ts">` is parsed as TS.
 */
function vueSfcPlugin() {
  return {
    name: 'vue-sfc',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /\.vue$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8')
        const { descriptor } = parse(source, { filename: args.path })
        if (descriptor.styles.some((style) => style.scoped)) {
          throw new Error(
            `vue-sfc: ${args.path} uses <style scoped>, which this loader does not support.`,
          )
        }
        const id = createHash('sha256').update(args.path).digest('hex').slice(0, 8)
        const compiled = compileScript(descriptor, { id, inlineTemplate: true })
        const lang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang ?? 'js'
        return { contents: compiled.content, loader: lang === 'ts' ? 'ts' : 'js' }
      })
    },
  }
}

/** Vue's compile-time feature flags; defining them silences runtime warnings. */
const VUE_DEFINE = {
  __VUE_OPTIONS_API__: 'true',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
}

/** One bundled fixture: its esbuild entry, output bundle, and per-framework overrides. */
const BUNDLED = [
  {
    name: 'react',
    entry: join(here, 'fixtures/react/app.jsx'),
    outfile: join(here, 'fixtures/react/dist/renderer.js'),
    options: { jsx: 'automatic', jsxImportSource: 'react', loader: { '.jsx': 'jsx' } },
  },
  {
    name: 'vue',
    entry: join(here, 'fixtures/vue/entry.js'),
    outfile: join(here, 'fixtures/vue/dist/renderer.js'),
    options: { plugins: [vueSfcPlugin()], define: VUE_DEFINE },
  },
  {
    name: 'angular',
    entry: join(here, 'fixtures/angular/main.ts'),
    outfile: join(here, 'fixtures/angular/dist/renderer.js'),
    // Angular components are TS experimental decorators; class fields must NOT use
    // define semantics or Angular's property initialisation breaks. JIT compiles the
    // templates at runtime (main.ts imports @angular/compiler). NOTE: esbuild does not
    // emit decorator metadata, so this works only for components with NO constructor DI
    // (this one has none); a fixture injecting services would need a different toolchain.
    options: {
      tsconfigRaw: {
        compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
      },
    },
  },
]

for (const fixture of BUNDLED) {
  // Clean the prior bundle so a renamed/removed entry can't leave a stale artifact.
  await rm(dirname(fixture.outfile), { recursive: true, force: true })
  await build({
    entryPoints: [fixture.entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: fixture.outfile,
    legalComments: 'none',
    logLevel: 'warning',
    ...fixture.options,
  })
  process.stderr.write(`built ${fixture.name} fixture -> ${fixture.outfile}\n`)
}
