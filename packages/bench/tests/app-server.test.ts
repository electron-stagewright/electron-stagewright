import { afterEach, describe, expect, it } from 'vitest'

import { startBenchAppServer } from '../app/server.js'

let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
})

describe('benchmark loopback fixture', () => {
  it('serves only the in-memory document from an ephemeral loopback HTTP origin', async () => {
    const fixture = await startBenchAppServer('<main>Benchmark fixture</main>')
    close = fixture.close

    expect(fixture.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const root = await fetch(`${fixture.origin}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toContain('text/html')
    await expect(root.text()).resolves.toBe('<main>Benchmark fixture</main>')

    const index = await fetch(`${fixture.origin}/index.html`, { method: 'HEAD' })
    expect(index.status).toBe(200)
    await expect(index.text()).resolves.toBe('')

    const missing = await fetch(`${fixture.origin}/outside.html`)
    expect(missing.status).toBe(404)
  })
})
