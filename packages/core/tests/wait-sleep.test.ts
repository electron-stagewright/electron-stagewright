import { afterEach, describe, expect, it, vi } from 'vitest'

import { StagewrightError } from '../src/errors/registry.js'
import { sleep } from '../src/tools/wait/sleep.js'

afterEach(() => vi.useRealTimers())

describe('host-side sleep', () => {
  it('releases its timer and abort listener on ordinary completion', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = sleep(10, controller.signal)
    await vi.advanceTimersByTimeAsync(10)
    await pending
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
  })

  it('rejects with the original timeout reason and clears its timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = new StagewrightError('OPERATION_TIMEOUT', 'Expired')
    const pending = sleep(60_000, controller.signal)
    const assertion = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not allocate a timer when already cancelled', () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    expect(() => sleep(60_000, controller.signal)).toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('supports direct callers without a request signal', async () => {
    vi.useFakeTimers()
    const pending = sleep(0)
    await vi.runAllTimersAsync()
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })
})
