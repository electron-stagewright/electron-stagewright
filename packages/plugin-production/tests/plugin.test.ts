/**
 * Integration tests for the production plugin (ADR-012) loaded into a real server. Driven through
 * `createServer(...).dispatcher` against a synthetic `.app` on disk. Assertions are host-agnostic:
 * bundle-structure is deterministic (a well-formed bundle passes), while code-signing/gatekeeper
 * are pass|fail|unknown depending on whether the macOS toolchain is present — so the suite asserts
 * the result SHAPE and the bundle outcome, plus the input-error and subset paths, not a
 * host-dependent signing verdict.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createServer } from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import productionPlugin from '../src/index.js'

const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

/** A realistic XML Info.plist so the in-process info-plist check exercises a real parse on macOS. */
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.example.demo</string>
  <key>CFBundleShortVersionString</key><string>1.2.3</string>
  <key>CFBundleExecutable</key><string>Demo</string>
  <key>CFBundleName</key><string>Demo</string>
  <key>CFBundleVersion</key><string>42</string>
</dict>
</plist>
`

async function makeApp(opts: { info?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-prod-'))
  created.push(dir)
  const app = path.join(dir, 'Demo.app')
  await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  if (opts.info ?? true) await writeFile(path.join(app, 'Contents', 'Info.plist'), INFO_PLIST)
  await writeFile(path.join(app, 'Contents', 'MacOS', 'Demo'), '#!/bin/sh\n')
  return app
}

interface ValidateResult {
  readonly ok: boolean
  readonly app_path: string
  readonly passed: boolean
  readonly summary: { pass: number; fail: number; unknown: number }
  readonly checks: ReadonlyArray<{ id: string; status: string }>
}

describe('production plugin (in-process)', () => {
  it('registers production_validate via the plugin model', async () => {
    const server = await createServer({ plugins: [productionPlugin] })
    try {
      expect(server.dispatcher.has('production_validate')).toBe(true)
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('validates a well-formed bundle and returns structured per-check results', async () => {
    const app = await makeApp()
    const server = await createServer({ plugins: [productionPlugin] })
    try {
      const res = (await server.dispatcher.dispatch('production_validate', {
        appPath: app,
      })) as ValidateResult
      expect(res.ok).toBe(true)
      expect(res.app_path).toBe(app)
      expect(res.checks).toHaveLength(5)
      // Host-agnostic: a well-formed bundle always passes structure; the shell-out checks
      // (info-plist/code-signing/notarization/gatekeeper) vary with the macOS toolchain's presence.
      expect(res.checks.find((c) => c.id === 'bundle-structure')?.status).toBe('pass')
      expect(res.summary.pass + res.summary.fail + res.summary.unknown).toBe(5)
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('runs only the requested subset of checks', async () => {
    const app = await makeApp()
    const server = await createServer({ plugins: [productionPlugin] })
    try {
      const res = (await server.dispatcher.dispatch('production_validate', {
        appPath: app,
        checks: ['bundle-structure'],
      })) as ValidateResult
      expect(res.checks).toHaveLength(1)
      expect(res.checks[0]).toMatchObject({ id: 'bundle-structure', status: 'pass' })
      expect(res.passed).toBe(true)
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('rejects an empty check subset before reporting a false green result', async () => {
    const app = await makeApp()
    const server = await createServer({ plugins: [productionPlugin] })
    try {
      expect(
        await server.dispatcher.dispatch('production_validate', {
          appPath: app,
          checks: [],
        }),
      ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('reports a structural failure as a check result, with the tool still ok', async () => {
    const app = await makeApp({ info: false })
    const server = await createServer({ plugins: [productionPlugin] })
    try {
      const res = (await server.dispatcher.dispatch('production_validate', {
        appPath: app,
        checks: ['bundle-structure'],
      })) as ValidateResult
      expect(res.ok).toBe(true) // the tool succeeded at validating
      expect(res.passed).toBe(false) // the app failed validation
      expect(res.summary.fail).toBe(1)
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('rejects a missing app path with APP_NOT_FOUND', async () => {
    const server = await createServer({ plugins: [productionPlugin] })
    try {
      expect(
        await server.dispatcher.dispatch('production_validate', {
          appPath: path.join(tmpdir(), 'sw-prod-does-not-exist', 'Demo.app'),
        }),
      ).toMatchObject({ ok: false, code: 'production.APP_NOT_FOUND' })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('rejects a relative app path with ABSOLUTE_PATH_REQUIRED', async () => {
    const server = await createServer({ plugins: [productionPlugin] })
    try {
      expect(
        await server.dispatcher.dispatch('production_validate', {
          appPath: 'relative/Demo.app',
        }),
      ).toMatchObject({ ok: false, code: 'ABSOLUTE_PATH_REQUIRED' })
    } finally {
      await server.close().catch(() => undefined)
    }
  })

  it('rejects a non-directory path with NOT_A_BUNDLE', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-prod-'))
    created.push(dir)
    const file = path.join(dir, 'notanapp')
    await writeFile(file, 'x')
    const server = await createServer({ plugins: [productionPlugin] })
    try {
      expect(
        await server.dispatcher.dispatch('production_validate', { appPath: file }),
      ).toMatchObject({ ok: false, code: 'production.NOT_A_BUNDLE' })
    } finally {
      await server.close().catch(() => undefined)
    }
  })
})
