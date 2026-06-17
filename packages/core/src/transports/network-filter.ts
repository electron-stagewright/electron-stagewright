/**
 * The network-capture allowlist matcher — shared by the Playwright transport (record-time filtering)
 * and the in-memory test fake, so the "is this request captured?" rule lives in exactly one place.
 *
 * Matching is intentionally simple and transport-neutral: a URL matches when it CONTAINS any
 * allowlist substring, and (when a method filter is present) its method is in that list
 * case-insensitively. Substring rather than glob keeps the semantics predictable across platforms and
 * trivially testable; the deliberate trade-off is that a broad substring can over-match.
 *
 * @module
 */

import type { NetworkCaptureFilter } from './types.js'

/** The minimal shape the matcher inspects — a structural subset of {@link NetworkEvent}. */
export interface NetworkMatchable {
  readonly url: string
  readonly method: string
}

/**
 * Whether `event` passes `filter`: its URL contains at least one allowlist substring AND — when the
 * filter names methods — its method is among them (case-insensitive). An empty/absent `methods` list
 * means "any method". An empty `urls` list matches nothing (the allowlist is mandatory).
 */
export function matchesNetworkFilter(
  event: NetworkMatchable,
  filter: NetworkCaptureFilter,
): boolean {
  if (!filter.urls.some((u) => event.url.includes(u))) return false
  if (filter.methods === undefined || filter.methods.length === 0) return true
  const method = event.method.toUpperCase()
  return filter.methods.some((m) => m.toUpperCase() === method)
}

/** Deep-copy a filter so a stored capture cannot be mutated by a later change to the caller's object. */
export function copyNetworkFilter(filter: NetworkCaptureFilter): NetworkCaptureFilter {
  return {
    urls: [...filter.urls],
    ...(filter.methods !== undefined ? { methods: [...filter.methods] } : {}),
  }
}
