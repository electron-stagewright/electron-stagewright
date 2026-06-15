/**
 * Public surface of the server module — the dispatcher, session manager, logger,
 * and the assembly entry point.
 *
 * @module
 */

export { Dispatcher, type DispatcherOptions, type ToolManifestEntry } from './dispatcher.js'

export { anyEvalAllowed, normalizeEvalPolicy, type EvalPolicy } from './eval-policy.js'

export { SessionManager, type ManagedSession } from './session-manager.js'

export { TransportRegistry, type TransportRegistryOptions } from './transport-registry.js'

export { SnapshotStore } from './snapshot-store.js'

export {
  StderrLogger,
  NOOP_LOGGER,
  SLOW_OP_THRESHOLD_MS,
  truncateForLog,
  type Logger,
  type LogLevel,
  type LogFields,
  type StderrLoggerOptions,
} from './logger.js'

export { createServer, type CreateServerOptions, type StagewrightServer } from './server.js'
