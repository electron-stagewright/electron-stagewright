/**
 * The network allowlist matcher — shared by capture (record-time filtering), stubbing
 * (intercept-time filtering), and the in-memory test fake, so the URL/method rule lives in exactly
 * one place.
 *
 * Matching is intentionally simple and transport-neutral: a URL matches when it CONTAINS any
 * allowlist substring, and (when a method filter is present) its method is in that list
 * case-insensitively. Substring rather than glob keeps the semantics predictable across platforms and
 * trivially testable; the deliberate trade-off is that a broad substring can over-match.
 *
 * @module
 */

import type { NetworkCaptureFilter, NetworkStub } from './types.js'

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

/** Deep-copy a stub (incl. the nested fulfill headers) so a stored stub is immune to later mutation. */
export function copyNetworkStub(stub: NetworkStub): NetworkStub {
  return {
    urls: [...stub.urls],
    ...(stub.methods !== undefined ? { methods: [...stub.methods] } : {}),
    ...(stub.fulfill !== undefined
      ? {
          fulfill: {
            ...(stub.fulfill.status !== undefined ? { status: stub.fulfill.status } : {}),
            ...(stub.fulfill.headers !== undefined ? { headers: { ...stub.fulfill.headers } } : {}),
            ...(stub.fulfill.contentType !== undefined
              ? { contentType: stub.fulfill.contentType }
              : {}),
            ...(stub.fulfill.body !== undefined ? { body: stub.fulfill.body } : {}),
          },
        }
      : {}),
    ...(stub.abort !== undefined ? { abort: stub.abort } : {}),
    ...(stub.times !== undefined ? { times: stub.times } : {}),
    ...(stub.delayMs !== undefined ? { delayMs: stub.delayMs } : {}),
  }
}
