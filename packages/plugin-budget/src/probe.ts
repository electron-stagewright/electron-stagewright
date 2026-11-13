/**
 * Bodies the plugin evaluates inside the app through the transport's `evaluate` seam. Each is a
 * self-contained string: no imports, no closures, JSON-safe results.
 *
 * @module
 */

import type { StallSummary } from './run.js'

/** Timer lateness below this is scheduler jitter, not a blocked main thread. */
export const MIN_STALL_MS = 10
export const SAMPLE_INTERVAL_MS = 10
export const DEFAULT_IPC_INTERVAL_MS = 25
export const DEFAULT_WINDOW_MS = 2_000

export interface MainFacts {
  readonly pid: number
  /** Epoch ms the main process was created, when Electron exposes it. */
  readonly creationTime: number | null
  readonly electron: string | null
  readonly platform: string
  readonly processes: readonly {
    readonly pid: number
    readonly type: string
    readonly name: string | null
    readonly workingSetKb: number
    readonly privateKb: number | null
  }[]
}

export type MainOp = 'facts' | 'start' | 'read'

/**
 * Main-process body. `facts` reads process metrics. `start` arms a 10 ms timer whose lateness is
 * the blocked time (replacing any earlier window); `read` summarises it and, with `stop`, clears it.
 */
export const MAIN_BODY = `
const KEY = '__swBudget';
const round = (value) => Math.round(value * 10) / 10;
if (arg.op === 'facts') {
  return {
    pid: process.pid,
    creationTime: typeof process.getCreationTime === 'function' ? process.getCreationTime() : null,
    electron: process.versions.electron || null,
    platform: process.platform,
    processes: electronApp.app.getAppMetrics().map((entry) => ({
      pid: entry.pid,
      type: entry.type,
      name: entry.name || entry.serviceName || null,
      workingSetKb: entry.memory.workingSetSize,
      privateKb: typeof entry.memory.privateBytes === 'number' ? entry.memory.privateBytes : null,
    })),
  };
}
if (arg.op === 'start') {
  const previous = globalThis[KEY];
  if (previous) clearInterval(previous.handle);
  const state = { startedAt: performance.now(), last: performance.now(), stalls: [], handle: null };
  state.handle = setInterval(() => {
    const at = performance.now();
    const stall = at - state.last - ${SAMPLE_INTERVAL_MS};
    if (stall >= ${MIN_STALL_MS}) state.stalls.push(stall);
    state.last = at;
  }, ${SAMPLE_INTERVAL_MS});
  if (typeof state.handle.unref === 'function') state.handle.unref();
  globalThis[KEY] = state;
  return { started: true };
}
if (arg.op === 'read') {
  const state = globalThis[KEY];
  if (!state) return null;
  const at = performance.now();
  const stalls = state.stalls.slice();
  const tail = at - state.last - ${SAMPLE_INTERVAL_MS};
  if (tail >= ${MIN_STALL_MS}) stalls.push(tail);
  if (arg.stop) {
    clearInterval(state.handle);
    delete globalThis[KEY];
  }
  const windowMs = Math.max(at - state.startedAt, 1);
  const blockedMs = stalls.reduce((sum, stall) => sum + stall, 0);
  return {
    windowMs: round(windowMs),
    blockedMs: round(blockedMs),
    blockedPercent: round((blockedMs / windowMs) * 100),
    maxStallMs: round(stalls.reduce((max, stall) => Math.max(max, stall), 0)),
    stallsOver50Ms: stalls.filter((stall) => stall > 50).length,
    stallsOver100Ms: stalls.filter((stall) => stall > 100).length,
  };
}
throw new Error('unknown budget op');
`

export type MainReadResult = StallSummary | null

export interface RendererStartup {
  /** Epoch ms of the document's time origin. */
  readonly timeOrigin: number
  /** Ms from the time origin to the end of the load event; 0 while still loading. */
  readonly loadEventEnd: number
  readonly type: string | null
}

/** Renderer body: navigation timing of the active document. */
export const STARTUP_BODY = `
const entry = performance.getEntriesByType('navigation')[0];
return {
  timeOrigin: performance.timeOrigin,
  loadEventEnd: entry ? entry.loadEventEnd : 0,
  type: entry ? entry.type : null,
};
`

const IPC_KEY = '__swBudgetIpc'
const MAX_IPC_SAMPLES = 20_000

/**
 * Renderer body that starts a background loop timing one round trip of `probe` per interval.
 * The expression is inlined, not evaluated at runtime, so a page CSP without `unsafe-eval` holds.
 */
export function buildIpcStartBody(probe: string): string {
  return `
const previous = window['${IPC_KEY}'];
if (previous) previous.stop = true;
const state = { samples: [], errors: 0, lastError: null, stop: false };
window['${IPC_KEY}'] = state;
const once = async () => { await (${probe}); };
const intervalMs = arg.intervalMs;
void (async () => {
  while (!state.stop && state.samples.length < ${MAX_IPC_SAMPLES}) {
    const startedAt = performance.now();
    try {
      await once();
      state.samples.push(performance.now() - startedAt);
    } catch (error) {
      state.errors += 1;
      state.lastError = String(error && error.message ? error.message : error);
      if (state.samples.length === 0 && state.errors >= 20) break;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
})();
return true;
`
}

export interface IpcReadResult {
  readonly samples: readonly number[]
  readonly errors: number
  readonly lastError: string | null
}

/** Renderer body: read the probe samples and, with `stop`, end the loop. Null when none runs. */
export const IPC_READ_BODY = `
const state = window['${IPC_KEY}'];
if (!state) return null;
if (arg.stop) {
  state.stop = true;
  delete window['${IPC_KEY}'];
}
return { samples: state.samples.slice(), errors: state.errors, lastError: state.lastError };
`
