import { serveHost } from '../../src/serve.js'
import { TEST_OPERATIONS, TEST_STREAMS, type TestOps } from './test-ops.js'

const retained: unknown[] = []
let aborted = 0

serveHost<TestOps, { greeting: string }>({
  operations: TEST_OPERATIONS,
  streams: TEST_STREAMS,
  statsIntervalMs: 60_000,
  start: ({ greeting }) => ({
    echo: (value: string) => `${greeting} ${value}`,
    slow: (ms: number) => new Promise<string>((resolve) => setTimeout(() => resolve('done'), ms)),
    hang: ({ signal }) =>
      new Promise<string>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted += 1
            resolve('aborted')
          },
          { once: true },
        ),
      ),
    aborted: () => aborted,
    crash: () =>
      new Promise<never>(() => {
        setImmediate(() => {
          throw Object.assign(new Error('native state lost'), { code: 'TEST_CRASH' })
        })
      }),
    exhaustHeap: () => {
      for (;;) retained.push(Array.from({ length: 100_000 }, (_, index) => ({ index })))
    },
    block: (ms: number) => {
      const until = Date.now() + ms
      while (Date.now() < until) continue
      return 'unblocked'
    },
    async *count(limit: number) {
      for (let index = 1; index <= limit; index++) yield index
    },
  }),
})
