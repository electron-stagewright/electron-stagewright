import { describe, expect, it } from 'vitest'

import {
  aggregateContributorGrowth,
  aggregateMaintainerResponsiveness,
  nearestRank,
} from '../src/aggregate.js'
import {
  createGovernanceTimeline,
  loadGovernanceTimeline,
  parseMaintainers,
  type GitExecutor,
} from '../src/governance.js'
import type { GitHubActor, GitHubIssue, GitHubMergedPullRequest } from '../src/github-source.js'
import { trailingInstantWindow } from '../src/time.js'

const GENERATED_AT = '2026-07-27T00:00:00.000Z'

function actor(login: string | null, type = 'User', id: string | null = null): GitHubActor {
  return { type, login, id }
}

describe('governance history', () => {
  it('parses only the maintainer table and normalizes handles', () => {
    const document = `# Governance

## Maintainers

| Maintainer | Role |
| --- | --- |
| [@Lead-One](https://github.com/lead-one) | Lead |

## Other

[@outsider](https://github.com/outsider)
`
    expect([...parseMaintainers(document)]).toEqual(['lead-one'])
  })

  it('loads a complete, time-indexed roster from tracked Git history', async () => {
    const firstHash = 'a'.repeat(40)
    const secondHash = 'b'.repeat(40)
    const executeGit: GitExecutor = async (arguments_) => {
      if (arguments_[0] === 'rev-parse') return 'false\n'
      if (arguments_[0] === 'log') {
        return `${firstHash}\t1735689600\n${secondHash}\t1767225600\n`
      }
      if (arguments_[1] === `${firstHash}:.github/GOVERNANCE.md`) {
        return '## Maintainers\n\n| [@first](https://github.com/first) | Lead |\n'
      }
      return '## Maintainers\n\n| [@second](https://github.com/second) | Lead |\n'
    }

    const timeline = await loadGovernanceTimeline(executeGit)
    expect([...timeline.maintainersAt('2025-06-01T00:00:00Z')]).toEqual(['first'])
    expect([...timeline.maintainersAt('2026-06-01T00:00:00Z')]).toEqual(['second'])
    expect(() => timeline.maintainersAt('2024-12-01T00:00:00Z')).toThrow()
  })

  it('rejects shallow repositories and ambiguous rosters', async () => {
    await expect(loadGovernanceTimeline(async () => 'true\n')).rejects.toMatchObject({
      reason: 'governance_history_incomplete',
    })
    expect(() => parseMaintainers('## Maintainers\n[@one](https://github.com/two)\n')).toThrow()

    const malformedHistory: GitExecutor = async (arguments_) => {
      if (arguments_[0] === 'rev-parse') return 'false\n'
      return 'not-a-commit\t123\n'
    }
    await expect(loadGovernanceTimeline(malformedHistory)).rejects.toMatchObject({
      reason: 'governance_history_incomplete',
    })
  })
})

describe('maintainer responsiveness', () => {
  const governance = createGovernanceTimeline([
    {
      effectiveAt: '2025-01-01T00:00:00.000Z',
      maintainers: new Set(['maintainer']),
    },
  ])
  const window = trailingInstantWindow(GENERATED_AT, 90, 7)

  it('uses event-time rosters, explicit coverage, and nearest-rank thresholds', () => {
    const issues: GitHubIssue[] = Array.from({ length: 10 }, (_, index) => {
      const createdAt = `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00Z`
      const responseDays = index + 1
      const response = new Date(
        Date.parse(createdAt) + responseDays * 24 * 60 * 60 * 1_000,
      ).toISOString()
      return {
        createdAt,
        author: actor(`contributor-${index}`),
        comments: [{ createdAt: response, author: actor('maintainer') }],
      }
    })
    issues.push({
      createdAt: '2026-06-20T00:00:00Z',
      author: actor('maintainer'),
      comments: [],
    })
    issues.push({
      createdAt: '2026-06-21T00:00:00Z',
      author: actor('robot', 'Bot'),
      comments: [],
    })

    const metric = aggregateMaintainerResponsiveness(issues, window, GENERATED_AT, governance)
    expect(metric).toMatchObject({
      eligible_issue_count: 10,
      response_count: 10,
      response_within_7_days_count: 7,
      response_coverage: 0.7,
      p50_response_seconds: 432000,
      p90_response_seconds: 777600,
    })
  })

  it('fails closed when a non-bot actor cannot be classified', () => {
    expect(() =>
      aggregateMaintainerResponsiveness(
        [
          {
            createdAt: '2026-06-01T00:00:00Z',
            author: actor(null),
            comments: [],
          },
        ],
        window,
        GENERATED_AT,
        governance,
      ),
    ).toThrow()
    expect(nearestRank([1, 2, 3, 4], 0.5)).toBe(2)
    expect(() => nearestRank([], 0.5)).toThrow()
    expect(() =>
      aggregateMaintainerResponsiveness(
        [
          {
            createdAt: '2026-06-01T00:00:00Z',
            author: actor('contributor'),
            comments: [
              {
                createdAt: '2026-05-31T23:59:59Z',
                author: actor('maintainer'),
              },
            ],
          },
        ],
        window,
        GENERATED_AT,
        governance,
      ),
    ).toThrow()
  })

  it('classifies issue authors and responders against the roster at each event', () => {
    const eventTimeGovernance = createGovernanceTimeline([
      {
        effectiveAt: '2025-01-01T00:00:00.000Z',
        maintainers: new Set(['original']),
      },
      {
        effectiveAt: '2026-06-02T00:00:00.000Z',
        maintainers: new Set(['original', 'future-maintainer']),
      },
    ])
    const metric = aggregateMaintainerResponsiveness(
      [
        {
          createdAt: '2026-06-01T00:00:00Z',
          author: actor('future-maintainer'),
          comments: [
            {
              createdAt: '2026-06-03T00:00:00Z',
              author: actor('future-maintainer'),
            },
          ],
        },
      ],
      window,
      GENERATED_AT,
      eventTimeGovernance,
    )
    expect(metric).toMatchObject({
      eligible_issue_count: 1,
      response_count: 1,
      response_within_7_days_count: 1,
    })
  })
})

describe('contributor growth', () => {
  it('deduplicates stable actors, includes maintainers, excludes bots, and counts unknown records', () => {
    const pullRequests: GitHubMergedPullRequest[] = [
      { mergedAt: '2026-07-20T00:00:00Z', author: actor('one', 'User', 'U1') },
      { mergedAt: '2026-07-21T00:00:00Z', author: actor('one', 'User', 'U1') },
      { mergedAt: '2026-06-01T00:00:00Z', author: actor('maintainer', 'User', 'U2') },
      { mergedAt: '2025-01-01T00:00:00Z', author: actor('old', 'User', 'U3') },
      { mergedAt: '2026-07-22T00:00:00Z', author: actor('robot', 'Bot', 'B1') },
      { mergedAt: '2026-07-23T00:00:00Z', author: actor(null) },
    ]
    const metric = aggregateContributorGrowth(
      pullRequests,
      trailingInstantWindow(GENERATED_AT, 90),
      GENERATED_AT,
    )
    expect(metric).toMatchObject({
      first_merged_within_30_days: 1,
      first_merged_within_90_days: 2,
      cumulative_contributor_accounts: 3,
      unclassified_author_records: 1,
    })
    expect(JSON.stringify(metric)).not.toMatch(/U1|maintainer|robot/)

    expect(() =>
      aggregateContributorGrowth(
        [{ mergedAt: '2026-07-28T00:00:01Z', author: actor('future', 'User', 'U4') }],
        trailingInstantWindow(GENERATED_AT, 90),
        GENERATED_AT,
      ),
    ).toThrow()
  })
})
