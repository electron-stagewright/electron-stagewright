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

function driver(response: Envelope, toolNames?: string[]): Driver {
  return {
    client: {
      callTool: async (request: { name: string }) => {
        toolNames?.push(request.name)
        return { content: [{ type: 'text', text: JSON.stringify(response) }] }
      },
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

  it('proves the same known IndexedDB record through broad key discovery and a targeted primary-key read', async () => {
    const keys = scenario('assert-idb-keys')
    const targeted = scenario('assert-idb-get')
    expect(keys.target).toBe(targeted.target)

    const keysToolNames: string[] = []
    const keysDriver = driver(
      {
        ok: true,
        origin: 'http://127.0.0.1:54321',
        keys: ['bench.bulk.01', 'bench.assertion.record'],
      },
      keysToolNames,
    )
    await expect(keys.run(keysDriver)).resolves.toBeUndefined()
    expect(keysDriver.metrics.toolCalls).toBe(2)
    expect(keysToolNames).toEqual(['electron_expect_text', 'storage_idb_keys'])

    const targetedToolNames: string[] = []
    const targetedDriver = driver(
      {
        ok: true,
        origin: 'http://127.0.0.1:54321',
        record: { key: 'bench.assertion.record', value: { fixture: 'assertion' } },
      },
      targetedToolNames,
    )
    await expect(targeted.run(targetedDriver)).resolves.toBeUndefined()
    expect(targetedDriver.metrics.toolCalls).toBe(2)
    expect(targetedToolNames).toEqual(['electron_expect_text', 'storage_idb_get'])
  })

  it('rejects a targeted IndexedDB response that does not prove the known record exists', async () => {
    await expect(
      scenario('assert-idb-get').run(
        driver({ ok: true, origin: 'http://127.0.0.1:54321', record: null }),
      ),
    ).rejects.toThrow('IndexedDB get did not return bench.assertion.record')
  })
})
