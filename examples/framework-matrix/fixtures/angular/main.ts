// Angular fixture entry. zone.js must load first (Angular's change detection hooks it),
// and @angular/compiler must be present for JIT compilation of the component template
// (this is a no-CLI, no-AOT build — esbuild only transpiles the decorators). Bundled to
// dist/renderer.js by build-fixtures.mjs.
import 'zone.js'
import '@angular/compiler'

import { bootstrapApplication } from '@angular/platform-browser'

import { AppComponent } from './app.component'

bootstrapApplication(AppComponent).catch((err: unknown) => {
  console.error(err)
})
