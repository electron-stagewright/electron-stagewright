import { serveHost } from '../../../dist/index.js'

serveHost({
  operations: ['echo', 'pid', 'slow', 'crash'],
  start: ({ greeting }) => ({
    echo: (value) => `${greeting} ${value}`,
    pid: () => process.pid,
    slow: (ms) => new Promise((resolve) => setTimeout(() => resolve('done'), ms)),
    crash: () =>
      new Promise(() => {
        setImmediate(() => {
          throw Object.assign(new Error('native state lost'), { code: 'TEST_CRASH' })
        })
      }),
  }),
})
