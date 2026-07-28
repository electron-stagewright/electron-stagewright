import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { SourceUnavailableError, unavailableReason } from '../src/errors.js'
import { requestJson } from '../src/http.js'
import { collectPackageAdoption } from '../src/npm-source.js'
import {
  completeDateWindow,
  currentDateWindow,
  parseInstant,
  trailingInstantWindow,
} from '../src/time.js'
import { loadPublishableWorkspaces } from '../src/workspaces.js'

const GENERATED_AT = '2026-07-27T15:00:00Z'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('release-health time windows', () => {
  it('accepts UTC RFC3339 timestamps with optional fractional seconds', () => {
    expect(parseInstant('2026-07-27T15:00:00Z')).toBe(Date.UTC(2026, 6, 27, 15))
    expect(parseInstant('2026-07-27T15:00:00.12Z')).toBe(Date.UTC(2026, 6, 27, 15, 0, 0, 120))
    expect(() => parseInstant('2026-02-30T15:00:00Z')).toThrow(SourceUnavailableError)
    expect(() => parseInstant('2026-07-27T10:00:00-05:00')).toThrow(SourceUnavailableError)
  })

  it('builds complete, current, and trailing UTC windows', () => {
    expect(completeDateWindow(GENERATED_AT, 3)).toEqual({
      start: '2026-07-24',
      end: '2026-07-26',
      dates: ['2026-07-24', '2026-07-25', '2026-07-26'],
    })
    expect(currentDateWindow(GENERATED_AT, 3)).toEqual({
      start: '2026-07-25',
      end: '2026-07-27',
      dates: ['2026-07-25', '2026-07-26', '2026-07-27'],
    })
    expect(trailingInstantWindow(GENERATED_AT, 90, 7)).toEqual({
      start: '2026-04-28T15:00:00.000Z',
      end: '2026-07-20T15:00:00.000Z',
    })
  })
})

describe('publishable workspace discovery', () => {
  it('derives a sorted public package list and excludes private workspaces', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stagewright-release-health-'))
    for (const [directory, manifest] of [
      ['zeta', { name: '@electron-stagewright/zeta', version: '1.2.3' }],
      ['private', { name: '@electron-stagewright/internal', version: '0.0.0', private: true }],
      ['alpha', { name: '@electron-stagewright/alpha', version: '2.0.0-beta.1' }],
    ] as const) {
      await mkdir(path.join(root, 'packages', directory), { recursive: true })
      await writeFile(
        path.join(root, 'packages', directory, 'package.json'),
        JSON.stringify(manifest),
      )
    }

    await expect(loadPublishableWorkspaces(root)).resolves.toEqual([
      { name: '@electron-stagewright/alpha', version: '2.0.0-beta.1' },
      { name: '@electron-stagewright/zeta', version: '1.2.3' },
    ])
  })

  it('fails closed for malformed public manifests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stagewright-release-health-'))
    await mkdir(path.join(root, 'packages', 'bad'), { recursive: true })
    await writeFile(
      path.join(root, 'packages', 'bad', 'package.json'),
      JSON.stringify({ name: 'other/package', version: 'latest' }),
    )
    await expect(loadPublishableWorkspaces(root)).rejects.toMatchObject({
      reason: 'invalid_response',
    })
  })
})

describe('npm adoption source', () => {
  it('requests every scoped package separately and computes exact rolling totals', async () => {
    const window = completeDateWindow(GENERATED_AT, 30)
    const requested: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      const encodedPackage = url.split('/').at(-1)
      const packageName = decodeURIComponent(encodedPackage ?? '')
      return jsonResponse({
        package: packageName,
        start: window.start,
        end: window.end,
        downloads: window.dates.map((day, index) => ({
          day,
          downloads: index + 1,
        })),
      })
    }) as typeof fetch

    const metric = await collectPackageAdoption(
      [
        { name: '@electron-stagewright/core', version: '0.4.1' },
        { name: '@electron-stagewright/plugin-clock', version: '0.4.1' },
      ],
      window,
      { fetchImpl },
    )

    expect(requested).toHaveLength(2)
    expect(requested[0]).toContain('%40electron-stagewright%2Fcore')
    expect(requested[1]).toContain('%40electron-stagewright%2Fplugin-clock')
    expect(metric.packages[0]).toMatchObject({
      package: '@electron-stagewright/core',
      rolling_7_day: 189,
      rolling_30_day: 465,
    })
  })

  it('treats a missing date as unavailable rather than zero', async () => {
    const window = completeDateWindow(GENERATED_AT, 30)
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        package: '@electron-stagewright/core',
        start: window.start,
        end: window.end,
        downloads: window.dates.slice(1).map((day) => ({ day, downloads: 0 })),
      }),
    ) as typeof fetch

    await expect(
      collectPackageAdoption([{ name: '@electron-stagewright/core', version: '0.4.1' }], window, {
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'incomplete_data' })
  })
})

describe('bounded HTTP failures', () => {
  it('maps upstream status and invalid JSON without retaining response bodies', async () => {
    const permissionFetch = vi.fn(
      async () => new Response('secret', { status: 403 }),
    ) as typeof fetch
    await expect(
      requestJson('https://example.test', {}, { source: 'github', fetchImpl: permissionFetch }),
    ).rejects.toMatchObject({ reason: 'permission_denied' })

    const invalidFetch = vi.fn(async () => new Response('not-json')) as typeof fetch
    await expect(
      requestJson('https://example.test', {}, { source: 'npm', fetchImpl: invalidFetch }),
    ).rejects.toMatchObject({ reason: 'invalid_response' })

    const rateLimitedFetch = vi.fn(
      async () =>
        new Response('', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        }),
    ) as typeof fetch
    await expect(
      requestJson('https://example.test', {}, { source: 'github', fetchImpl: rateLimitedFetch }),
    ).rejects.toMatchObject({ reason: 'rate_limited' })

    const timeoutFetch = vi.fn(async () => {
      throw new DOMException('secret timeout details', 'TimeoutError')
    }) as typeof fetch
    await expect(
      requestJson('https://example.test', {}, { source: 'github', fetchImpl: timeoutFetch }),
    ).rejects.toMatchObject({ reason: 'timeout' })

    const failedFetch = vi.fn(async () => {
      throw new Error('secret transport details')
    }) as typeof fetch
    await expect(
      requestJson('https://example.test', {}, { source: 'github', fetchImpl: failedFetch }),
    ).rejects.toMatchObject({ reason: 'source_error' })
    expect(unavailableReason(new Error('secret source details'))).toBe('source_error')
  })
})
