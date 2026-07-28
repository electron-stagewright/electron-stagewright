import { SourceUnavailableError } from './errors.js'

export interface JsonRequestOptions {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly source: 'npm' | 'github'
}

function reasonForResponse(response: Response): SourceUnavailableError {
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.has('retry-after')))
  ) {
    return new SourceUnavailableError('rate_limited')
  }
  if (response.status === 401 || response.status === 403) {
    return new SourceUnavailableError('permission_denied')
  }
  return new SourceUnavailableError('http_error')
}

/** Fetch JSON without retaining response text or propagating upstream error messages. */
export async function requestJson(
  url: string,
  init: RequestInit,
  options: JsonRequestOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  let response: Response
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new SourceUnavailableError('timeout')
    }
    throw new SourceUnavailableError('source_error')
  }

  if (!response.ok) throw reasonForResponse(response)

  try {
    return await response.json()
  } catch {
    throw new SourceUnavailableError('invalid_response')
  }
}
