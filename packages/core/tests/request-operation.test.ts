import { describe, expect, it, vi } from 'vitest'

import { NOOP_LOGGER } from '../src/server/logger.js'
import { RequestOperation } from '../src/server/request-operation.js'

describe('RequestOperation cancellation cleanup', () => {
  it.each([
    [
      'throws',
      () => {
        throw new Error('sync cleanup failed')
      },
    ],
    ['rejects', () => Promise.reject(new Error('async cleanup failed'))],
  ])('warns and keeps running later cleanups when one %s', async (_label, failing) => {
    const warn = vi.fn()
    const parent = new AbortController()
    const operation = new RequestOperation(parent.signal, 0, { ...NOOP_LOGGER, warn })
    const later = vi.fn()
    operation.onCancel(failing)
    operation.onCancel(later)

    expect(() => parent.abort()).not.toThrow()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(later).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'Cancelled request cleanup failed; transport resources may remain.',
    )
    expect(operation.signal.reason).toMatchObject({ code: 'OPERATION_CANCELLED' })
    operation.close()
  })
})
