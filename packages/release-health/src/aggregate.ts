import { SourceUnavailableError } from './errors.js'
import type { GovernanceTimeline } from './governance.js'
import type { GitHubActor, GitHubIssue, GitHubMergedPullRequest } from './github-source.js'
import type {
  ContributorGrowthMetric,
  MaintainerResponsivenessMetric,
  MetricWindow,
} from './schema.js'
import { addDays, parseInstant } from './time.js'

const RESPONSE_TARGET_SECONDS = 7 * 24 * 60 * 60

function isBot(actor: GitHubActor): boolean {
  return actor.type === 'Bot'
}

function normalizedLogin(actor: GitHubActor): string {
  if (actor.login === null) throw new SourceUnavailableError('incomplete_data')
  return actor.login.toLowerCase()
}

export function nearestRank(sortedValues: readonly number[], percentile: number): number {
  if (
    sortedValues.length === 0 ||
    !Number.isFinite(percentile) ||
    percentile <= 0 ||
    percentile > 1
  ) {
    throw new SourceUnavailableError('invalid_response')
  }
  const index = Math.ceil(percentile * sortedValues.length) - 1
  const value = sortedValues[index]
  if (value === undefined) throw new SourceUnavailableError('invalid_response')
  return value
}

export function aggregateMaintainerResponsiveness(
  issues: readonly GitHubIssue[],
  window: MetricWindow,
  generatedAt: string,
  governance: GovernanceTimeline,
): MaintainerResponsivenessMetric {
  const startTimestamp = parseInstant(window.start)
  const endTimestamp = parseInstant(window.end)
  const generatedTimestamp = parseInstant(generatedAt)
  const delays: number[] = []
  let eligibleIssueCount = 0
  let withinTargetCount = 0

  for (const issue of issues) {
    const createdTimestamp = parseInstant(issue.createdAt)
    if (createdTimestamp < startTimestamp || createdTimestamp > endTimestamp) continue
    if (isBot(issue.author)) continue
    const authorLogin = normalizedLogin(issue.author)
    if (governance.maintainersAt(issue.createdAt).has(authorLogin)) continue

    eligibleIssueCount += 1
    let firstResponseTimestamp: number | null = null
    const comments = issue.comments
      .map((comment) => ({ comment, timestamp: parseInstant(comment.createdAt) }))
      .sort((left, right) => left.timestamp - right.timestamp)
    for (const { comment, timestamp: commentTimestamp } of comments) {
      if (commentTimestamp < createdTimestamp) {
        throw new SourceUnavailableError('incomplete_data')
      }
      if (commentTimestamp > generatedTimestamp || isBot(comment.author)) continue
      const commentLogin = normalizedLogin(comment.author)
      if (!governance.maintainersAt(comment.createdAt).has(commentLogin)) continue
      firstResponseTimestamp = commentTimestamp
      break
    }

    if (firstResponseTimestamp !== null) {
      const delay = Math.floor((firstResponseTimestamp - createdTimestamp) / 1_000)
      delays.push(delay)
      if (delay <= RESPONSE_TARGET_SECONDS) withinTargetCount += 1
    }
  }

  delays.sort((left, right) => left - right)
  return {
    status: 'available',
    source: 'github_issues',
    window,
    eligible_issue_count: eligibleIssueCount,
    response_count: delays.length,
    response_within_7_days_count: withinTargetCount,
    response_coverage: eligibleIssueCount === 0 ? null : withinTargetCount / eligibleIssueCount,
    p50_response_seconds: delays.length < 5 ? null : nearestRank(delays, 0.5),
    p90_response_seconds: delays.length < 10 ? null : nearestRank(delays, 0.9),
  }
}

export function aggregateContributorGrowth(
  pullRequests: readonly GitHubMergedPullRequest[],
  window: MetricWindow,
  generatedAt: string,
): ContributorGrowthMetric {
  const generatedTimestamp = parseInstant(generatedAt)
  const thirtyDayStart = addDays(generatedTimestamp, -30)
  const ninetyDayStart = parseInstant(window.start)
  const firstMergeByActor = new Map<string, number>()
  let unclassifiedAuthorRecords = 0

  for (const pullRequest of pullRequests) {
    const mergedTimestamp = parseInstant(pullRequest.mergedAt)
    if (mergedTimestamp > generatedTimestamp) {
      throw new SourceUnavailableError('incomplete_data')
    }
    if (isBot(pullRequest.author)) continue
    if (pullRequest.author.id === null) {
      unclassifiedAuthorRecords += 1
      continue
    }
    const actorKey = `${pullRequest.author.type}:${pullRequest.author.id}`
    const previous = firstMergeByActor.get(actorKey)
    if (previous === undefined || mergedTimestamp < previous) {
      firstMergeByActor.set(actorKey, mergedTimestamp)
    }
  }

  const firstMerges = [...firstMergeByActor.values()]
  return {
    status: 'available',
    source: 'github_merged_pull_requests',
    window,
    first_merged_within_30_days: firstMerges.filter((timestamp) => timestamp >= thirtyDayStart)
      .length,
    first_merged_within_90_days: firstMerges.filter((timestamp) => timestamp >= ninetyDayStart)
      .length,
    cumulative_contributor_accounts: firstMerges.length,
    unclassified_author_records: unclassifiedAuthorRecords,
  }
}
