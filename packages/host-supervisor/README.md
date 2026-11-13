# @electron-stagewright/host-supervisor

Runs one stateful host (a database, a native engine, a server) off the Electron main thread, behind
a closed list of operations, and supervises its life: lazy start, drain on stop, per-call timeout
and `AbortSignal`, a limit on pending calls, waiting for a killed host to exit before the next one
starts, and a choice between fatal and bounded restart when it dies.

This first release ships the supervisor, the host side and an in-process transport for tests. The
`worker_threads` and `utilityProcess` transports follow.

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

## License

MIT
