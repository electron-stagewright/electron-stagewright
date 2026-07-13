import { fileURLToPath } from 'node:url'

/** Absolute Electron entry consumed lazily by the core CLI's `--demo` mode. */
export const demoMain = fileURLToPath(new URL('./main.js', import.meta.url))
