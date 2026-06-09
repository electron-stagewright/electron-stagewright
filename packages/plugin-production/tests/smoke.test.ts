/**
 * Gated real-CLI smoke (ADR-012). Runs the ACTUAL `codesign` / `xcrun stapler` / `spctl` through
 * the real {@link makeRunCommand} against a synthetic unsigned `.app`, exercising the execFile path
 * the unit tests fake. Opt-in via `STAGEWRIGHT_E2E=1` so the default suite never depends on the
 * macOS toolchain. Proves classification is sane: the bundle passes, every check yields a
 * registered status, and on macOS an unsigned, un-notarized app is correctly a code-signing AND a
 * notarization FAIL (the real codesign / stapler ran).
 *
 * @module
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runChecks } from '../src/checks.js'
import { makeRunCommand } from '../src/command.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'

const created: string[] = []
afterAll(async () => {
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

describe('production plugin smoke (real CLIs)', () => {
  it.skipIf(!RUN_E2E)(
    'runs the real checks against a synthetic unsigned app and classifies sanely',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'sw-prod-smoke-'))
      created.push(dir)
      const app = path.join(dir, 'Demo.app')
      await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true })
      await writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist/>\n')
      await writeFile(path.join(app, 'Contents', 'MacOS', 'Demo'), '#!/bin/sh\n')

      const results = await runChecks(app, makeRunCommand(10_000))
      expect(results.find((r) => r.id === 'bundle-structure')?.status).toBe('pass')
      for (const r of results) expect(['pass', 'fail', 'unknown']).toContain(r.status)
      // On macOS the real codesign / stapler ran against an unsigned, un-notarized bundle — both
      // must be a fail.
      if (process.platform === 'darwin') {
        expect(results.find((r) => r.id === 'code-signing')?.status).toBe('fail')
        expect(results.find((r) => r.id === 'notarization')?.status).toBe('fail')
      }
    },
    30_000,
  )
})
