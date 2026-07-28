import { SourceUnavailableError } from './errors.js'
import { requestJson } from './http.js'
import type {
  DailyCount,
  MetricWindow,
  PackageAdoptionMetric,
  PackageDownloadAggregate,
} from './schema.js'
import { assertNonNegativeInteger, parseDate } from './time.js'
import { array, record, string } from './validation.js'
import type { PublishableWorkspace } from './workspaces.js'

interface NpmCollectionOptions {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

function sum(counts: readonly DailyCount[]): number {
  const total = counts.reduce((aggregate, entry) => aggregate + entry.count, 0)
  return assertNonNegativeInteger(total)
}

function validateDownloadRange(
  payload: unknown,
  workspace: PublishableWorkspace,
  window: MetricWindow & { readonly dates: readonly string[] },
): PackageDownloadAggregate {
  const response = record(payload)
  if (
    string(response['package']) !== workspace.name ||
    string(response['start']) !== window.start ||
    string(response['end']) !== window.end
  ) {
    throw new SourceUnavailableError('incomplete_data')
  }

  const downloads = array(response['downloads'])
  if (downloads.length !== window.dates.length) {
    throw new SourceUnavailableError('incomplete_data')
  }

  const daily = downloads.map((value, index): DailyCount => {
    const item = record(value)
    const date = string(item['day'])
    parseDate(date)
    if (date !== window.dates[index]) throw new SourceUnavailableError('incomplete_data')
    return { date, count: assertNonNegativeInteger(item['downloads']) }
  })

  return {
    package: workspace.name,
    daily,
    rolling_7_day: sum(daily.slice(-7)),
    rolling_30_day: sum(daily),
  }
}

export async function collectPackageAdoption(
  workspaces: readonly PublishableWorkspace[],
  window: MetricWindow & { readonly dates: readonly string[] },
  options: NpmCollectionOptions = {},
): Promise<PackageAdoptionMetric> {
  if (workspaces.length === 0) throw new SourceUnavailableError('incomplete_data')

  const packages = await Promise.all(
    workspaces.map(async (workspace) => {
      const encodedPackage = encodeURIComponent(workspace.name)
      const payload = await requestJson(
        `https://api.npmjs.org/downloads/range/${window.start}:${window.end}/${encodedPackage}`,
        { headers: { accept: 'application/json' } },
        {
          source: 'npm',
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
      )
      return validateDownloadRange(payload, workspace, window)
    }),
  )

  return {
    status: 'available',
    source: 'npm_downloads',
    window: { start: window.start, end: window.end },
    packages,
  }
}
