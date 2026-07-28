/** Minimal dispatcher contract needed by {@link waitForTestSurfaces}. */
export interface TestToolDispatcher {
  readonly dispatch: (tool: string, args: unknown) => Promise<unknown>
}

/** Renderer surface fields used by real-Electron smoke tests. */
export interface TestSurfaceDescriptor {
  readonly id: string
  readonly kind: string
  readonly parentId?: string
  readonly originRelation?: string
  readonly url?: string
}

/** Successful `electron_surfaces_list` result narrowed for test assertions. */
export interface TestSurfaceListResult {
  readonly ok: true
  readonly surfaces: readonly TestSurfaceDescriptor[]
  readonly active_surface_id?: string
}

/** Polling controls for {@link waitForTestSurfaces}. */
export interface WaitForTestSurfacesOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_INTERVAL_MS = 100

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${String(value)}`)
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function isSurface(value: unknown): value is TestSurfaceDescriptor {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['kind'] !== 'string') {
    return false
  }
  return ['parentId', 'originRelation', 'url'].every(
    (key) => value[key] === undefined || typeof value[key] === 'string',
  )
}

function isSurfaceListResult(value: unknown): value is TestSurfaceListResult {
  return (
    isRecord(value) &&
    value['ok'] === true &&
    Array.isArray(value['surfaces']) &&
    value['surfaces'].every(isSurface) &&
    (value['active_surface_id'] === undefined || typeof value['active_surface_id'] === 'string')
  )
}

function describeSurfaces(surfaces: readonly TestSurfaceDescriptor[]): string {
  if (surfaces.length === 0) return 'none'
  return surfaces.map((surface) => `${surface.kind}:${surface.url ?? '(no URL)'}`).join(', ')
}

/**
 * Poll `electron_surfaces_list` until a real-Electron fixture exposes every surface a test needs.
 *
 * Electron launch readiness covers the initial renderer, but nested frames and guests may attach
 * slightly later on slower hosts. Tests should wait for their semantic surface inventory instead
 * of sleeping for a fixed duration or assuming the first list is complete.
 */
export async function waitForTestSurfaces(
  dispatcher: TestToolDispatcher,
  sessionId: string,
  ready: (result: TestSurfaceListResult) => boolean,
  options: WaitForTestSurfacesOptions = {},
): Promise<TestSurfaceListResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  assertPositiveInteger('timeoutMs', timeoutMs)
  assertPositiveInteger('intervalMs', intervalMs)

  const startedAt = Date.now()
  let latest: TestSurfaceListResult | undefined
  while (true) {
    const result = await dispatcher.dispatch('electron_surfaces_list', { sessionId })
    if (!isSurfaceListResult(result)) {
      const code =
        isRecord(result) && typeof result['code'] === 'string' ? ` (${result['code']})` : ''
      throw new Error(`electron_surfaces_list returned an unsuccessful or malformed result${code}`)
    }
    latest = result
    if (ready(result)) return result

    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)))
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Electron surfaces; observed ${describeSurfaces(
      latest?.surfaces ?? [],
    )}`,
  )
}
