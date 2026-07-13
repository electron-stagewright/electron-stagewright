import { describe, expect, it } from 'vitest'

import { PROFILE_SCENARIOS } from '../src/profile-scenarios.js'
import type { Driver, Envelope, ScenarioMetrics } from '../src/harness.js'

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

function envelopeFor(name: string, loaded: boolean): Envelope {
  if (name === 'electron_find') return { ok: true, matches: [{ ref: 42 }] }
  if (name === 'electron_get_value') return { ok: true, value: 'Ada Lovelace' }
  if (name === 'electron_get_text') {
    if (!loaded) return { ok: false, code: 'SELECTOR_NO_MATCH', error: 'not loaded' }
    return { ok: true, text: 'Details loaded Item 01 (updated 1)' }
  }
  if (name === 'electron_exists') return { ok: true, exists: loaded }
  return { ok: true }
}

function profileDriver(): Driver {
  let loaded = false
  const client = {
    callTool: async ({ name }: { name: string }) => {
      const response = envelopeFor(name, loaded)
      if (name === 'electron_click') loaded = true
      return { content: [{ type: 'text', text: JSON.stringify(response) }] }
    },
  }
  return {
    client: client as unknown as Driver['client'],
    sessionId: 'profile-session',
    sessionArgs: { sessionId: 'profile-session' },
    metrics: metrics(),
  }
}

describe('profile benchmark scenarios', () => {
  for (const scenario of PROFILE_SCENARIOS) {
    it(`runs ${scenario.name} against the essential tool contract`, async () => {
      const driver = profileDriver()

      await expect(scenario.run(driver)).resolves.toBeUndefined()

      expect(driver.metrics.toolCalls).toBeGreaterThan(0)
    })
  }
})
