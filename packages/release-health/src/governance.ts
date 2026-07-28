import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { SourceUnavailableError } from './errors.js'
import { parseInstant } from './time.js'

const execFile = promisify(execFileCallback)
const GOVERNANCE_PATH = '.github/GOVERNANCE.md'
const HANDLE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$|^[A-Za-z0-9]$/

export type GitExecutor = (arguments_: readonly string[]) => Promise<string>

export interface GovernanceEntry {
  readonly effectiveAt: string
  readonly maintainers: ReadonlySet<string>
}

export interface GovernanceTimeline {
  readonly entries: readonly GovernanceEntry[]
  maintainersAt(timestamp: string): ReadonlySet<string>
}

export function parseMaintainers(document: string): ReadonlySet<string> {
  const lines = document.split(/\r?\n/)
  const sectionStart = lines.findIndex((line) => line.trim() === '## Maintainers')
  if (sectionStart < 0) throw new SourceUnavailableError('governance_history_incomplete')
  const sectionLines: string[] = []
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.startsWith('## ')) break
    sectionLines.push(line)
  }
  const section = sectionLines.join('\n')

  const maintainers = new Set<string>()
  const linkPattern = /\[@([A-Za-z0-9-]+)\]\(https:\/\/github\.com\/([A-Za-z0-9-]+)\/?\)/g
  for (const match of section.matchAll(linkPattern)) {
    const label = match[1]
    const linkedHandle = match[2]
    if (
      label === undefined ||
      linkedHandle === undefined ||
      label.toLowerCase() !== linkedHandle.toLowerCase() ||
      !HANDLE_PATTERN.test(label)
    ) {
      throw new SourceUnavailableError('governance_history_incomplete')
    }
    const normalized = label.toLowerCase()
    if (maintainers.has(normalized)) {
      throw new SourceUnavailableError('governance_history_incomplete')
    }
    maintainers.add(normalized)
  }

  if (maintainers.size === 0) {
    throw new SourceUnavailableError('governance_history_incomplete')
  }
  return maintainers
}

export function createGovernanceTimeline(entries: readonly GovernanceEntry[]): GovernanceTimeline {
  if (entries.length === 0) {
    throw new SourceUnavailableError('governance_history_incomplete')
  }
  let previousTimestamp = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    const timestamp = parseInstant(entry.effectiveAt)
    if (timestamp <= previousTimestamp || entry.maintainers.size === 0) {
      throw new SourceUnavailableError('governance_history_incomplete')
    }
    previousTimestamp = timestamp
  }

  return {
    entries,
    maintainersAt(timestamp) {
      const target = parseInstant(timestamp)
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]
        if (entry !== undefined && parseInstant(entry.effectiveAt) <= target) {
          return entry.maintainers
        }
      }
      throw new SourceUnavailableError('governance_history_incomplete')
    },
  }
}

export function createGitExecutor(repositoryRoot: string): GitExecutor {
  return async (arguments_) => {
    try {
      const result = await execFile('git', [...arguments_], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      })
      return result.stdout
    } catch {
      throw new SourceUnavailableError('source_error')
    }
  }
}

export async function loadGovernanceTimeline(executeGit: GitExecutor): Promise<GovernanceTimeline> {
  const shallow = (await executeGit(['rev-parse', '--is-shallow-repository'])).trim()
  if (shallow !== 'false') {
    throw new SourceUnavailableError('governance_history_incomplete')
  }

  const output = await executeGit([
    'log',
    '--follow',
    '--format=%H%x09%ct',
    '--reverse',
    '--',
    GOVERNANCE_PATH,
  ])
  const entries: GovernanceEntry[] = []
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue
    const [commit, commitTimestamp, ...extra] = line.split('\t')
    if (
      commit === undefined ||
      commitTimestamp === undefined ||
      extra.length > 0 ||
      !/^[0-9a-f]{40}$/i.test(commit) ||
      !/^\d+$/.test(commitTimestamp)
    ) {
      throw new SourceUnavailableError('governance_history_incomplete')
    }
    const timestamp = Number(commitTimestamp) * 1_000
    if (!Number.isSafeInteger(timestamp)) {
      throw new SourceUnavailableError('governance_history_incomplete')
    }
    const effectiveAt = new Date(timestamp).toISOString()
    const document = await executeGit(['show', `${commit}:${GOVERNANCE_PATH}`])
    entries.push({ effectiveAt, maintainers: parseMaintainers(document) })
  }
  return createGovernanceTimeline(entries)
}
