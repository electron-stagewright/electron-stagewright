# ADR-032: Host supervisor library

- **Status:** Proposed
- **Date:** 2026-11-13

## Context

Electron apps that keep a stateful resource (an embedded server, a database, a native engine) off
the main thread end up writing the same supervisor: start the host, match answers to calls, fail
pending calls when it dies, stop it without losing work in flight, and decide whether to start it
again. Two apps this kit comes from each wrote one. One runs an embedded server in a worker thread
with a closed operation list, graceful stop and drain, and a bounded restart policy. The other runs
SQL engines in `utilityProcess` hosts with lazy start, per-call timeouts, and a wait for a killed
host to exit before the next one opens the same files. Neither had generic cancellation or a limit
on pending calls; one handled them with its own messages.

Typed RPC over `postMessage` already exists (birpc, oRPC, comlink). What those libraries leave to
the app is the life of the host: what happens to a call when the process dies, how a stop drains,
and when a restart is safe.

## Decision

Ship `@electron-stagewright/host-supervisor`: a supervisor (`createHost`), a host side
(`serveHost`), and two transports, `worker_threads` (`./worker`) and `utilityProcess` (`./utility`).

- **Closed contract.** The supervisor and the host each hold the list of operations; anything else
  is refused on both sides with `HOST_OPERATION_REJECTED`. Operations that answer once and
  operations that stream are listed apart.
- **Errors cross as data.** The message and a code matching `^[A-Z][A-Z0-9_]{1,80}$` cross; stacks
  and object graphs do not. The supervisor's own failures are `HostError` with a closed code. A
  host cannot make an application error look like one.
- **Lazy start, secrets by message.** A host starts on the first call or on `start()`. The start
  payload travels in the first message, never in env or argv. The `utilityProcess` transport passes
  a minimal environment by default.
- **Calls are never resent.** A call in flight when the host exits fails with `HOST_EXITED`, its
  cause being the host's own uncaught error when the host could report it. Calls made while a
  restart is pending wait for it, within their timeout.
- **`onExit` decides.** An exit nobody asked for goes to `onExit`, which returns `fatal`,
  `on-demand` (the next call starts a new host) or `restart` (now, after a delay). A failed restart
  is reported as another exit, so a policy counts it. The default is `fatal`; `restartPolicy()`
  gives the bounded restart one of the source apps uses (3 in 10 minutes, 0.5, 2 and 8 s of
  backoff, `isFatal` for causes such as a corrupt database that must never be retried).
- **Stop drains.** `stop()` refuses new calls, lets the host finish the accepted ones and run its
  own `stop`, and terminates it after `graceMs`. Concurrent stops share one. A stop that timed out,
  or ended without the host confirming it, rejects (`HOST_STOP_TIMEOUT`, `HOST_STOP_INCOMPLETE`),
  so a caller about to touch the host's files does not carry on.
- **Wait for exit.** After a kill, the next host starts only once the previous one has exited, or
  after `retireWaitMs`. A process may hold a file lock until it is gone, and on Windows a kill is
  abrupt.
- **Cancellation and back-pressure.** `AbortSignal` and the per-call timeout abort the call's
  signal inside the host. Streams are pulled one item per request and closing one early runs the
  producer's `finally`. `maxPending` bounds calls and open streams together.
- **No dependencies, own protocol.** About a hundred lines of messages, versioned, validated on
  both sides. `electron` is an optional peer, loaded only when the `utilityProcess` transport
  launches; the root and `./worker` never load it.

## Alternatives considered

- **Build on birpc or oRPC.** Rejected for now: the supervisor would still own every lifecycle
  rule, and the closed list with serialized errors is the security boundary, small enough to keep
  in house. The transport interface does not rule out a typed RPC layer on top.
- **Restart by default.** Rejected: restarting over a corrupt database or a revoked key hides the
  damage. Restart is one line to opt into.
- **Resend calls in flight after a restart.** Rejected: the supervisor cannot know an operation is
  idempotent. The app retries what it knows is safe.
- **One transport.** Rejected: the choice between a worker and a process is the main trade-off an
  app makes, and it changes with the native code the host loads.

## Consequences

- A native crash in a worker thread still ends the whole app; only `utilityProcess` isolates it.
  The README puts that choice first.
- `terminate()` cannot interrupt a synchronous native call; the grace period is honoured between
  calls.
- The handler context is appended after the caller's arguments, so existing operation objects work
  unchanged, but a contract with optional parameters must pass them positionally.
- The package ships no binaries. Signing, `asarUnpack` and prebuilds of a host's native modules
  stay with the app.
- Adoption in the source apps is separate work. One of them guards fiscal documents in its stop
  path, so any change to its drain is reviewed on its own.
