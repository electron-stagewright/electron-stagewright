import type { UnavailableReason } from './errors.js'

export const RELEASE_HEALTH_SCHEMA_VERSION = 1 as const

export type ReleaseHealthSource =
  'npm_downloads' | 'github_repository_traffic' | 'github_issues' | 'github_merged_pull_requests'

export interface MetricWindow {
  readonly start: string
  readonly end: string
}

export interface UnavailableMetric {
  readonly status: 'unavailable'
  readonly source: ReleaseHealthSource
  readonly window: MetricWindow
  readonly reason: UnavailableReason
}

export interface DailyCount {
  readonly date: string
  readonly count: number
}

export interface PackageDownloadAggregate {
  readonly package: string
  readonly daily: readonly DailyCount[]
  readonly rolling_7_day: number
  readonly rolling_30_day: number
}

export interface PackageAdoptionMetric {
  readonly status: 'available'
  readonly source: 'npm_downloads'
  readonly window: MetricWindow
  readonly packages: readonly PackageDownloadAggregate[]
}

export interface DailyCloneAggregate {
  readonly date: string
  readonly count: number
  readonly unique_cloners: number
}

export interface CloneSnapshot {
  readonly count: number
  readonly unique_cloners: number
}

export interface RepositoryDiscoveryMetric {
  readonly status: 'available'
  readonly source: 'github_repository_traffic'
  readonly window: MetricWindow
  readonly daily: readonly DailyCloneAggregate[]
  readonly snapshot_14_day: CloneSnapshot
}

export interface MaintainerResponsivenessMetric {
  readonly status: 'available'
  readonly source: 'github_issues'
  readonly window: MetricWindow
  readonly eligible_issue_count: number
  readonly response_count: number
  readonly response_within_7_days_count: number
  readonly response_coverage: number | null
  readonly p50_response_seconds: number | null
  readonly p90_response_seconds: number | null
}

export interface ContributorGrowthMetric {
  readonly status: 'available'
  readonly source: 'github_merged_pull_requests'
  readonly window: MetricWindow
  readonly first_merged_within_30_days: number
  readonly first_merged_within_90_days: number
  readonly cumulative_contributor_accounts: number
  readonly unclassified_author_records: number
}

export interface ReleaseHealthReport {
  readonly schema_version: typeof RELEASE_HEALTH_SCHEMA_VERSION
  readonly generated_at: string
  readonly repository: string
  readonly metrics: {
    readonly package_adoption: PackageAdoptionMetric | UnavailableMetric
    readonly repository_discovery: RepositoryDiscoveryMetric | UnavailableMetric
    readonly maintainer_responsiveness: MaintainerResponsivenessMetric | UnavailableMetric
    readonly contributor_growth: ContributorGrowthMetric | UnavailableMetric
  }
}

export function unavailableMetric(
  source: ReleaseHealthSource,
  window: MetricWindow,
  reason: UnavailableReason,
): UnavailableMetric {
  return {
    status: 'unavailable',
    source,
    window: { start: window.start, end: window.end },
    reason,
  }
}
