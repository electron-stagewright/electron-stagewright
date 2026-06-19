/**
 * Public surface of the transports module.
 *
 * @module
 */

export type {
  TransportId,
  SessionId,
  TransportCapabilities,
  WindowRef,
  WindowDescriptor,
  LaunchOptions,
  AttachOptions,
  InjectOptions,
  StopOptions,
  StopResult,
  ScreenshotOptions,
  InteractionOptions,
  ClickOptions,
  PressOptions,
  ScrollOptions,
  IpcChannel,
  ConsoleStream,
  ConsoleEntry,
  ConsoleLogsResult,
  DialogAction,
  DialogType,
  DialogPolicy,
  DialogEvent,
  DialogEventsOptions,
  DialogEventsResult,
  NetworkCaptureFilter,
  NetworkAbortReason,
  NetworkEvent,
  NetworkEventsOptions,
  NetworkEventsResult,
  NetworkStub,
  NetworkStubResponse,
  ClockTime,
  ClockInstallOptions,
  TransportSession,
  ITransport,
} from './types.js'

export { assertCapability } from './capabilities.js'

export { PlaywrightElectronTransport } from './playwright-electron.js'
export { CDPTransport } from './cdp.js'
export { InjectorTransport } from './injector.js'
