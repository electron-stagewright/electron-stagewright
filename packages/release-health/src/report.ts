import { aggregateContributorGrowth, aggregateMaintainerResponsiveness } from './aggregate.js'
import { unavailableReason } from './errors.js'
import {
  collectRepositoryDiscovery,
  loadIssues,
  loadMergedPullRequests,
  type GitHubSourceOptions,
} from './github-source.js'
import { createGitExecutor, loadGovernanceTimeline, type GitExecutor } from './governance.js'
import { collectPackageAdoption } from './npm-source.js'
import {
  RELEASE_HEALTH_SCHEMA_VERSION,
  unavailableMetric,
  type ContributorGrowthMetric,
  type MaintainerResponsivenessMetric,
  type PackageAdoptionMetric,
  type ReleaseHealthReport,
  type RepositoryDiscoveryMetric,
  type UnavailableMetric,
} from './schema.js'
import { completeDateWindow, currentDateWindow, trailingInstantWindow } from './time.js'
import { loadPublishableWorkspaces } from './workspaces.js'

export interface GenerateReportOptions {
  readonly repositoryRoot: string
  readonly repository: string
  readonly githubToken?: string
  readonly fetchImpl?: typeof fetch
  readonly executeGit?: GitExecutor
  readonly generatedAt?: string
  readonly now?: () => Date
  readonly timeoutMs?: number
}

async function packageAdoption(
  options: GenerateReportOptions,
  generatedAt: string,
): Promise<PackageAdoptionMetric | UnavailableMetric> {
  const window = completeDateWindow(generatedAt, 30)
  try {
    const workspaces = await loadPublishableWorkspaces(options.repositoryRoot)
    return await collectPackageAdoption(workspaces, window, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
  } catch (error) {
    return unavailableMetric('npm_downloads', window, unavailableReason(error))
  }
}

function githubOptions(options: GenerateReportOptions): GitHubSourceOptions | null {
  if (options.githubToken === undefined || options.githubToken.trim().length === 0) return null
  return {
    token: options.githubToken,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }
}

async function repositoryDiscovery(
  options: GenerateReportOptions,
  sourceOptions: GitHubSourceOptions | null,
  generatedAt: string,
): Promise<RepositoryDiscoveryMetric | UnavailableMetric> {
  const window = currentDateWindow(generatedAt, 14)
  if (sourceOptions === null) {
    return unavailableMetric('github_repository_traffic', window, 'missing_credential')
  }
  try {
    return await collectRepositoryDiscovery(options.repository, window, sourceOptions)
  } catch (error) {
    return unavailableMetric('github_repository_traffic', window, unavailableReason(error))
  }
}

async function maintainerResponsiveness(
  options: GenerateReportOptions,
  sourceOptions: GitHubSourceOptions | null,
  generatedAt: string,
): Promise<MaintainerResponsivenessMetric | UnavailableMetric> {
  const window = trailingInstantWindow(generatedAt, 90, 7)
  if (sourceOptions === null) {
    return unavailableMetric('github_issues', window, 'missing_credential')
  }
  try {
    const executeGit = options.executeGit ?? createGitExecutor(options.repositoryRoot)
    const [issues, governance] = await Promise.all([
      loadIssues(options.repository, window, sourceOptions),
      loadGovernanceTimeline(executeGit),
    ])
    return aggregateMaintainerResponsiveness(issues, window, generatedAt, governance)
  } catch (error) {
    return unavailableMetric('github_issues', window, unavailableReason(error))
  }
}

async function contributorGrowth(
  options: GenerateReportOptions,
  sourceOptions: GitHubSourceOptions | null,
  generatedAt: string,
): Promise<ContributorGrowthMetric | UnavailableMetric> {
  const window = trailingInstantWindow(generatedAt, 90)
  if (sourceOptions === null) {
    return unavailableMetric('github_merged_pull_requests', window, 'missing_credential')
  }
  try {
    const pullRequests = await loadMergedPullRequests(options.repository, sourceOptions)
    return aggregateContributorGrowth(pullRequests, window, generatedAt)
  } catch (error) {
    return unavailableMetric('github_merged_pull_requests', window, unavailableReason(error))
  }
}

export async function generateReleaseHealthReport(
  options: GenerateReportOptions,
): Promise<ReleaseHealthReport> {
  const generatedAt = options.generatedAt ?? (options.now ?? (() => new Date()))().toISOString()
  const sourceOptions = githubOptions(options)
  const [adoptionMetric, discoveryMetric, responsivenessMetric, contributorMetric] =
    await Promise.all([
      packageAdoption(options, generatedAt),
      repositoryDiscovery(options, sourceOptions, generatedAt),
      maintainerResponsiveness(options, sourceOptions, generatedAt),
      contributorGrowth(options, sourceOptions, generatedAt),
    ])

  return {
    schema_version: RELEASE_HEALTH_SCHEMA_VERSION,
    generated_at: generatedAt,
    repository: options.repository,
    metrics: {
      package_adoption: adoptionMetric,
      repository_discovery: discoveryMetric,
      maintainer_responsiveness: responsivenessMetric,
      contributor_growth: contributorMetric,
    },
  }
}
