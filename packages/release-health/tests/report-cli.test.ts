import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { parseCliArguments, repositoryFromManifest, runCli } from '../src/cli.js'
import { generateReleaseHealthReport } from '../src/report.js'
import { completeDateWindow } from '../src/time.js'
import type { GitExecutor } from '../src/governance.js'

const GENERATED_AT = '2026-07-27T15:00:00.000Z'

async function workspaceRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stagewright-release-health-'))
  await mkdir(path.join(root, 'packages', 'core'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'core', 'package.json'),
    JSON.stringify({ name: '@electron-stagewright/core', version: '0.4.1' }),
  )
  return root
}

describe('release-health report orchestration', () => {
  it('keeps npm available while all GitHub families fail closed without a token', async () => {
    const root = await workspaceRoot()
    const npmWindow = completeDateWindow(GENERATED_AT, 30)
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('api.npmjs.org')
      return new Response(
        JSON.stringify({
          package: '@electron-stagewright/core',
          start: npmWindow.start,
          end: npmWindow.end,
          downloads: npmWindow.dates.map((day) => ({ day, downloads: 0 })),
        }),
      )
    }) as typeof fetch

    const report = await generateReleaseHealthReport({
      repositoryRoot: root,
      repository: 'owner/repository',
      generatedAt: GENERATED_AT,
      fetchImpl,
    })

    expect(report.schema_version).toBe(1)
    expect(report.metrics.package_adoption.status).toBe('available')
    expect(report.metrics.repository_discovery).toMatchObject({
      status: 'unavailable',
      reason: 'missing_credential',
    })
    expect(report.metrics.maintainer_responsiveness).toMatchObject({
      status: 'unavailable',
      reason: 'missing_credential',
    })
    expect(report.metrics.contributor_growth).toMatchObject({
      status: 'unavailable',
      reason: 'missing_credential',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(JSON.stringify(report)).not.toMatch(/GITHUB_TOKEN|actor|login|id/)
  })

  it('isolates clone permission failure from public GitHub aggregates', async () => {
    const root = await workspaceRoot()
    const npmWindow = completeDateWindow(GENERATED_AT, 30)
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('api.npmjs.org')) {
          return new Response(
            JSON.stringify({
              package: '@electron-stagewright/core',
              start: npmWindow.start,
              end: npmWindow.end,
              downloads: npmWindow.dates.map((day) => ({ day, downloads: 1 })),
            }),
          )
        }
        if (url.includes('/traffic/clones')) {
          return new Response('', { status: 403 })
        }
        const request = JSON.parse(String(init?.body)) as { query: string }
        if (request.query.includes('ReleaseHealthIssues')) {
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  issues: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        createdAt: '2026-06-01T00:00:00Z',
                        author: { __typename: 'User', login: 'sensitive-handle' },
                        comments: {
                          pageInfo: { hasNextPage: false },
                          nodes: [
                            {
                              createdAt: '2026-06-02T00:00:00Z',
                              author: { __typename: 'User', login: 'maintainer' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            }),
          )
        }
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      mergedAt: '2026-07-01T00:00:00Z',
                      author: { __typename: 'User', login: 'sensitive-handle', id: 'U1' },
                    },
                  ],
                },
              },
            },
          }),
        )
      },
    ) as typeof fetch
    const commit = 'a'.repeat(40)
    const executeGit: GitExecutor = async (arguments_) => {
      if (arguments_[0] === 'rev-parse') return 'false\n'
      if (arguments_[0] === 'log') return `${commit}\t1735689600\n`
      return '## Maintainers\n\n| [@maintainer](https://github.com/maintainer) | Lead |\n'
    }

    const report = await generateReleaseHealthReport({
      repositoryRoot: root,
      repository: 'owner/repository',
      generatedAt: GENERATED_AT,
      githubToken: 'test-secret-token',
      fetchImpl,
      executeGit,
    })

    expect(report.metrics.repository_discovery).toMatchObject({
      status: 'unavailable',
      reason: 'permission_denied',
    })
    expect(report.metrics.repository_discovery.window).toEqual({
      start: '2026-07-14',
      end: '2026-07-27',
    })
    expect(report.metrics.maintainer_responsiveness).toMatchObject({
      status: 'available',
      eligible_issue_count: 1,
      response_count: 1,
      response_within_7_days_count: 1,
    })
    expect(report.metrics.contributor_growth).toMatchObject({
      status: 'available',
      first_merged_within_30_days: 1,
      cumulative_contributor_accounts: 1,
    })
    expect(JSON.stringify(report)).not.toContain('test-secret-token')
    expect(JSON.stringify(report)).not.toContain('sensitive-handle')
  })
})

describe('release-health CLI contract', () => {
  it('parses only bounded arguments and infers GitHub coordinates', () => {
    expect(parseCliArguments(['--repository', 'owner/repository'])).toEqual({
      help: false,
      repository: 'owner/repository',
    })
    expect(() => parseCliArguments(['--sources', 'npm'])).toThrow('invalid_argument')
    expect(
      repositoryFromManifest({
        repository: {
          type: 'git',
          url: 'git+https://github.com/electron-stagewright/electron-stagewright.git',
        },
      }),
    ).toBe('electron-stagewright/electron-stagewright')
  })

  it('writes help to stdout without requiring credentials', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await expect(runCli(['--help'], {})).resolves.toBe(0)
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: pnpm release-health'))
    expect(stderr).not.toHaveBeenCalled()
    stdout.mockRestore()
    stderr.mockRestore()
  })

  it('writes only a bounded diagnostic for invalid arguments', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await expect(runCli(['--unknown'], { GITHUB_TOKEN: 'must-not-leak' })).resolves.toBe(1)
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith('Release-health report failed: invalid_argument\n')
    expect(String(stderr.mock.calls)).not.toContain('must-not-leak')
    stdout.mockRestore()
    stderr.mockRestore()
  })
})
