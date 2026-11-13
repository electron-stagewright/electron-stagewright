# @electron-stagewright/host-supervisor

Runs one stateful host (a database, a native engine, an embedded server) off the Electron main
thread, behind a closed list of operations, and supervises its life: lazy start, drain on stop,
per-call timeout and `AbortSignal`, a limit on pending calls, waiting for a killed host to exit
before the next one starts, and a choice between fatal and bounded restart when it dies.

## Worker thread or utility process

Choose this first. A native crash (a segfault or abort in a `.node` addon) in a worker thread ends
the **whole app**; in a `utilityProcess` it ends only the host.

|                                   | `worker_threads` (`./worker`) | `utilityProcess` (`./utility`)        |
| --------------------------------- | ----------------------------- | ------------------------------------- |
| Native crash in the host          | Ends the app                  | Ends the host; the supervisor decides |
| JavaScript exception, heap limit  | Ends the host                 | Ends the host                         |
| Start to first answer             | 19 ms                         | 59 ms                                 |
| Call round trip                   | 24 µs                         | 37 µs                                 |
| Memory                            | Counted in the main process   | Its own process, 67 MB working set    |
| Runs without Electron (tests, CI) | Yes                           | No                                    |

Start, round trip and memory: medians of 7 rounds on one Apple M4 Max, Electron 42.11.10, with a
host that loads nothing. They are indicative only. In one app that moved an embedded server off the
main thread, the worker added about 21 MB and left 0.7 % of the main thread blocked under load;
a utility process added 46 MB and 3.6 %.

Use a worker when the host runs JavaScript or native code you trust not to crash. Use a utility
process when it loads a native engine (DuckDB, a driver, a codec) whose crash must not take the
window with it.

## Use

The contract is an interface shared by both sides:

```ts
export interface DbOps {
  query(sql: string): Promise<unknown[]>
  rows(sql: string): AsyncIterable<unknown[]>
}
```

In the main process:

```ts
import { fileURLToPath } from 'node:url'

import { createHost, restartPolicy } from '@electron-stagewright/host-supervisor'
import { utilityProcessTransport } from '@electron-stagewright/host-supervisor/utility'

const host = createHost<DbOps, { key: string }>({
  operations: ['query'],
  streams: ['rows'],
  transport: utilityProcessTransport({
    entry: fileURLToPath(new URL('./db-host.js', import.meta.url)),
    serviceName: 'Database',
  }),
  start: { payload: () => ({ key: readKey() }) },
  stop: { graceMs: 30_000, retireWaitMs: 5_000 },
  limits: { maxPending: 64, callTimeoutMs: 30_000 },
  onExit: restartPolicy({
    isFatal: (exit) => (exit.error as { code?: string }).code === 'SQLITE_CORRUPT',
  }),
})

await host.ops.query('select 1')
await host.call('query', ['select 2'], { signal })
for await (const chunk of host.ops.rows('select * from big')) render(chunk)
await host.close()
```

In the host entry (`db-host.js`):

```ts
import { serveHost } from '@electron-stagewright/host-supervisor'

let db: Db | null = null
serveHost<DbOps, { key: string }>({
  operations: ['query'],
  streams: ['rows'],
  start: async ({ key }) => {
    db = await open(key)
    return {
      query: (sql, { signal }) => db!.all(sql, { signal }),
      rows: (sql) => db!.iterate(sql),
    }
  },
  stop: () => db?.close(),
})
```

`serveHost` finds its port: Electron's `process.parentPort` in a utility process, the
`worker_threads` parent port in a worker. The entry never imports Electron.

## Behaviour

- **Start.** The host starts on the first call, or on `host.start()`. The payload is the first
  message; keep secrets there, not in env or argv. The utility transport passes
  `minimalEnvironment(process.env)` unless you pass `env`.
- **Calls.** Each call has `limits.callTimeoutMs` (or `timeoutMs`) and an optional `signal`. A
  timeout or an abort rejects the call and aborts `context.signal` in the handler, which receives
  it after the caller's arguments. Past `maxPending` calls and open streams, a call fails with
  `HOST_QUEUE_FULL`.
- **Streams.** One item per pull; nothing is produced ahead. Leaving a `for await` early closes the
  producer in the host.
- **Exits.** A call in flight when the host exits fails with `HOST_EXITED`; its `cause` is the
  host's uncaught error when the host could report it. It is never resent. `onExit` then returns
  `fatal` (the default), `on-demand` or `restart`. `restartPolicy()` restarts up to 3 times in 10
  minutes with 0.5, 2 and 8 s of backoff, and a restart whose start fails counts.
- **Stop.** `stop()` refuses new calls, lets accepted ones answer, runs the host's `stop`, and
  terminates the host after `graceMs`. It rejects with `HOST_STOP_TIMEOUT` or
  `HOST_STOP_INCOMPLETE` when the host did not close cleanly, so code that is about to touch its
  files can stop. `kill()` terminates without draining. `close()` stops and refuses every later
  call. After `stop()` or `kill()` the next call starts a new host, once the old one has exited or
  `retireWaitMs` has passed.
- **Memory.** Worker `resourceLimits` usually end only the worker, reported as `out-of-memory`;
  one allocation far past the cap can still abort the whole process, so use `utilityProcess` when
  the app must survive its host. Native memory sits outside any heap cap: pass `statsIntervalMs`
  to `serveHost`, and `memoryWatch({ rssMb, onAlert })` as `onStats`. A worker shares the process,
  so its `rssMb` is the whole app's.

Errors keep their message and a code matching `^[A-Z][A-Z0-9_]{1,80}$`; stacks and object graphs
never cross. The supervisor's own failures are `HostError` with a code from `HOST_ERROR_CODES`.

## Platform notes

- `terminate()` cannot interrupt a synchronous native call: the grace period is honoured between
  calls, not inside one.
- Large results should stream. `postMessage` copies by structured clone, and Electron's V8 memory
  cage rules out external ArrayBuffers, so a native addon must copy into V8 memory anyway.
- Windows has no POSIX signals; a kill is abrupt and a file can stay locked until the process is
  gone. That is what `retireWaitMs` waits for.
- The package ships no binaries. Unpack each `.node` from the asar, sign every `.node` and `.dylib`
  (the macOS hardened runtime refuses unsigned libraries), and load them in a packaged smoke test.
- On Linux a utility process inherits the app's sandbox settings; test it packaged, not only with
  `--no-sandbox`.

Design record: [ADR-032](../../docs/adr/032-host-supervisor-library.md).

## License

MIT
