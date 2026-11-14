import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Every module specifier reachable from `entry` through relative imports. */
async function reachable(entry: string): Promise<{ local: Set<string>; external: Set<string> }> {
  const local = new Set<string>()
  const external = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (local.has(file)) continue
    local.add(file)
    const text = await readFile(path.join(SRC, file), 'utf8')
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*(['"])([^'"]+)\1/g)) {
      const specifier = match[2] as string
      if (specifier.startsWith('.'))
        queue.push(specifier.replace(/^\.\//, '').replace(/\.js$/, '.ts'))
      else external.add(specifier)
    }
  }
  return { local, external }
}

describe('the ./check entry', () => {
  it('reaches neither core, the plugin, nor the launcher', async () => {
    const { local, external } = await reachable('check-api.ts')
    expect([...external].filter((name) => !name.startsWith('node:')).sort()).toEqual(['zod'])
    for (const file of ['plugin.ts', 'measure.ts', 'session.ts', 'cli.ts']) {
      expect(local.has(file), file).toBe(false)
    }
  })

  it('is exported for import and require, next to the CLI', async () => {
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { exports: Record<string, Record<string, string> | string> }
    expect(pkg.exports['./check']).toEqual({
      types: './dist/check-api.d.ts',
      import: './dist/check-api.js',
      default: './dist/check-api.js',
    })
    expect(pkg.exports['./cli']).toMatchObject({ default: './dist/cli.js' })
  })
})
