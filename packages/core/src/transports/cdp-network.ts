/**
 * Pure correlation + translation helpers for the CDP transport's network seam (ADR-016). The CDP
 * Network domain reports a request across several events — `requestWillBeSent` (start, with the request
 * body), `responseReceived` (status + headers), and a terminal `loadingFinished` / `loadingFailed` —
 * so building one {@link NetworkEvent} per request means accumulating those into an in-flight record
 * and emitting at the terminal event. This module owns that state machine and the Playwright-name →
 * CDP-`errorReason` abort mapping; the transport (`cdp.ts`) owns the connection, the async body reads,
 * and the buffer. Keeping the correlation pure makes it unit-testable without a socket.
 *
 * @module
 */

import { matchesNetworkFilter } from './network-filter.js'
import type { NetworkCaptureFilter, NetworkEvent } from './types.js'

/** The `Network.requestWillBeSent` param slice we read. CDP timestamps are monotonic seconds. */
export interface CdpRequestWillBeSent {
  readonly requestId: string
  readonly request: {
    readonly url: string
    readonly method: string
    readonly headers?: Record<string, string>
    readonly postData?: string
    readonly hasPostData?: boolean
  }
  /** Resource type (`Document`, `XHR`, `Fetch`, …); CamelCase in CDP. */
  readonly type?: string
  /** Present when this event reports a redirect reusing the same `requestId` (fold A). */
  readonly redirectResponse?: CdpResponse
  /** Monotonic seconds when the request started. */
  readonly timestamp?: number
}

/** The `Network.responseReceived` / `redirectResponse` param slice we read. */
export interface CdpResponse {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly mimeType?: string
}

/** The `Network.responseReceived` param slice. */
export interface CdpResponseReceived {
  readonly requestId: string
  readonly response: CdpResponse
  readonly type?: string
}

/** The `Network.responseReceivedExtraInfo` param slice — raw (wire) response headers (fold E). */
export interface CdpResponseExtraInfo {
  readonly requestId: string
  readonly headers?: Record<string, string>
}

/** The `Network.loadingFinished` param slice. */
export interface CdpLoadingFinished {
  readonly requestId: string
  readonly timestamp?: number
}

/** The `Network.loadingFailed` param slice. */
export interface CdpLoadingFailed {
  readonly requestId: string
  readonly errorText?: string
  readonly timestamp?: number
}

/** The `Fetch.requestPaused` param slice we read (request stage). */
export interface CdpRequestPaused {
  readonly requestId: string
  readonly request: {
    readonly url: string
    readonly method: string
    readonly headers?: Record<string, string>
    readonly postData?: string
  }
}

/**
 * One request being accumulated across its CDP events, keyed in the transport by target id + request id.
 * Mutable: `applyResponse` fills the response fields once `responseReceived` arrives. The body field
 * objects are built by the transport (which has the connection to read bodies) and merged at terminal.
 */
export interface InflightRequest {
  readonly windowId: string
  readonly method: string
  readonly url: string
  readonly resourceType?: string
  readonly requestHeaders?: Record<string, string>
  readonly requestPostData?: string
  readonly requestHasPostData: boolean
  /** Monotonic seconds when the request started, for the duration calc. */
  readonly startTime?: number
  status?: number
  responseHeaders?: Record<string, string>
  responseContentType?: string
}

/** Lower-case the CamelCase CDP resource type for parity with the Playwright transport's field. */
export function cdpResourceType(type?: string): string | undefined {
  return type === undefined || type === '' ? undefined : type.toLowerCase()
}

/**
 * Start accumulating a request if it passes the armed filter; returns `null` when the URL/method do
 * not match (so the transport never tracks an unmatched request). Reads only the request half — the
 * response is attached later by {@link applyResponse}.
 */
export function startInflight(
  windowId: string,
  params: CdpRequestWillBeSent,
  filter: NetworkCaptureFilter,
): InflightRequest | null {
  const method = params.request.method
  const url = params.request.url
  if (!matchesNetworkFilter({ method, url }, filter)) return null
  const resourceType = cdpResourceType(params.type)
  return {
    windowId,
    method,
    url,
    ...(resourceType !== undefined ? { resourceType } : {}),
    ...(params.request.headers !== undefined ? { requestHeaders: params.request.headers } : {}),
    ...(params.request.postData !== undefined ? { requestPostData: params.request.postData } : {}),
    requestHasPostData:
      params.request.hasPostData === true || params.request.postData !== undefined,
    ...(params.timestamp !== undefined ? { startTime: params.timestamp } : {}),
  }
}

/** Attach the response status, headers, and content-type to an in-flight record (mutates it). */
export function applyResponse(inflight: InflightRequest, response: CdpResponse): void {
  if (response.status !== undefined) inflight.status = response.status
  const priorHeaders = inflight.responseHeaders
  if (response.headers !== undefined) {
    // responseReceivedExtraInfo can arrive before responseReceived. Keep those raw wire headers as the
    // winner on duplicates while still filling in any headers that only responseReceived reported.
    inflight.responseHeaders = { ...response.headers, ...(priorHeaders ?? {}) }
  }
  const contentType =
    headerOf(priorHeaders, 'content-type') ??
    headerOf(response.headers, 'content-type') ??
    response.mimeType
  if (contentType !== undefined) inflight.responseContentType = contentType
}

/** Merge the raw `responseReceivedExtraInfo` headers over what `responseReceived` reported (fold E). */
export function mergeExtraInfoHeaders(
  inflight: InflightRequest,
  extra: CdpResponseExtraInfo,
): void {
  if (extra.headers === undefined) return
  inflight.responseHeaders = { ...(inflight.responseHeaders ?? {}), ...extra.headers }
  const contentType = headerOf(extra.headers, 'content-type')
  if (contentType !== undefined) inflight.responseContentType = contentType
}

/** Body field objects (built by the transport from the decoded bytes) merged into the final event. */
export interface BodyFields {
  readonly request?:
    | Pick<NetworkEvent, 'requestBody' | 'requestBodyBytes' | 'requestBodyTruncated'>
    | undefined
  readonly response?:
    | Pick<NetworkEvent, 'responseBody' | 'responseBodyBytes' | 'responseBodyTruncated'>
    | undefined
}

/** Duration in ms between two monotonic-second CDP timestamps, or undefined when not measurable. */
function durationMs(start?: number, end?: number): number | undefined {
  if (start === undefined || end === undefined) return undefined
  const ms = (end - start) * 1000
  return ms >= 0 ? Math.round(ms) : undefined
}

/** Assemble the terminal {@link NetworkEvent} for a finished request. */
export function buildFinishedEvent(
  inflight: InflightRequest,
  finished: CdpLoadingFinished,
  bodies: BodyFields,
  now: number,
): NetworkEvent {
  const ms = durationMs(inflight.startTime, finished.timestamp)
  return {
    method: inflight.method,
    url: inflight.url,
    ...(inflight.resourceType !== undefined ? { resourceType: inflight.resourceType } : {}),
    ...(inflight.status !== undefined
      ? { status: inflight.status, ok: inflight.status >= 200 && inflight.status < 300 }
      : {}),
    ...(inflight.requestHeaders !== undefined ? { requestHeaders: inflight.requestHeaders } : {}),
    ...(bodies.request ?? {}),
    ...(inflight.responseHeaders !== undefined
      ? { responseHeaders: inflight.responseHeaders }
      : {}),
    ...(bodies.response ?? {}),
    ...(ms !== undefined ? { durationMs: ms } : {}),
    timestamp: now,
    windowId: inflight.windowId,
  }
}

/** Assemble the terminal {@link NetworkEvent} for a failed request (no response body). */
export function buildFailedEvent(
  inflight: InflightRequest,
  failed: CdpLoadingFailed,
  requestBody: BodyFields['request'],
  now: number,
): NetworkEvent {
  const ms = durationMs(inflight.startTime, failed.timestamp)
  return {
    method: inflight.method,
    url: inflight.url,
    ...(inflight.resourceType !== undefined ? { resourceType: inflight.resourceType } : {}),
    ...(inflight.requestHeaders !== undefined ? { requestHeaders: inflight.requestHeaders } : {}),
    ...(requestBody ?? {}),
    failure:
      failed.errorText !== undefined && failed.errorText !== ''
        ? failed.errorText
        : 'request failed',
    ...(ms !== undefined ? { durationMs: ms } : {}),
    timestamp: now,
    windowId: inflight.windowId,
  }
}

/**
 * Build a terminal event for a redirect hop (fold A): CDP re-fires `requestWillBeSent` with the same
 * `requestId` carrying the previous hop's `redirectResponse`, so the original hop would otherwise be
 * overwritten. We record it as its own completed event using that response's status/headers.
 */
export function buildRedirectEvent(
  inflight: InflightRequest,
  redirect: CdpResponse,
  now: number,
): NetworkEvent {
  const status = redirect.status
  return {
    method: inflight.method,
    url: inflight.url,
    ...(inflight.resourceType !== undefined ? { resourceType: inflight.resourceType } : {}),
    ...(status !== undefined ? { status, ok: status >= 200 && status < 300 } : {}),
    ...(inflight.requestHeaders !== undefined ? { requestHeaders: inflight.requestHeaders } : {}),
    ...(redirect.headers !== undefined ? { responseHeaders: redirect.headers } : {}),
    timestamp: now,
    windowId: inflight.windowId,
  }
}

/** Case-insensitive header lookup over a possibly-undefined CDP header map. */
function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

/**
 * Map a Playwright-flavoured {@link NetworkStub.abort} reason (the plugin's vocabulary) to the CDP
 * `Fetch.failRequest` `errorReason` enum (fold C). An unknown reason falls back to `Failed` so an abort
 * can never make `Fetch.failRequest` throw.
 */
export function mapAbortReason(reason: string): string {
  return ABORT_REASON_TO_CDP[reason.toLowerCase()] ?? 'Failed'
}

const ABORT_REASON_TO_CDP: Record<string, string> = {
  aborted: 'Aborted',
  accessdenied: 'AccessDenied',
  addressunreachable: 'AddressUnreachable',
  blockedbyclient: 'BlockedByClient',
  blockedbyresponse: 'BlockedByResponse',
  connectionaborted: 'ConnectionAborted',
  connectionclosed: 'ConnectionClosed',
  connectionfailed: 'ConnectionFailed',
  connectionrefused: 'ConnectionRefused',
  connectionreset: 'ConnectionReset',
  internetdisconnected: 'InternetDisconnected',
  namenotresolved: 'NameNotResolved',
  timedout: 'TimedOut',
  failed: 'Failed',
}
