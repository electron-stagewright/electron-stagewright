/**
 * In-process contract coverage for the a11y plugin. The fake transport records
 * the fixed installer separately from the compact audit body, so cache behavior
 * and bounded/error envelopes are tested without a Chromium process. The real
 * renderer execution is covered by the gated Electron smoke.
 */

import { type StagewrightServer, type TransportCapabilities } from '@electron-stagewright/core'
import { FakeSession, fullCapabilities, TestLifecycle } from '@electron-stagewright/testkit'
import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'

import packageJson from '../package.json' with { type: 'json' }
import a11yPlugin from '../src/index.js'
import { buildAxeAuditBody, type AuditRequest } from '../src/axe.js'

const lifecycle = new TestLifecycle()
afterEach(() => lifecycle.cleanup())

interface FindingResult {
  readonly kind: 'ok'
  readonly version: string
  readonly violations: {
    readonly issues: readonly unknown[]
    readonly total: number
    readonly truncated: boolean
  }
  readonly incomplete: {
    readonly issues: readonly unknown[]
    readonly total: number
    readonly truncated: boolean
  }
}

const RESULT: FindingResult = {
  kind: 'ok',
  version: '4.12.1',
  violations: {
    issues: [
      {
        id: 'image-alt',
        impact: 'critical',
        help: 'Images must have alternative text',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.12/image-alt',
        nodes: [{ targets: [['#missing-alt']] }],
        nodeCount: 1,
        nodesTruncated: false,
      },
    ],
    total: 1,
    truncated: false,
  },
  incomplete: { issues: [], total: 0, truncated: false },
}

async function open(
  session: FakeSession,
  capabilities: TransportCapabilities = fullCapabilities(),
): Promise<StagewrightServer> {
  const { server } = await lifecycle.createPluginTestServer(a11yPlugin, { session, capabilities })
  return server
}

async function launch(server: StagewrightServer): Promise<string> {
  return lifecycle.launch(server)
}

function isInstallBody(body: string): boolean {
  return body.includes("Object.getOwnPropertyDescriptor(globalThis, 'axe')")
}

describe('a11y plugin (in-process)', () => {
  it('advertises a non-eval-gated audit tool and its package version', async () => {
    const server = await open(new FakeSession())
    expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
      ok: true,
      plugins: [
        {
          name: 'a11y',
          version: packageJson.version,
          tools: [{ name: 'a11y_audit', state: 'enabled' }],
          requirements: {
            transportCapabilities: ['supportsRendererEval', 'supportsSurfaceTargeting'],
          },
        },
      ],
    })
    const manifest = server.dispatcher.listManifest().find((entry) => entry.name === 'a11y_audit')
    expect(manifest).toMatchObject({ operationType: 'query' })
    expect(manifest?.requiresEvalFlag).toBeUndefined()
  })

  it('installs once per surface, then sends only the compact audit body on a warm audit', async () => {
    const calls: Array<{ readonly body: string; readonly arg?: unknown }> = []
    const session = new FakeSession({
      evaluate: async (_target, body, arg) => {
        calls.push({ body, arg })
        return isInstallBody(body) ? { kind: 'installed' } : RESULT
      },
    })
    const server = await open(session)
    const sessionId = await launch(server)
    // electron_launch probes its fake session; cache assertions start at the audit boundary.
    calls.length = 0

    const first = await server.dispatcher.dispatch('a11y_audit', {
      sessionId,
      include: ['#settings'],
      exclude: ['.transient'],
      tags: ['wcag2a'],
      impactMin: 'serious',
      maxViolations: 1,
      maxNodesPerViolation: 1,
    })
    expect(first).toMatchObject({
      ok: true,
      surface_id: '__default__',
      engine: { version: '4.12.1', cache_hit: false },
      summary: { violations: 1, incomplete: 0 },
      limitation: expect.stringContaining('not full WCAG conformance'),
    })
    const firstEngine = first as unknown as {
      readonly engine: { readonly transferred_bytes: number }
    }
    expect(firstEngine.engine.transferred_bytes).toBeGreaterThan(100_000)
    expect(calls.map((call) => ({ install: isInstallBody(call.body), arg: call.arg }))).toEqual([
      { install: true, arg: undefined },
      {
        install: false,
        arg: {
          include: ['#settings'],
          exclude: ['.transient'],
          tags: ['wcag2a'],
          impactMin: 'serious',
          maxViolations: 1,
          maxNodesPerViolation: 1,
        },
      },
    ])
    expect(isInstallBody(calls[0]?.body ?? '')).toBe(true)
    expect((calls[0]?.body.length ?? 0) > 100_000).toBe(true)
    expect(isInstallBody(calls[1]?.body ?? '')).toBe(false)
    expect((calls[1]?.body.length ?? 0) < 10_000).toBe(true)
    expect(calls[1]?.arg).toEqual({
      include: ['#settings'],
      exclude: ['.transient'],
      tags: ['wcag2a'],
      impactMin: 'serious',
      maxViolations: 1,
      maxNodesPerViolation: 1,
    } satisfies AuditRequest)

    const second = await server.dispatcher.dispatch('a11y_audit', { sessionId })
    expect(second).toMatchObject({
      ok: true,
      engine: { version: '4.12.1', cache_hit: true, transferred_bytes: 0 },
    })
    expect(calls).toHaveLength(3)
    expect(isInstallBody(calls[2]?.body ?? '')).toBe(false)
  })

  it('recovers once when the selected renderer reloads and loses the engine cache', async () => {
    let auditCalls = 0
    const session = new FakeSession({
      evaluate: async (_target, body) => {
        if (isInstallBody(body)) return { kind: 'installed' }
        auditCalls += 1
        return auditCalls === 2 ? { kind: 'engine_missing' } : RESULT
      },
    })
    const server = await open(session)
    const sessionId = await launch(server)
    auditCalls = 0

    await expect(server.dispatcher.dispatch('a11y_audit', { sessionId })).resolves.toMatchObject({
      ok: true,
      engine: { cache_hit: false },
    })
    await expect(server.dispatcher.dispatch('a11y_audit', { sessionId })).resolves.toMatchObject({
      ok: true,
      engine: { cache_hit: false, transferred_bytes: expect.any(Number) },
    })
  })

  it.each([
    ['invalid selector', { scope: '[' }, 'a11y.INVALID_SELECTOR'],
    ['missing scope', { scope: '#gone' }, 'a11y.SCOPE_NOT_FOUND'],
    ['engine error', {}, 'a11y.ENGINE_FAILED'],
  ])('maps a renderer %s to the stable envelope code', async (_name, input, code) => {
    const rendererResult =
      code === 'a11y.INVALID_SELECTOR'
        ? { kind: 'invalid_selector', field: 'scope', selector: '[', message: 'Invalid selector' }
        : code === 'a11y.SCOPE_NOT_FOUND'
          ? { kind: 'scope_not_found', field: 'scope', selector: '#gone' }
          : { kind: 'engine_error', message: 'renderer is still loading' }
    const session = new FakeSession({
      evaluate: async (_target, body) =>
        isInstallBody(body) ? { kind: 'installed' } : rendererResult,
    })
    const server = await open(session)
    const sessionId = await launch(server)
    expect(await server.dispatcher.dispatch('a11y_audit', { sessionId, ...input })).toMatchObject({
      ok: false,
      code,
    })
  })

  it('rejects unsupported renderer or surface capabilities before injecting the engine', async () => {
    for (const capabilities of [
      fullCapabilities({ supportsRendererEval: false }),
      fullCapabilities({ supportsSurfaceTargeting: false }),
    ]) {
      const session = new FakeSession()
      const server = await open(session, capabilities)
      const sessionId = await launch(server)
      expect(await server.dispatcher.dispatch('a11y_audit', { sessionId })).toMatchObject({
        ok: false,
        code: 'a11y.UNSUPPORTED',
      })
    }
  })

  it('rejects incompatible filters and bounds before any renderer call', async () => {
    const calls: unknown[] = []
    const session = new FakeSession({
      evaluate: async () => {
        calls.push('evaluate')
        return RESULT
      },
    })
    const server = await open(session)
    const sessionId = await launch(server)
    calls.length = 0
    for (const input of [
      { scope: '#one', include: ['#two'] },
      { tags: ['wcag2a'], rules: ['image-alt'] },
      { maxViolations: 201 },
      { maxNodesPerViolation: 21 },
    ]) {
      expect(await server.dispatcher.dispatch('a11y_audit', { sessionId, ...input })).toMatchObject(
        {
          ok: false,
          code: 'BAD_ARGUMENT',
        },
      )
    }
    expect(calls).toEqual([])
  })

  it('bounds long selector paths from renderer findings without exposing raw DOM markup', async () => {
    const longPart = 'x'.repeat(600)
    const engineKey = Symbol.for('electron-stagewright.a11y.axe-engine')
    const context = createContext({ document: { querySelector: () => ({}) } })
    Reflect.set(context, engineKey, {
      version: 'test',
      run: async () => ({
        violations: [
          {
            id: 'image-alt',
            impact: 'critical',
            help: 'Images need text alternatives',
            helpUrl: 'https://example.test/image-alt',
            nodes: [{ target: [[longPart, ...Array.from({ length: 10 }, () => 'part')]] }],
          },
        ],
        incomplete: [],
      }),
    })
    const audit = runInContext(`(async (arg) => {${buildAxeAuditBody()}})`, context) as (
      request: AuditRequest,
    ) => Promise<unknown>

    await expect(audit({ maxViolations: 1, maxNodesPerViolation: 1 })).resolves.toMatchObject({
      kind: 'ok',
      violations: {
        issues: [
          {
            nodes: [
              {
                targetsTruncated: true,
                targets: [[expect.stringMatching(/^x{511}…$/), ...Array(7).fill('part')]],
              },
            ],
          },
        ],
      },
    })
  })
})
