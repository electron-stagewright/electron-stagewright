/**
 * Electron `utilityProcess` transport. The host gets its own process: a native crash ends only the
 * host, at the cost of a slower start and more memory than a worker.
 */

import { createRequire } from 'node:module'

import type { ChannelExit, HostChannel, HostTransport } from './contract.js'
import { minimalEnvironment } from './env.js'

/** The part of Electron's `UtilityProcess` the transport relies on. */
export interface UtilityProcessLike {
  readonly pid?: number | undefined
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'error', listener: (type: string, location: string, report: string) => void): unknown
  kill(): boolean
}

/** The `utilityProcess.fork` options the transport passes through. */
export interface UtilityForkOptions {
  readonly env?: Record<string, string>
  readonly execArgv?: string[]
  readonly cwd?: string
  readonly stdio?: 'pipe' | 'ignore' | 'inherit'
  readonly serviceName?: string
  readonly allowLoadingUnsignedLibraries?: boolean
}

export interface UtilityProcessTransportOptions {
  /** The host entry: a file that calls `serveHost`. */
  readonly entry: string
  readonly args?: readonly string[]
  /** Shown in the OS task manager and in `app.getAppMetrics()`. */
  readonly serviceName?: string
  /** Defaults to `minimalEnvironment(process.env)`, not the whole parent environment. */
  readonly env?: Record<string, string>
  readonly execArgv?: readonly string[]
  readonly cwd?: string
  readonly stdio?: 'pipe' | 'ignore' | 'inherit'
  /** macOS: lets the hardened runtime load unsigned `.node` and `.dylib` files. Avoid in release builds. */
  readonly allowLoadingUnsignedLibraries?: boolean
  /** Replaces `utilityProcess.fork`, for tests. */
  readonly fork?: (entry: string, args: string[], options: UtilityForkOptions) => UtilityProcessLike
}

function electronFork(
  entry: string,
  args: string[],
  options: UtilityForkOptions,
): UtilityProcessLike {
  // Loaded on first launch, so importing this module never needs Electron.
  const electron = createRequire(import.meta.url)('electron') as {
    utilityProcess?: {
      fork(entry: string, args: string[], options: UtilityForkOptions): UtilityProcessLike
    }
  }
  if (!electron.utilityProcess) {
    throw new Error('utilityProcessTransport must run in the Electron main process')
  }
  return electron.utilityProcess.fork(entry, args, options)
}

export function utilityProcessTransport(options: UtilityProcessTransportOptions): HostTransport {
  const fork = options.fork ?? electronFork
  return {
    launch(): HostChannel {
      const child = fork(options.entry, [...(options.args ?? [])], {
        env: options.env ?? minimalEnvironment(process.env),
        ...(options.execArgv ? { execArgv: [...options.execArgv] } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.stdio ? { stdio: options.stdio } : {}),
        ...(options.serviceName ? { serviceName: options.serviceName } : {}),
        ...(options.allowLoadingUnsignedLibraries ? { allowLoadingUnsignedLibraries: true } : {}),
      })
      let error: Error | null = null
      child.on('error', (type, location) => {
        error = new Error(`The host process hit a fatal ${type} at ${location}`)
      })
      return {
        send: (message) => child.postMessage(message),
        onMessage: (listener) => void child.on('message', listener),
        onExit: (listener) =>
          void child.on('exit', (code) => {
            const exit: ChannelExit = error ? { code, error } : { code }
            listener(exit)
          }),
        kill: () => void child.kill(),
      }
    },
  }
}

export { minimalEnvironment } from './env.js'
