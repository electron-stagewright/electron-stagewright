import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const sourceDir = join(packageDir, 'src')
const distDir = join(packageDir, 'dist')

await mkdir(distDir, { recursive: true })
for (const asset of ['main.js', 'index.html', 'inspector.html']) {
  await cp(join(sourceDir, asset), join(distDir, asset))
}
