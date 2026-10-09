/** Release host-side wait timers and abort listeners as soon as their request ends. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const cancel = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
