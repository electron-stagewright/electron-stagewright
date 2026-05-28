/**
 * InjectorTransport — Node Inspector injection into a running Electron process.
 * Stub implementation.
 *
 * The primary purpose is the "attach without restart" workflow: agents driving
 * a dev server should not have to relaunch the app to start a tool session.
 * The technique uses `process._debugProcess(pid)` to enable the inspector on a
 * running process; the platform matrix is non-trivial (Linux and macOS work
 * reliably, Windows needs a fallback path via port discovery via `lsof`/`ss`
 * equivalents). This stub declares the contract and surface without attempting
 * the inspector handshake.
 *
 * Capability matrix:
 *
 * - `canLaunch: false` — Injector hooks an existing process; it does not spawn.
 * - `canAttach: true` — once the inspector handshake completes the session
 *   behaves like an attached CDP session.
 * - `canInject: true` — the primary purpose.
 * - `canIntercept: false` — interception lives on the CDP transport.
 * - `canControlClock: false` — clock control lives on the CDP transport.
 * - `supportsMainEval: true` — Node Inspector exposes Runtime.evaluate.
 * - `supportsRendererEval: false` — renderer access requires the CDP browser
 *   endpoint, which Injector doesn't surface on its own.
 *
 * @module
 */

import { StagewrightError } from '../errors/registry.js'
import type {
  AttachOptions,
  InjectOptions,
  ITransport,
  LaunchOptions,
  StopOptions,
  TransportCapabilities,
  TransportId,
  TransportSession,
} from './types.js'

const TRANSPORT_ID: TransportId = 'injector'

function unsupported(method: string, capability: keyof TransportCapabilities): StagewrightError {
  return new StagewrightError(
    'TRANSPORT_UNSUPPORTED',
    `InjectorTransport does not support ${method}.`,
    { transport: TRANSPORT_ID, method, capability },
  )
}

function notImplemented(method: string): StagewrightError {
  return new StagewrightError(
    'NOT_IMPLEMENTED',
    `InjectorTransport.${method} is not implemented yet; this transport has no implementation for it.`,
    { transport: TRANSPORT_ID, method },
  )
}

export class InjectorTransport implements ITransport {
  public readonly id: TransportId = TRANSPORT_ID
  public readonly capabilities: TransportCapabilities = {
    canLaunch: false,
    canAttach: true,
    canInject: true,
    canIntercept: false,
    canControlClock: false,
    supportsMainEval: true,
    supportsRendererEval: false,
  }

  launch(_opts: LaunchOptions): Promise<TransportSession> {
    return Promise.reject(unsupported('launch', 'canLaunch'))
  }

  attach(_opts: AttachOptions): Promise<TransportSession> {
    return Promise.reject(notImplemented('attach'))
  }

  inject(_opts: InjectOptions): Promise<TransportSession> {
    return Promise.reject(notImplemented('inject'))
  }

  stop(_session: TransportSession, _opts?: StopOptions): Promise<void> {
    return Promise.reject(notImplemented('stop'))
  }

  forceKill(_session: TransportSession): Promise<void> {
    return Promise.reject(notImplemented('forceKill'))
  }
}
