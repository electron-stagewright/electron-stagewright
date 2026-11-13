import type { ChannelExit, HostChannel, HostTransport } from '../src/contract.js'
import type { HostMessage, SupervisorMessage } from '../src/protocol.js'

export interface FakeChannel extends HostChannel {
  readonly sent: SupervisorMessage[]
  killed: boolean
  reply(message: HostMessage): void
  exit(exit?: ChannelExit): void
}

export interface FakeTransport extends HostTransport {
  launch(): FakeChannel
  readonly channels: FakeChannel[]
  readonly last: FakeChannel
}

/**
 * A scripted host. By default it answers `start` with `started`, `stop` with `stopped` and an
 * exit, and `kill` with an exit; calls are answered by the test.
 */
export function fakeTransport(
  behavior: {
    autoStart?: boolean
    autoStop?: boolean
    exitOnKill?: boolean
  } = {},
): FakeTransport {
  const channels: FakeChannel[] = []
  return {
    channels,
    get last() {
      const channel = channels.at(-1)
      if (!channel) throw new Error('No host was launched')
      return channel
    },
    launch() {
      let onMessage: ((message: unknown) => void) | null = null
      let onExit: ((exit: ChannelExit) => void) | null = null
      let exited = false
      let exitQueued = false
      const channel: FakeChannel = {
        sent: [],
        killed: false,
        send(message) {
          if (exited) throw new Error('exited')
          channel.sent.push(message)
          if (message.type === 'start' && behavior.autoStart !== false) {
            channel.reply({ type: 'started' })
          }
          if (message.type === 'stop' && behavior.autoStop !== false) {
            channel.reply({ type: 'stopped' })
            channel.exit({ code: 0 })
          }
        },
        onMessage(listener) {
          onMessage = listener
        },
        onExit(listener) {
          onExit = listener
        },
        kill() {
          channel.killed = true
          if (behavior.exitOnKill !== false) channel.exit({ code: null })
        },
        reply(message) {
          queueMicrotask(() => {
            if (!exited) onMessage?.(message)
          })
        },
        // Delivered in order after any reply already queued, as a real port does.
        exit(exit = { code: 1 }) {
          if (exitQueued) return
          exitQueued = true
          queueMicrotask(() => {
            exited = true
            onExit?.(exit)
          })
        },
      }
      channels.push(channel)
      return channel
    },
  }
}

export function calls(channel: FakeChannel): Array<Extract<SupervisorMessage, { type: 'call' }>> {
  return channel.sent.filter(
    (message): message is Extract<SupervisorMessage, { type: 'call' }> => message.type === 'call',
  )
}

/** Lets queued microtasks and timers of zero delay run. */
export function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The error a promise rejects with; throws if it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected a rejection')
}
