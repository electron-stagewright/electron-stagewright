// Drives a utilityProcess host through a kill mid-call, a crash mid-call and a drained stop, then
// prints one HOST_SMOKE line for the test to read.
import { fileURLToPath } from 'node:url'

import { app } from 'electron'

import { createHost, restartPolicy } from '../../../dist/index.js'
import { utilityProcessTransport } from '../../../dist/utility.js'

const entry = fileURLToPath(new URL('./host.mjs', import.meta.url))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const outcome = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({
      ok: false,
      code: error?.code,
      cause: error?.cause?.message,
      causeCode: error?.cause?.code,
    }),
  )

async function run() {
  const result = { exits: [], mainPid: process.pid }
  const policy = restartPolicy({ backoffMs: [0] })
  const host = createHost({
    operations: ['echo', 'pid', 'slow', 'crash'],
    transport: utilityProcessTransport({ entry, serviceName: 'Stagewright host smoke' }),
    start: { payload: () => ({ greeting: 'hello' }), timeoutMs: 20_000 },
    limits: { callTimeoutMs: 20_000 },
    onExit: (exit) => {
      result.exits.push({ kind: exit.kind, pendingCalls: exit.pendingCalls })
      return policy(exit)
    },
  })
  result.echo = await host.ops.echo('utility')
  result.firstPid = await host.ops.pid()

  const killed = outcome(host.ops.slow(10_000))
  await delay(200)
  process.kill(result.firstPid, 'SIGKILL')
  result.killed = await killed
  result.afterKill = await host.ops.echo('again')
  result.secondPid = await host.ops.pid()

  result.crashed = await outcome(host.ops.crash())
  result.afterCrash = await host.ops.echo('third')

  const drained = outcome(host.ops.slow(300))
  await delay(50)
  result.stop = await outcome(host.stop())
  result.drained = await drained
  await host.close()
  result.state = host.state
  return result
}

app
  .whenReady()
  .then(run)
  .then(
    (result) => {
      process.stdout.write(`HOST_SMOKE ${JSON.stringify(result)}\n`)
      app.exit(0)
    },
    (error) => {
      process.stdout.write(
        `HOST_SMOKE ${JSON.stringify({ error: String(error?.stack ?? error) })}\n`,
      )
      app.exit(1)
    },
  )
