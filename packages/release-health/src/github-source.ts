import { SourceUnavailableError } from './errors.js'
import { requestJson } from './http.js'
import type { DailyCloneAggregate, MetricWindow, RepositoryDiscoveryMetric } from './schema.js'
import { assertNonNegativeInteger, parseInstant, toDate } from './time.js'
import { array, boolean, nullableString, record, string } from './validation.js'

export interface GitHubActor {
  readonly type: string
  readonly login: string | null
  readonly id: string | null
}

export interface GitHubIssueComment {
  readonly createdAt: string
  readonly author: GitHubActor
}

export interface GitHubIssue {
  readonly createdAt: string
  readonly author: GitHubActor
  readonly comments: readonly GitHubIssueComment[]
}

export interface GitHubMergedPullRequest {
  readonly mergedAt: string
  readonly author: GitHubActor
}

export interface GitHubSourceOptions {
  readonly token: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly maxPages?: number
}

interface RepositoryCoordinates {
  readonly owner: string
  readonly name: string
}

interface GraphQlPageInfo {
  readonly hasNextPage: boolean
  readonly endCursor: string | null
}

const GITHUB_API_VERSION = '2026-03-10'

const ISSUE_QUERY = `
  query ReleaseHealthIssues($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issues(
        first: 100
        after: $cursor
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          createdAt
          author { __typename login }
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              createdAt
              author { __typename login }
            }
          }
        }
      }
    }
  }
`

const MERGED_PULL_REQUEST_QUERY = `
  query ReleaseHealthMergedPullRequests($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 100, after: $cursor, states: MERGED) {
        pageInfo { hasNextPage endCursor }
        nodes {
          mergedAt
          author {
            __typename
            login
            ... on Bot { id }
            ... on Mannequin { id }
            ... on Organization { id }
            ... on User { id }
          }
        }
      }
    }
  }
`

export function parseRepository(repository: string): RepositoryCoordinates {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository)
  const owner = match?.[1]
  const name = match?.[2]
  if (owner === undefined || name === undefined) {
    throw new SourceUnavailableError('invalid_response')
  }
  return { owner, name }
}

function githubRequestOptions(options: GitHubSourceOptions) {
  return {
    source: 'github' as const,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }
}

function actor(value: unknown): GitHubActor {
  if (value === null) {
    return { type: 'Unknown', login: null, id: null }
  }
  const raw = record(value)
  const type = string(raw['__typename'])
  const login = nullableString(raw['login'])
  const id = raw['id'] === undefined ? null : nullableString(raw['id'])
  return { type, login, id }
}

function pageInfo(value: unknown): GraphQlPageInfo {
  const raw = record(value)
  const rawEndCursor = raw['endCursor']
  return {
    hasNextPage: boolean(raw['hasNextPage']),
    endCursor: rawEndCursor === undefined ? null : nullableString(rawEndCursor),
  }
}

async function graphQl(
  query: string,
  variables: Readonly<Record<string, string | null>>,
  options: GitHubSourceOptions,
): Promise<Record<string, unknown>> {
  const payload = await requestJson(
    'https://api.github.com/graphql',
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
        'x-github-api-version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    },
    githubRequestOptions(options),
  )
  const response = record(payload)
  if (response['errors'] !== undefined || response['data'] === null) {
    throw new SourceUnavailableError('invalid_response')
  }
  return record(response['data'])
}

function nextCursor(info: GraphQlPageInfo): string | null {
  if (!info.hasNextPage) return null
  if (info.endCursor === null) throw new SourceUnavailableError('incomplete_data')
  return info.endCursor
}

export async function collectRepositoryDiscovery(
  repository: string,
  window: MetricWindow & { readonly dates: readonly string[] },
  options: GitHubSourceOptions,
): Promise<RepositoryDiscoveryMetric> {
  const { owner, name } = parseRepository(repository)
  const payload = await requestJson(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/traffic/clones`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'x-github-api-version': GITHUB_API_VERSION,
      },
    },
    githubRequestOptions(options),
  )
  const response = record(payload)
  const count = assertNonNegativeInteger(response['count'])
  const uniqueCloners = assertNonNegativeInteger(response['uniques'])
  const rawClones = array(response['clones'])
  if (rawClones.length !== window.dates.length) {
    throw new SourceUnavailableError('incomplete_data')
  }

  const daily = rawClones.map((value, index): DailyCloneAggregate => {
    const clone = record(value)
    const timestamp = string(clone['timestamp'])
    const timestampValue = parseInstant(timestamp)
    const date = toDate(timestampValue)
    if (date !== window.dates[index]) throw new SourceUnavailableError('incomplete_data')
    return {
      date,
      count: assertNonNegativeInteger(clone['count']),
      unique_cloners: assertNonNegativeInteger(clone['uniques']),
    }
  })
  const dailyCount = assertNonNegativeInteger(
    daily.reduce((total, entry) => total + entry.count, 0),
  )
  if (dailyCount !== count) throw new SourceUnavailableError('incomplete_data')

  return {
    status: 'available',
    source: 'github_repository_traffic',
    window: { start: window.start, end: window.end },
    daily,
    snapshot_14_day: { count, unique_cloners: uniqueCloners },
  }
}

export async function loadIssues(
  repository: string,
  cohortWindow: MetricWindow,
  options: GitHubSourceOptions,
): Promise<readonly GitHubIssue[]> {
  const { owner, name } = parseRepository(repository)
  const startTimestamp = parseInstant(cohortWindow.start)
  const maxPages = options.maxPages ?? 1_000
  const issues: GitHubIssue[] = []
  let cursor: string | null = null
  let previousTimestamp = Number.POSITIVE_INFINITY

  for (let page = 0; page < maxPages; page += 1) {
    const data = await graphQl(ISSUE_QUERY, { owner, name, cursor }, options)
    const repositoryData = record(data['repository'])
    const connection = record(repositoryData['issues'])
    const info = pageInfo(connection['pageInfo'])
    const nodes = array(connection['nodes'])
    if (nodes.length === 0 && info.hasNextPage) {
      throw new SourceUnavailableError('incomplete_data')
    }

    let reachedBeforeCohort = false
    for (const value of nodes) {
      const node = record(value)
      const createdAt = string(node['createdAt'])
      const createdTimestamp = parseInstant(createdAt)
      if (createdTimestamp > previousTimestamp) {
        throw new SourceUnavailableError('incomplete_data')
      }
      previousTimestamp = createdTimestamp
      if (createdTimestamp < startTimestamp) {
        reachedBeforeCohort = true
        continue
      }

      const commentsConnection = record(node['comments'])
      const commentsInfo = pageInfo(commentsConnection['pageInfo'])
      if (commentsInfo.hasNextPage) throw new SourceUnavailableError('incomplete_data')
      const comments = array(commentsConnection['nodes']).map((commentValue) => {
        const comment = record(commentValue)
        const commentCreatedAt = string(comment['createdAt'])
        parseInstant(commentCreatedAt)
        return {
          createdAt: commentCreatedAt,
          author: actor(comment['author']),
        }
      })
      issues.push({
        createdAt,
        author: actor(node['author']),
        comments,
      })
    }

    if (reachedBeforeCohort || !info.hasNextPage) return issues
    cursor = nextCursor(info)
  }

  throw new SourceUnavailableError('incomplete_data')
}

export async function loadMergedPullRequests(
  repository: string,
  options: GitHubSourceOptions,
): Promise<readonly GitHubMergedPullRequest[]> {
  const { owner, name } = parseRepository(repository)
  const maxPages = options.maxPages ?? 1_000
  const pullRequests: GitHubMergedPullRequest[] = []
  let cursor: string | null = null

  for (let page = 0; page < maxPages; page += 1) {
    const data = await graphQl(MERGED_PULL_REQUEST_QUERY, { owner, name, cursor }, options)
    const repositoryData = record(data['repository'])
    const connection = record(repositoryData['pullRequests'])
    const info = pageInfo(connection['pageInfo'])
    const nodes = array(connection['nodes'])
    if (nodes.length === 0 && info.hasNextPage) {
      throw new SourceUnavailableError('incomplete_data')
    }

    for (const value of nodes) {
      const node = record(value)
      const mergedAt = string(node['mergedAt'])
      parseInstant(mergedAt)
      pullRequests.push({
        mergedAt,
        author: actor(node['author']),
      })
    }

    if (!info.hasNextPage) return pullRequests
    cursor = nextCursor(info)
  }

  throw new SourceUnavailableError('incomplete_data')
}
