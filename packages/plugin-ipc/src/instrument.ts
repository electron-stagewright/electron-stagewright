/**
 * Main-process IPC instrumentation (ADR-010). The plugin drives the Electron main process through
 * the transport's `evaluate('main', body, arg)` — Playwright invokes our body with the electron
 * module namespace as `electronApp` and our payload as `arg`. {@link INSTRUMENT_BODY} is that body:
 * a single self-contained string (no imports, no closures over module scope — same constraint as
 * the snapshot walker) that dispatches on `arg.op` over a persistent `globalThis.__swIpc` state.
 *
 * It wraps `ipcMain.handle` (and, when capturing send/on, `ipcMain.on`) so each call to an
 * ALLOWLISTED channel is recorded; it re-wraps already-registered handlers best-effort via the
 * internal handler map; it can invoke a registered channel from main; and it can stub a channel's
 * response. Stopping restores every original handler and method.
 *
 * Capture/invoke/stub all run arbitrary main-process JS, so the plugin gates them behind the
 * server's eval opt-in and an explicit channel allowlist (see `index.ts` / ADR-010).
 *
 * @module
 */

/** One captured IPC call. `args` is the channel payload (the renderer's `invoke`/`send` arguments). */
export interface IpcEvent {
  /** The IPC channel name. */
  readonly channel: string
  /** `invoke` for the handle/invoke request-response pattern, `send` for the fire-and-forget on/send pattern. */
  readonly type: 'invoke' | 'send'
  /** The arguments the renderer passed on the channel (after the IpcMainEvent). */
  readonly args: readonly unknown[]
  /** Whether the underlying handler resolved (always true for `send`, which has no result). */
  readonly ok: boolean
  /** Handler duration in ms (0 for `send` and for stubbed responses). */
  readonly ms: number
  /** Epoch-ms when the call was recorded. */
  readonly ts: number
  /** The handler's error message, when `ok` is false. */
  readonly error?: string
}

/**
 * The op an {@link INSTRUMENT_BODY} eval performs against the main-process state:
 * - `install` — set up `__swIpc` + wrap `ipcMain.handle`/`on` for the allowlist.
 * - `read` — return the buffered events.
 * - `stop` — restore the original handlers + methods and clear `__swIpc`.
 * - `invoke` — call a registered handle channel from main and return its result.
 * - `stub` — make an allowlisted channel return a canned response until stop.
 */
export type IpcOp = 'install' | 'read' | 'stop' | 'invoke' | 'stub'

/**
 * The self-contained main-process body run via `transport.evaluate('main', INSTRUMENT_BODY, arg)`.
 * `arg` is `{ op, ... }`; the return shape depends on the op (install → `{ installed, channels }`,
 * read → `{ installed, events }`, stop → `{ stopped, events }`, invoke → `{ ok, result?, error? }`,
 * stub → `{ ok, stubbed?, error? }`). Everything it returns is structured-clone/JSON-safe.
 */
export const INSTRUMENT_BODY = `
const E = electronApp;
const ipcMain = E && E.ipcMain;
const g = globalThis;
const op = arg && arg.op;
if (!ipcMain) return { ok: false, error: 'ipcMain unavailable in this main process' };

if (op === 'install') {
  if (g.__swIpc && g.__swIpc.installed) {
    g.__swIpc.allow = arg.allow.slice();
    g.__swIpc.captureSend = !!arg.captureSend;
    g.__swIpc.events = []; // fresh start: never hand back the previous capture's events
    return { installed: true, channels: g.__swIpc.allow, reinstalled: true };
  }
  const state = {
    installed: true,
    allow: arg.allow.slice(),
    captureSend: !!arg.captureSend,
    maxEvents: arg.maxEvents > 0 ? arg.maxEvents : 1000,
    events: [],
    stubs: {},
    wrappedChannels: [],
    origHandlers: {},
    origHandle: ipcMain.handle.bind(ipcMain),
    origRemoveHandler:
      typeof ipcMain.removeHandler === 'function' ? ipcMain.removeHandler.bind(ipcMain) : null,
    origOn: ipcMain.on.bind(ipcMain),
  };
  const record = (channel, type, args, ok, ms, error) => {
    if (state.events.length >= state.maxEvents) return;
    // Snapshot args at record time: a later app mutation must not rewrite history, and a
    // non-clonable payload is captured as a placeholder rather than breaking the eval round-trip.
    let snap;
    try {
      snap = structuredClone(args);
    } catch (cloneErr) {
      try {
        snap = JSON.parse(JSON.stringify(args));
      } catch (jsonErr) {
        snap = '[unserialisable]';
      }
    }
    const ev = { channel: channel, type: type, args: snap, ok: ok, ms: ms, ts: Date.now() };
    if (error !== undefined) ev.error = error;
    state.events.push(ev);
  };
  const wrapHandle = (channel, origFn) => {
    state.origHandlers[channel] = origFn;
    if (state.wrappedChannels.indexOf(channel) < 0) state.wrappedChannels.push(channel);
    if (state.origRemoveHandler) state.origRemoveHandler(channel);
    state.origHandle(channel, async (event, ...a) => {
      const start = Date.now();
      if (Object.prototype.hasOwnProperty.call(state.stubs, channel)) {
        record(channel, 'invoke', a, true, 0);
        return state.stubs[channel];
      }
      try {
        const r = origFn ? await origFn(event, ...a) : undefined;
        record(channel, 'invoke', a, true, Date.now() - start);
        return r;
      } catch (e) {
        record(channel, 'invoke', a, false, Date.now() - start, String((e && e.message) || e));
        throw e;
      }
    });
  };
  state.wrapHandle = wrapHandle;
  // Future handle registrations: wrap allowlisted channels, pass the rest through.
  ipcMain.handle = function (channel, fn) {
    if (state.allow.indexOf(channel) >= 0) return wrapHandle(channel, fn);
    return state.origHandle(channel, fn);
  };
  // Re-wrap already-registered handlers (best-effort: depends on the internal handler map).
  const internal = ipcMain._invokeHandlers;
  if (internal && typeof internal.get === 'function' && typeof internal.has === 'function') {
    for (const channel of state.allow) {
      if (internal.has(channel)) wrapHandle(channel, internal.get(channel));
    }
  }
  // send/on capture (opt-in): record fire-and-forget messages on allowlisted channels.
  if (state.captureSend) {
    ipcMain.on = function (channel, fn) {
      if (state.allow.indexOf(channel) >= 0) {
        return state.origOn(channel, (event, ...a) => {
          record(channel, 'send', a, true, 0);
          return fn(event, ...a);
        });
      }
      return state.origOn(channel, fn);
    };
  }
  g.__swIpc = state;
  return { installed: true, channels: state.allow };
}

const s = g.__swIpc;

if (op === 'read') {
  return { installed: !!(s && s.installed), events: s ? s.events.slice() : [] };
}

if (op === 'stop') {
  if (!s || !s.installed) return { stopped: false, events: 0 };
  ipcMain.handle = s.origHandle;
  if (s.captureSend) ipcMain.on = s.origOn;
  for (const channel of s.wrappedChannels) {
    if (s.origRemoveHandler) s.origRemoveHandler(channel);
    if (s.origHandlers[channel]) s.origHandle(channel, s.origHandlers[channel]);
  }
  const count = s.events.length;
  delete g.__swIpc;
  return { stopped: true, events: count };
}

if (op === 'stub') {
  if (!s || !s.installed) return { ok: false, error: 'not capturing' };
  if (s.allow.indexOf(arg.channel) < 0) return { ok: false, error: 'channel not allowed' };
  s.stubs[arg.channel] = arg.response;
  // If a handler is already registered but not yet wrapped (it predates the allowlist add), wrap it
  // now so the stub takes effect; future registrations are wrapped by the patched ipcMain.handle.
  const internal = ipcMain._invokeHandlers;
  if (s.wrappedChannels.indexOf(arg.channel) < 0 && internal && typeof internal.get === 'function') {
    if (internal.has(arg.channel) && s.wrapHandle) s.wrapHandle(arg.channel, internal.get(arg.channel));
  }
  return { ok: true, stubbed: arg.channel };
}

if (op === 'invoke') {
  const internal = ipcMain._invokeHandlers;
  const h = internal && typeof internal.get === 'function' ? internal.get(arg.channel) : null;
  if (!h) return { ok: false, error: 'no handler registered for channel ' + arg.channel };
  const fakeEvent = { sender: null, frameId: 0, processId: 0 };
  const args = Array.isArray(arg.args) ? arg.args : [];
  const call = Promise.resolve(h(fakeEvent, ...args));
  // If the timeout wins the race the handler Promise is abandoned; swallow its eventual rejection
  // so it never surfaces as an unhandled rejection in the app's main process.
  call.catch(() => {});
  let timer = null;
  try {
    const result =
      arg.timeoutMs > 0
        ? await Promise.race([
            call,
            new Promise((_, rej) => {
              timer = setTimeout(
                () => rej(new Error('ipc_invoke timed out after ' + arg.timeoutMs + 'ms')),
                arg.timeoutMs,
              );
            }),
          ])
        : await call;
    if (timer) clearTimeout(timer);
    return { ok: true, result: result };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

return { ok: false, error: 'unknown ipc op: ' + String(op) };
`

/** Keep only events on `channel` (all events when `channel` is undefined). */
export function filterEvents(events: readonly IpcEvent[], channel?: string): IpcEvent[] {
  if (channel === undefined) return [...events]
  return events.filter((e) => e.channel === channel)
}

/** Recursively replace any property whose key is in `keys` with `'[redacted]'`. */
function redactValue(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, keys))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      out[key] = keys.has(key) ? '[redacted]' : redactValue(val, keys)
    }
    return out
  }
  return value
}

/**
 * Redact named argument fields from captured events before they reach the agent (privacy parity
 * with the trace plugin). Returns the events unchanged when `redactKeys` is empty.
 */
export function redactEvents(
  events: readonly IpcEvent[],
  redactKeys: readonly string[],
): IpcEvent[] {
  if (redactKeys.length === 0) return [...events]
  const keys = new Set(redactKeys)
  return events.map((e) => ({ ...e, args: e.args.map((a) => redactValue(a, keys)) }))
}
