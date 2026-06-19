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
    ...(filter.captureBodies !== undefined ? { captureBodies: filter.captureBodies } : {}),
    ...(filter.maxBodyBytes !== undefined ? { maxBodyBytes: filter.maxBodyBytes } : {}),
    ...(filter.bodyContentTypes !== undefined
      ? { bodyContentTypes: [...filter.bodyContentTypes] }
      : {}),
  }
}

/** Default per-body exposure cap (64 KiB) when a capture opts into bodies without naming `maxBodyBytes`. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

/**
 * Default content-type substrings whose bodies are decoded as text. Substring (not exact) so a
 * charset-suffixed header (`application/json; charset=utf-8`) and `+json`/`+xml` media types match.
 * `json` covers application/json and vendor/problem +json types; `text/` covers html / plain / css;
 * `xml` covers application/xml and svg; `javascript` both spellings.
 */
export const DEFAULT_BODY_CONTENT_TYPES: readonly string[] = [
  'json',
  'text/',
  'xml',
  'x-www-form-urlencoded',
  'javascript',
]

/** Case-insensitive header lookup (Playwright lower-cases header names, but callers may not). */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

/**
 * Whether a payload with `contentType` is eligible for body capture: its content-type CONTAINS one of
 * `allowlist` (case-insensitive). An absent/empty content-type is ineligible — we never decode an
 * unknown payload as text. This gate keeps binary bodies (images, archives) out of the capture.
 */
export function bodyContentTypeAllowed(
  contentType: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (contentType === undefined || contentType === '') return false
  const lower = contentType.toLowerCase()
  return allowlist.some((entry) => lower.includes(entry.toLowerCase()))
}

/** A captured body decoded for a {@link NetworkEvent}: the (capped) text plus its true byte length. */
export interface CapturedBody {
  /** Decoded UTF-8 body text (capped, with an inline truncation marker); absent in `'size'` mode. */
  readonly body?: string
  /** True (pre-truncation) byte length of the body. */
  readonly bytes: number
  /** Whether the body text was cut to `maxBytes`. */
  readonly truncated: boolean
}

/**
 * Decode `buf` into a {@link CapturedBody} honouring the capture mode. `'size'` reports only the byte
 * length (no text). Otherwise the body is decoded UTF-8 and truncated to `maxBytes` BYTES, with an
 * inline `…[+N bytes truncated]` marker and `truncated: true` when it was cut; `bytes` is always the
 * true pre-truncation length. Measuring/slicing by bytes (not string length) keeps the cap honest for
 * multibyte UTF-8 (a slice at the boundary may yield a trailing replacement char — acceptable in a
 * truncated preview).
 */
export function captureBodyField(
  buf: Buffer,
  mode: boolean | 'size',
  maxBytes: number,
): CapturedBody {
  const bytes = buf.length
  if (mode === 'size') return { bytes, truncated: false }
  const truncated = bytes > maxBytes
  const slice = truncated ? buf.subarray(0, maxBytes) : buf
  const text = truncated
    ? `${slice.toString('utf8')}…[+${bytes - maxBytes} bytes truncated]`
    : slice.toString('utf8')
  return { body: text, bytes, truncated }
}

/** The resolved body-capture knobs for an armed filter, or `null` when bodies are not being captured. */
export interface BodyCapturePlan {
  /** `true` decodes the body text; `'size'` records only the byte length. */
  readonly mode: boolean | 'size'
  /** Per-body byte cap (the filter's `maxBodyBytes`, or {@link DEFAULT_MAX_BODY_BYTES}). */
  readonly maxBytes: number
  /** Content-type substrings whose bodies are eligible (the filter's override or the default set). */
  readonly contentTypes: readonly string[]
}

/**
 * Resolve a filter's body-capture plan (applying the transport defaults), or `null` when bodies are
 * off. Transport-neutral — shared by the Playwright and CDP transports so the opt-in, the cap, and the
 * content-type allowlist resolve identically on both.
 */
export function bodyCapturePlan(filter: NetworkCaptureFilter): BodyCapturePlan | null {
  const mode = filter.captureBodies
  if (mode === undefined || mode === false) return null
  return {
    mode,
    maxBytes: filter.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    contentTypes: filter.bodyContentTypes ?? DEFAULT_BODY_CONTENT_TYPES,
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
