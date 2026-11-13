# @electron-stagewright/host-supervisor

Runs one stateful host (a database, a native engine, a server) off the Electron main thread, behind
a closed list of operations, and supervises its life: lazy start, drain on stop, per-call timeout
and `AbortSignal`, a limit on pending calls, waiting for a killed host to exit before the next one
starts, and a choice between fatal and bounded restart when it dies.

Transports: `worker_threads` from `@electron-stagewright/host-supervisor/worker`, and an
in-process one for tests. The `utilityProcess` transport follows.

```ts
import { createHost, restartPolicy } from '@electron-stagewright/host-supervisor'

interface DbOps {
  query(sql: string): Promise<unknown[]>
  rows(sql: string): AsyncIterable<unknown[]>
}

const host = createHost<DbOps, { key: string }>({
  operations: ['query'],
  streams: ['rows'],
  transport,
  start: { payload: () => ({ key: loadKey() }) },
  limits: { maxPending: 64, callTimeoutMs: 30_000 },
  onExit: restartPolicy(),
})

await host.ops.query('select 1')
await host.call('query', ['select 2'], { signal })
for await (const chunk of host.ops.rows('select * from big')) render(chunk)
await host.close()
```

The host entry:

```ts
import { serveHost } from '@electron-stagewright/host-supervisor'

let db: Db

serveHost<DbOps, { key: string }>({
  operations: ['query'],
  streams: ['rows'],
  start: async ({ key }) => {
    db = await open(key)
    return {
      query: (sql, { signal }) => db.all(sql, { signal }),
      rows: (sql) => db.iterate(sql),
    }
  },
  stop: () => db.close(),
})
```

Errors keep their message and a code that matches `^[A-Z][A-Z0-9_]{1,80}$`; stacks and object
graphs never cross. The supervisor's own failures are `HostError` with one of `HOST_ERROR_CODES`.

## Worker threads

```ts
import { workerThreadTransport } from '@electron-stagewright/host-supervisor/worker'

const transport = workerThreadTransport({
  entry: new URL('./db-host.js', import.meta.url),
  resourceLimits: { maxOldGenerationSizeMb: 384 },
})
```

Past `resourceLimits` Node usually ends only the worker, and the supervisor reports the exit as
`out-of-memory`. One allocation far past the cap can still abort the whole process; use
`utilityProcess` when the app must survive its host. Native memory is outside that cap: pass `statsIntervalMs` to `serveHost` and
`memoryWatch({ rssMb, onAlert })` as `onStats` to see it. A worker shares the process, so its
`rssMb` is the whole app's.

## License

MIT
