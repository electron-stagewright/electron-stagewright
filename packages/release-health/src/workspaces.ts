import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { SourceUnavailableError } from './errors.js'
import { record, string } from './validation.js'

export interface PublishableWorkspace {
  readonly name: string
  readonly version: string
}

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/

export async function loadPublishableWorkspaces(
  repositoryRoot: string,
): Promise<readonly PublishableWorkspace[]> {
  let entries
  try {
    entries = await readdir(path.join(repositoryRoot, 'packages'), { withFileTypes: true })
  } catch {
    throw new SourceUnavailableError('source_error')
  }

  const workspaces: PublishableWorkspace[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    let manifest: Record<string, unknown>
    try {
      const contents = await readFile(
        path.join(repositoryRoot, 'packages', entry.name, 'package.json'),
        'utf8',
      )
      manifest = record(JSON.parse(contents))
    } catch (error) {
      if (error instanceof SourceUnavailableError) throw error
      throw new SourceUnavailableError('invalid_response')
    }

    if (manifest['private'] === true) continue
    const name = string(manifest['name'])
    const version = string(manifest['version'])
    if (!name.startsWith('@electron-stagewright/') || !SEMVER_PATTERN.test(version)) {
      throw new SourceUnavailableError('invalid_response')
    }
    workspaces.push({ name, version })
  }

  workspaces.sort((left, right) => left.name.localeCompare(right.name))
  if (workspaces.length === 0) throw new SourceUnavailableError('incomplete_data')
  if (new Set(workspaces.map(({ name }) => name)).size !== workspaces.length) {
    throw new SourceUnavailableError('invalid_response')
  }
  return workspaces
}
