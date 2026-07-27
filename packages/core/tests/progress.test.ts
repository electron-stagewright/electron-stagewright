/**
 * Unit coverage for request-scoped MCP progress validation and elapsed-heartbeat orchestration.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { NOOP_LOGGER, type Logger } from '../src/server/logger.js'
import {
  MAX_PROGRESS_NOTIFICATIONS,
  createProgressReporter,
  withElapsedProgress,
} from '../src/server/progress.js'
import type { ProgressReporter, ProgressUpdate } from '../src/tools/types.js'

afterEach(() => {
  vi.useRealTimers()
})

function recordingProgress(): {
  readonly reporter: ProgressReporter
  readonly updates: ProgressUpdate[]
} {
  const updates: ProgressUpdate[] = []
  return {
    updates,
    reporter: {
      enabled: true,
      report(update): boolean {
        updates.push(update)
        return true
      },
    },
  }
}

describe('createProgressReporter', () => {
  it('is disabled without a token and preserves numeric token zero', async () => {
    const sent: unknown[] = []
    const sendNotification = async (notification: unknown): Promise<void> => {
      sent.push(notification)
    }

    const disabled = createProgressReporter({
      sendNotification,
      logger: NOOP_LOGGER,
    })
    expect(disabled.enabled).toBe(false)
    expect(disabled.report({ progress: 1 })).toBe(false)

    const zero = createProgressReporter({
      progressToken: 0,
      sendNotification,
      logger: NOOP_LOGGER,
    })
    expect(zero.report({ progress: 1, total: 2 })).toBe(true)
    await Promise.resolve()
    expect(sent).toEqual([
      {
        method: 'notifications/progress',
        params: { progressToken: 0, progress: 1, total: 2 },
      },
    ])
  })

  it('accepts only finite, non-negative, strictly increasing, bounded updates', async () => {
    const sent: unknown[] = []
    const reporter = createProgressReporter({
      progressToken: 'request',
      sendNotification: async (notification) => {
        sent.push(notification)
      },
      logger: NOOP_LOGGER,
    })

    expect(reporter.report({ progress: Number.NaN })).toBe(false)
    expect(reporter.report({ progress: -1 })).toBe(false)
    expect(reporter.report({ progress: 1, total: 4 })).toBe(true)
    expect(reporter.report({ progress: 1, total: 4 })).toBe(false)
    expect(reporter.report({ progress: 0.5, total: 4 })).toBe(false)
    expect(reporter.report({ progress: 2, total: Number.POSITIVE_INFINITY })).toBe(false)
    expect(reporter.report({ progress: 5, total: 4 })).toBe(false)
    expect(reporter.report({ progress: 4, total: 4 })).toBe(true)

    await Promise.resolve()
    expect(sent).toHaveLength(2)
  })

  it('enforces one notification cap across the reporter lifetime', async () => {
    const sent: unknown[] = []
    const reporter = createProgressReporter({
      progressToken: 'bounded',
      sendNotification: async (notification) => {
        sent.push(notification)
      },
      logger: NOOP_LOGGER,
    })

    const accepted = Array.from({ length: MAX_PROGRESS_NOTIFICATIONS + 2 }, (_, index) =>
      reporter.report({ progress: index + 1 }),
    )
    await Promise.resolve()

    expect(accepted.filter(Boolean)).toHaveLength(MAX_PROGRESS_NOTIFICATIONS)
    expect(sent).toHaveLength(MAX_PROGRESS_NOTIFICATIONS)
    expect(reporter.enabled).toBe(false)
  })

  it('stops accepting updates when the request aborts', () => {
    const controller = new AbortController()
    const reporter = createProgressReporter({
      progressToken: 'abortable',
      sendNotification: async () => undefined,
      signal: controller.signal,
      logger: NOOP_LOGGER,
    })

    expect(reporter.report({ progress: 1 })).toBe(true)
    controller.abort()
    expect(reporter.enabled).toBe(false)
    expect(reporter.report({ progress: 2 })).toBe(false)
  })

  it('swallows rejected notification delivery without an unhandled rejection', async () => {
    const debug = vi.fn<Logger['debug']>()
    const logger: Logger = {
      debug,
      info() {},
      warn() {},
      error() {},
    }
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const reporter = createProgressReporter({
        progressToken: 'closed-transport',
        sendNotification: () => Promise.reject(new Error('transport closed')),
        logger,
      })

      expect(reporter.report({ progress: 1 })).toBe(true)
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(unhandled).toEqual([])
      expect(debug).toHaveBeenCalledWith('Progress notification failed; ignored', {
        error: 'transport closed',
      })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('remains no-throw when both delivery and diagnostic logging fail', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const reporter = createProgressReporter({
        progressToken: 'fully-closed',
        sendNotification: () => Promise.reject(new Error('transport closed')),
        logger: {
          debug() {
            throw new Error('logger closed')
          },
          info() {},
          warn() {},
          error() {},
        },
      })

      expect(() => reporter.report({ progress: 1 })).not.toThrow()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('withElapsedProgress', () => {
  it('emits elapsed bounded heartbeats and stops after work settles', async () => {
    vi.useFakeTimers()
    let clock = 0
    let finish!: () => void
    const work = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { reporter, updates } = recordingProgress()
    const pending = withElapsedProgress(
      {
        reporter,
        totalMs: 1000,
        message: 'Waiting for condition',
        now: () => clock,
      },
      () => work,
    )

    clock = 250
    await vi.advanceTimersByTimeAsync(250)
    clock = 900
    await vi.advanceTimersByTimeAsync(250)
    expect(updates).toEqual([
      { progress: 250, total: 1000, message: 'Waiting for condition' },
      { progress: 900, total: 1000, message: 'Waiting for condition' },
    ])

    finish()
    await pending
    clock = 1000
    await vi.advanceTimersByTimeAsync(1000)
    expect(updates).toHaveLength(2)
  })

  it('keeps zero-duration and quick operations silent', async () => {
    vi.useFakeTimers()
    const zero = recordingProgress()
    await withElapsedProgress(
      { reporter: zero.reporter, totalMs: 0, message: 'Checking expectation' },
      async () => undefined,
    )

    const quick = recordingProgress()
    const pending = withElapsedProgress(
      { reporter: quick.reporter, totalMs: 1000, message: 'Checking expectation' },
      async () => 'ok',
    )
    await expect(pending).resolves.toBe('ok')
    await vi.advanceTimersByTimeAsync(1000)

    expect(zero.updates).toEqual([])
    expect(quick.updates).toEqual([])
  })

  it('clears its heartbeat timer when a managed reporter closes before hung work settles', () => {
    vi.useFakeTimers()
    const reporter = createProgressReporter({
      progressToken: 'timed-out-request',
      sendNotification: async () => undefined,
      logger: NOOP_LOGGER,
    })
    const pending = withElapsedProgress(
      {
        reporter,
        totalMs: 60_000,
        message: 'Waiting for condition',
      },
      () => new Promise<never>(() => undefined),
    )

    expect(vi.getTimerCount()).toBe(1)
    reporter.close()
    expect(vi.getTimerCount()).toBe(0)
    void pending
  })
})
