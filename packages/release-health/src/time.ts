import { SourceUnavailableError } from './errors.js'

const DAY_MS = 24 * 60 * 60 * 1000

export function parseInstant(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
  const seconds = match?.[1]
  if (seconds === undefined) {
    throw new SourceUnavailableError('invalid_response')
  }
  const timestamp = Date.parse(value)
  const milliseconds = (match?.[2] ?? '').padEnd(3, '0')
  const canonical = `${seconds}.${milliseconds}Z`
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) {
    throw new SourceUnavailableError('invalid_response')
  }
  return timestamp
}

export function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SourceUnavailableError('invalid_response')
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new SourceUnavailableError('invalid_response')
  }
  return timestamp
}

export function toDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function addDays(timestamp: number, days: number): number {
  return timestamp + days * DAY_MS
}

export function completeDateWindow(
  generatedAt: string,
  days: number,
): {
  readonly start: string
  readonly end: string
  readonly dates: readonly string[]
} {
  const generatedTimestamp = parseInstant(generatedAt)
  const generatedDateTimestamp = Date.parse(`${toDate(generatedTimestamp)}T00:00:00.000Z`)
  const endTimestamp = addDays(generatedDateTimestamp, -1)
  const startTimestamp = addDays(endTimestamp, -(days - 1))
  const dates = Array.from({ length: days }, (_, index) => toDate(addDays(startTimestamp, index)))
  return { start: toDate(startTimestamp), end: toDate(endTimestamp), dates }
}

export function currentDateWindow(
  generatedAt: string,
  days: number,
): {
  readonly start: string
  readonly end: string
  readonly dates: readonly string[]
} {
  const generatedTimestamp = parseInstant(generatedAt)
  const endTimestamp = Date.parse(`${toDate(generatedTimestamp)}T00:00:00.000Z`)
  const startTimestamp = addDays(endTimestamp, -(days - 1))
  const dates = Array.from({ length: days }, (_, index) => toDate(addDays(startTimestamp, index)))
  return { start: toDate(startTimestamp), end: toDate(endTimestamp), dates }
}

export function trailingInstantWindow(
  generatedAt: string,
  startDaysAgo: number,
  endDaysAgo = 0,
): { readonly start: string; readonly end: string } {
  const generatedTimestamp = parseInstant(generatedAt)
  return {
    start: new Date(addDays(generatedTimestamp, -startDaysAgo)).toISOString(),
    end: new Date(addDays(generatedTimestamp, -endDaysAgo)).toISOString(),
  }
}

export function assertNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SourceUnavailableError('invalid_response')
  }
  return value
}
