/**
 * `@electron-stagewright/host-supervisor`: one stateful host off the main thread, behind a closed
 * contract. Transports live in the `./worker` and `./utility` subpaths.
 *
 * @module
 */

export type {
  ArgsOf,
  CallContext,
  CallOperation,
  ChannelExit,
  Contract,
  Handlers,
  HostChannel,
  HostTransport,
  StreamOperation,
} from './contract.js'
export { minimalEnvironment } from './env.js'
export { HOST_ERROR_CODES, HostError, isHostError, type HostErrorCode } from './errors.js'
export {
  DEFAULT_RETIRE_WAIT_MS,
  DEFAULT_STOP_GRACE_MS,
  createHost,
  type CallOptions,
  type ExitDecision,
  type Host,
  type HostExit,
  type HostOptions,
  type HostState,
} from './host.js'
export { inProcessTransport } from './in-process.js'
export {
  DEFAULT_RESTART_POLICY,
  memoryWatch,
  restartPolicy,
  type MemoryWatchOptions,
  type RestartPolicyOptions,
} from './policy.js'
export {
  CODE_PATTERN,
  PROTOCOL_VERSION,
  deserializeError,
  serializeError,
  type HostMessage,
  type HostStats,
  type SerializedError,
  type SupervisorMessage,
} from './protocol.js'
export { defaultHostPort, serveHost, type HostPort, type ServeOptions } from './serve.js'
