import { describe, expect, it } from 'vitest'

import { SCENARIOS } from '../src/scenarios.js'
import type { Driver, Envelope, Scenario, ScenarioMetrics } from '../src/harness.js'

function metrics(): ScenarioMetrics {
  return {
    toolCalls: 0,
    estimatedTokens: 0,
    requestTokens: 0,
    measuredTokens: 0,
    requestCharacters: 0,
    responseCharacters: 0,
    failedCalls: 0,
    retries: 0,
    latencyMs: 0,
  }
}

function scenario(name: string): Scenario {
  const found = SCENARIOS.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`missing benchmark scenario ${name}`)
  return found
}

function driver(response: Envelope): Driver {
  return {
    client: {
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(response) }] }),
    } as unknown as Driver['client'],
    sessionId: 'storage-session',
    sessionArgs: { sessionId: 'storage-session' },
    metrics: metrics(),
  }
}

describe('storage benchmark scenarios', () => {
  it('uses a storage-plugin target and proves the same one-value assertion through both paths', async () => {
    const snapshot = scenario('assert-storage-snapshot')
    const targeted = scenario('assert-storage-local-get')
    expect(snapshot.target?.args).toContain('@electron-stagewright/plugin-storage')
    expect(targeted.target).toBe(snapshot.target)

    const snapshotDriver = driver({
      ok: true,
      origins: [
        {
          origin: 'http://127.0.0.1:54321',
          localStorage: [
            { name: 'bench.bulk.01', value: 'fixture state' },
            { name: 'bench.assertion.status', value: 'ready' },
          ],
        },
      ],
    })
    await expect(snapshot.run(snapshotDriver)).resolves.toBeUndefined()
    expect(snapshotDriver.metrics.toolCalls).toBe(1)

    const targetedDriver = driver({
      ok: true,
      scope: 'local',
      origin: 'http://127.0.0.1:54321',
      value: 'ready',
    })
    await expect(targeted.run(targetedDriver)).resolves.toBeUndefined()
    expect(targetedDriver.metrics.toolCalls).toBe(1)
  })

  it('rejects an empty storage snapshot instead of treating a file-origin result as evidence', async () => {
    await expect(
      scenario('assert-storage-snapshot').run(driver({ ok: true, origins: [] })),
    ).rejects.toThrow('storage snapshot did not contain bench.assertion.status=ready')
  })
})
