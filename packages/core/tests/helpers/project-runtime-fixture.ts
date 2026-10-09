import { cp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Build a standalone app that owns its already-provisioned Electron installation. */
export async function prepareProjectRuntimeFixture(
  root: string,
  electronPackageDirectory: string,
  appDirectory: string,
): Promise<{ readonly root: string; readonly main: string }> {
  const manifest = JSON.parse(
    await readFile(path.join(electronPackageDirectory, 'package.json'), 'utf8'),
  ) as { readonly version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('Electron fixture needs a version')
  // A pnpm workspace dependency can be outside the declaring package's canonical root.
  // Copy the provisioned package instead of relying on hoisting or weakening root confinement.
  // Preserve relative macOS bundle symlinks so they continue to point inside the copied app.
  await cp(electronPackageDirectory, path.join(root, 'node_modules', 'electron'), {
    recursive: true,
    verbatimSymlinks: true,
  })
  await cp(appDirectory, path.join(root, 'app'), { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'project-runtime-fixture',
      type: 'module',
      devDependencies: { electron: manifest.version },
    }),
  )
  return { root, main: path.join(root, 'app', 'main.js') }
}
