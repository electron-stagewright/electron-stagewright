import type { ChannelExit, Contract, HostChannel, HostTransport } from './contract.js'
import type { HostMessage, SupervisorMessage } from './protocol.js'
import { serveHost, type ServeOptions } from './serve.js'

/**
 * Runs the host in the caller's thread. Messages are cloned and delivered asynchronously, as they
 * would be across a real boundary. Meant for tests: a crash here is the caller's crash.
 */
export function inProcessTransport<Ops extends Contract<Ops>, Payload = undefined>(
  serve: Omit<ServeOptions<Ops, Payload>, 'port' | 'reportCrashes'>,
): HostTransport {
  return {
    launch(): HostChannel {
      let alive = true
      let toHost: ((message: unknown) => void) | null = null
      let toSupervisor: ((message: unknown) => void) | null = null
      let exitListener: ((exit: ChannelExit) => void) | null = null
      const end = (exit: ChannelExit) => {
        if (!alive) return
        alive = false
        queueMicrotask(() => exitListener?.(exit))
      }
      const deliver = (listener: ((message: unknown) => void) | null, message: unknown) => {
        const copy = structuredClone(message)
        queueMicrotask(() => {
          if (alive) listener?.(copy)
        })
      }
      serveHost<Ops, Payload>({
        ...serve,
        reportCrashes: false,
        port: {
          post: (message: HostMessage) => {
            if (alive) deliver(toSupervisor, message)
          },
          onMessage: (listener) => {
            toHost = listener
          },
          close: () => {
            // Let the stop reply arrive before the exit, as a real port does.
            queueMicrotask(() => end({ code: 0 }))
          },
        },
      })
      return {
        send: (message: SupervisorMessage) => {
          if (!alive) throw new Error('The host has exited')
          deliver(toHost, message)
        },
        onMessage: (listener) => {
          toSupervisor = listener
        },
        onExit: (listener) => {
          exitListener = listener
        },
        kill: () => end({ code: 1 }),
      }
    },
  }
}
