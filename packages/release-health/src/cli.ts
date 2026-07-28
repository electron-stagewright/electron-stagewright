import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateReleaseHealthReport } from './report.js'
import { record, string } from './validation.js'

const CURRENT_FILE = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = path.resolve(path.dirname(CURRENT_FILE), '../../..')
const HELP = `Usage: pnpm release-health [--repository <owner/name>]

Generate a privacy-safe release-health report on stdout.

Options:
  --repository <owner/name>  Override the GitHub repository from package.json.
  --help                     Show this help.

Environment:
  GITHUB_TOKEN               Read-only GitHub token. Clone traffic additionally
                             requires repository Administration read access.
`

export interface CliArguments {
  readonly help: boolean
  readonly repository: string | null
}

export function parseCliArguments(arguments_: readonly string[]): CliArguments {
  let repository: string | null = null
  let help = false
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--repository') {
      const value = arguments_[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('invalid_argument')
      repository = value
      index += 1
      continue
    }
    throw new Error('invalid_argument')
  }
  return { help, repository }
}

export function repositoryFromManifest(manifest: unknown): string {
  const root = record(manifest)
  const repositoryField = root['repository']
  const repositoryUrl =
    typeof repositoryField === 'string' ? repositoryField : string(record(repositoryField)['url'])
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(repositoryUrl)
  const owner = match?.[1]
  const name = match?.[2]
  if (owner === undefined || name === undefined) throw new Error('invalid_repository')
  return `${owner}/${name}`
}

async function defaultRepository(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ) as unknown
  return repositoryFromManifest(manifest)
}

export async function runCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    const parsed = parseCliArguments(arguments_)
    if (parsed.help) {
      process.stdout.write(HELP)
      return 0
    }
    const repository = parsed.repository ?? (await defaultRepository())
    const report = await generateReleaseHealthReport({
      repositoryRoot: REPOSITORY_ROOT,
      repository,
      ...(environment['GITHUB_TOKEN'] === undefined
        ? {}
        : { githubToken: environment['GITHUB_TOKEN'] }),
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  } catch (error) {
    const reason =
      error instanceof Error &&
      (error.message === 'invalid_argument' || error.message === 'invalid_repository')
        ? error.message
        : 'collector_failure'
    process.stderr.write(`Release-health report failed: ${reason}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === CURRENT_FILE) {
  process.exitCode = await runCli(process.argv.slice(2))
}
