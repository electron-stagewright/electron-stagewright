// Vue fixture entry: mount the SFC into #root. Bundled to dist/renderer.js by
// build-fixtures.mjs (the .vue file is compiled by the inline @vue/compiler-sfc plugin).
import { createApp } from 'vue'

import App from './app.vue'

const root = document.getElementById('root')
if (root) createApp(App).mount(root)
