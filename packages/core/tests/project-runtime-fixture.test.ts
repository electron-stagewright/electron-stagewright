import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveProjectElectron } from '../src/runtime/project-electron.js'
import { prepareProjectRuntimeFixture } from './helpers/project-runtime-fixture.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('standalone project-runtime fixture', () => {
  it('owns a resolvable Electron package without workspace hoisting or native execution', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'stagewright-project-fixture-'))
    roots.push(temporary)
    const sourcePackage = path.join(temporary, 'source', 'electron')
    const sourceApp = path.join(temporary, 'source', 'app')
    const root = path.join(temporary, 'project')
    await Promise.all([
      mkdir(path.join(sourcePackage, 'dist'), { recursive: true }),
      mkdir(sourceApp, { recursive: true }),
      mkdir(root),
    ])
    await Promise.all([
      writeFile(path.join(sourcePackage, 'package.json'), JSON.stringify({ version: '42.11.10' })),
      writeFile(path.join(sourcePackage, 'path.txt'), 'fixture-electron'),
      writeFile(
        path.join(sourcePackage, 'dist', 'fixture-electron'),
        'ordinary fixture, not executable',
      ),
      writeFile(path.join(sourceApp, 'main.js'), 'export {}'),
      writeFile(path.join(sourceApp, 'index.html'), '<main>Fixture</main>'),
    ])
    const fixture = await prepareProjectRuntimeFixture(root, sourcePackage, sourceApp)
    const resolved = await resolveProjectElectron(root)
    expect(resolved, JSON.stringify(resolved)).toMatchObject({
      ok: true,
      rootPath: await realpath(root),
      electron: {
        executablePath: await realpath(
          path.join(root, 'node_modules/electron/dist/fixture-electron'),
        ),
        version: '42.11.10',
      },
    })
    expect(await readFile(fixture.main, 'utf8')).toBe('export {}')
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))).toEqual({
      name: 'project-runtime-fixture',
      type: 'module',
      devDependencies: { electron: '42.11.10' },
    })
    expect(await readFile(path.join(root, 'app/index.html'), 'utf8')).toBe('<main>Fixture</main>')
  })
})
