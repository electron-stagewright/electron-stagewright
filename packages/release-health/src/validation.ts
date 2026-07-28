import { SourceUnavailableError } from './errors.js'

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SourceUnavailableError('invalid_response')
  }
  return value as Record<string, unknown>
}

export function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new SourceUnavailableError('invalid_response')
  return value
}

export function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SourceUnavailableError('invalid_response')
  }
  return value
}

export function nullableString(value: unknown): string | null {
  if (value === null) return null
  return string(value)
}

export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new SourceUnavailableError('invalid_response')
  return value
}
