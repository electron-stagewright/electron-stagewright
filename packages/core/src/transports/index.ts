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
  ScreenshotOptions,
  InteractionOptions,
  PressOptions,
  ScrollOptions,
  IpcChannel,
  ConsoleStream,
  TransportSession,
  ITransport,
} from './types.js'

export { assertCapability } from './capabilities.js'

export { PlaywrightElectronTransport } from './playwright-electron.js'
export { CDPTransport } from './cdp.js'
export { InjectorTransport } from './injector.js'
