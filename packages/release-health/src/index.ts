export {
  aggregateContributorGrowth,
  aggregateMaintainerResponsiveness,
  nearestRank,
} from './aggregate.js'
export { SourceUnavailableError, unavailableReason } from './errors.js'
export {
  collectRepositoryDiscovery,
  loadIssues,
  loadMergedPullRequests,
  parseRepository,
  type GitHubActor,
  type GitHubIssue,
  type GitHubMergedPullRequest,
  type GitHubSourceOptions,
} from './github-source.js'
export {
  createGitExecutor,
  createGovernanceTimeline,
  loadGovernanceTimeline,
  parseMaintainers,
  type GitExecutor,
  type GovernanceEntry,
  type GovernanceTimeline,
} from './governance.js'
export { collectPackageAdoption } from './npm-source.js'
export { generateReleaseHealthReport, type GenerateReportOptions } from './report.js'
export * from './schema.js'
export { completeDateWindow, currentDateWindow, trailingInstantWindow } from './time.js'
export { loadPublishableWorkspaces, type PublishableWorkspace } from './workspaces.js'
