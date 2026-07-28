import { describe, expect, it, vi } from 'vitest'

import {
  collectRepositoryDiscovery,
  loadIssues,
  loadMergedPullRequests,
} from '../src/github-source.js'
import { currentDateWindow, trailingInstantWindow } from '../src/time.js'

const GENERATED_AT = '2026-07-27T15:00:00.000Z'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status })
}

describe('GitHub clone traffic', () => {
  it('keeps daily unique values separate from the source-reported snapshot', async () => {
    const window = currentDateWindow(GENERATED_AT, 14)
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      jsonResponse({
        count: 105,
        uniques: 17,
        clones: window.dates.map((date, index) => ({
          timestamp: `${date}T00:00:00Z`,
          count: index + 1,
          uniques: index % 3,
        })),
      }),
    )

    const metric = await collectRepositoryDiscovery('owner/repository', window, {
      token: 'test-token',
      fetchImpl: fetchMock as typeof fetch,
    })
    expect(metric.snapshot_14_day).toEqual({ count: 105, unique_cloners: 17 })
    expect(metric.daily.reduce((total, day) => total + day.unique_cloners, 0)).not.toBe(17)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/repos/owner/repository/traffic/clones')
  })

  it('rejects daily data that cannot prove the source snapshot is complete', async () => {
    const window = currentDateWindow(GENERATED_AT, 14)
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        count: 999,
        uniques: 1,
        clones: window.dates.map((date) => ({
          timestamp: `${date}T00:00:00.000Z`,
          count: 0,
          uniques: 0,
        })),
      }),
    ) as typeof fetch
    await expect(
      collectRepositoryDiscovery('owner/repository', window, {
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'incomplete_data' })
  })
})

describe('GitHub issue metadata', () => {
  it('paginates the cohort with content-minimized fields and stops after older issues', async () => {
    const window = trailingInstantWindow(GENERATED_AT, 90, 7)
    const bodies: string[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body)
      bodies.push(body)
      const variables = JSON.parse(body) as { variables: { cursor: string | null } }
      if (variables.variables.cursor === null) {
        return jsonResponse({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: true, endCursor: 'next' },
                nodes: [
                  {
                    createdAt: '2026-07-01T10:00:00Z',
                    author: { __typename: 'User', login: 'contributor' },
                    comments: {
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          createdAt: '2026-07-01T11:00:00Z',
                          author: { __typename: 'User', login: 'maintainer' },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        })
      }
      return jsonResponse({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: true, endCursor: 'unused' },
              nodes: [
                {
                  createdAt: '2026-01-01T00:00:00Z',
                  author: { __typename: 'User', login: 'old' },
                  comments: { pageInfo: { hasNextPage: false }, nodes: [] },
                },
              ],
            },
          },
        },
      })
    }) as typeof fetch

    const issues = await loadIssues('owner/repository', window, {
      token: 'test-token',
      fetchImpl,
    })
    expect(issues).toHaveLength(1)
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body).not.toMatch(/\b(title|body|number|url|labels|reactions)\b/)
    }
  })

  it('fails when an issue has unproven comment pagination', async () => {
    const window = trailingInstantWindow(GENERATED_AT, 90, 7)
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  createdAt: '2026-07-01T10:00:00Z',
                  author: { __typename: 'User', login: 'contributor' },
                  comments: { pageInfo: { hasNextPage: true }, nodes: [] },
                },
              ],
            },
          },
        },
      }),
    ) as typeof fetch
    await expect(
      loadIssues('owner/repository', window, { token: 'test-token', fetchImpl }),
    ).rejects.toMatchObject({ reason: 'incomplete_data' })
  })
})

describe('GitHub merged pull request metadata', () => {
  it('requires complete pagination and retains only merge time plus transient actor fields', async () => {
    const bodies: string[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body)
      bodies.push(body)
      const variables = JSON.parse(body) as { variables: { cursor: string | null } }
      return jsonResponse({
        data: {
          repository: {
            pullRequests:
              variables.variables.cursor === null
                ? {
                    pageInfo: { hasNextPage: true, endCursor: 'next' },
                    nodes: [
                      {
                        mergedAt: '2026-07-01T10:00:00Z',
                        author: { __typename: 'User', login: 'first', id: 'U1' },
                      },
                    ],
                  }
                : {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        mergedAt: '2026-06-01T10:00:00Z',
                        author: { __typename: 'Bot', login: 'robot', id: 'B1' },
                      },
                    ],
                  },
          },
        },
      })
    }) as typeof fetch

    const pullRequests = await loadMergedPullRequests('owner/repository', {
      token: 'test-token',
      fetchImpl,
    })
    expect(pullRequests).toEqual([
      {
        mergedAt: '2026-07-01T10:00:00Z',
        author: { type: 'User', login: 'first', id: 'U1' },
      },
      {
        mergedAt: '2026-06-01T10:00:00Z',
        author: { type: 'Bot', login: 'robot', id: 'B1' },
      },
    ])
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).not.toMatch(/\b(title|body|number|url|labels|reactions)\b/)
  })

  it.each([
    [{ extensions: { code: 'RATE_LIMITED' } }, 'rate_limited'],
    [{ type: 'FORBIDDEN' }, 'permission_denied'],
    [{ extensions: { code: 'UNAUTHENTICATED' } }, 'permission_denied'],
    [{ extensions: { code: 'UNKNOWN' } }, 'invalid_response'],
  ] as const)('maps GraphQL error code %o to %s', async (error, reason) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: null, errors: [error] }),
    ) as typeof fetch

    await expect(
      loadMergedPullRequests('owner/repository', {
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason })
  })
})
