/**
 * Unit tests for the production checks (ADR-012). The shell-out checks run against a fake
 * {@link RunCommand} so every branch — pass / fail / unknown — is exercised on any OS without the
 * macOS toolchain; the bundle check runs against a synthetic .app on disk.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  checkBundleStructure,
  checkCodeSigning,
  checkGatekeeper,
  checkNotarization,
  runChecks,
  CHECK_IDS,
} from '../src/checks.js'
import type { CommandResult, RunCommand } from '../src/command.js'

const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

/** Build a synthetic `.app` with optional Info.plist / MacOS executable for the structure check. */
async function makeApp(opts: { info?: boolean; exe?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-prod-'))
  created.push(dir)
  const app = path.join(dir, 'Demo.app')
  await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  if (opts.info ?? true) await writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist/>\n')
  if (opts.exe ?? true) await writeFile(path.join(app, 'Contents', 'MacOS', 'Demo'), '#!/bin/sh\n')
  return app
}

const NOT_FOUND: CommandResult = {
  ok: false,
  code: null,
  stdout: '',
  stderr: '',
  spawnError: 'command not found',
}

/**
 * A {@link RunCommand} returning canned results. `codesign --verify` and `codesign -dvvv` (the
 * identity read) are DISTINCT invocations, so they are keyed separately — the pass path must
 * exercise the real extraction (verify succeeds; the authority comes from the -dvvv call), not one
 * stub replayed for both. `xcrun stapler validate` (notarization) is keyed as `staplerValidate`;
 * `spctl` doubles as the gatekeeper check AND the notarization-pass evidence read. Anything
 * unconfigured resolves to command-not-found.
 */
function fakeRun(plan: {
  codesignVerify?: CommandResult
  codesignDisplay?: CommandResult
  staplerValidate?: CommandResult
  spctl?: CommandResult
}): RunCommand {
  return (command, args) => {
    if (command === 'codesign') {
      return Promise.resolve(
        (args.includes('-dvvv') ? plan.codesignDisplay : plan.codesignVerify) ?? NOT_FOUND,
      )
    }
    if (command === 'xcrun' && args.includes('stapler')) {
      return Promise.resolve(plan.staplerValidate ?? NOT_FOUND)
    }
    if (command === 'spctl') return Promise.resolve(plan.spctl ?? NOT_FOUND)
    return Promise.resolve(NOT_FOUND)
  }
}

describe('checkBundleStructure', () => {
  it('passes a well-formed bundle', async () => {
    const result = await checkBundleStructure(await makeApp())
    expect(result).toMatchObject({ id: 'bundle-structure', status: 'pass' })
  })

  it('fails when Info.plist is missing', async () => {
    const result = await checkBundleStructure(await makeApp({ info: false }))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('Info.plist')
    expect(result.next_actions?.length).toBeGreaterThan(0)
  })

  it('fails when the MacOS executable is missing', async () => {
    const result = await checkBundleStructure(await makeApp({ exe: false }))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('MacOS')
  })

  it('fails when the MacOS directory is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-prod-'))
    created.push(dir)
    const app = path.join(dir, 'Demo.app')
    await mkdir(path.join(app, 'Contents'), { recursive: true })
    await writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist/>\n')
    const result = await checkBundleStructure(app)
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('MacOS')
  })

  it('fails when Contents/MacOS contains no regular file', async () => {
    const app = await makeApp({ exe: false })
    await mkdir(path.join(app, 'Contents', 'MacOS', 'Nested.app'))
    const result = await checkBundleStructure(app)
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('MacOS')
  })
})

describe('checkCodeSigning', () => {
  it('passes a verified signature and reports the authority (from the -dvvv call) as evidence', async () => {
    const run = fakeRun({
      codesignVerify: { ok: true, code: 0, stdout: '', stderr: '' },
      codesignDisplay: {
        ok: true,
        code: 0,
        stdout: '',
        stderr:
          'Executable=/x\nAuthority=Developer ID Application: Acme (TEAMID)\nTeamIdentifier=TEAMID',
      },
    })
    const result = await checkCodeSigning('/x/Demo.app', run)
    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('Authority=Developer ID Application')
  })

  it('still passes (without evidence) when the identity read fails', async () => {
    // verify succeeds, but the second -dvvv call is unconfigured -> command-not-found, so the
    // identity is omitted and the verdict is unchanged.
    const run = fakeRun({ codesignVerify: { ok: true, code: 0, stdout: '', stderr: '' } })
    const result = await checkCodeSigning('/x/Demo.app', run)
    expect(result.status).toBe('pass')
    expect(result.evidence).toBeUndefined()
  })

  it('fails a broken/missing signature with remediation', async () => {
    const run = fakeRun({
      codesignVerify: {
        ok: false,
        code: 1,
        stdout: '',
        stderr: '/x/Demo.app: code object is not signed at all',
      },
    })
    const result = await checkCodeSigning('/x/Demo.app', run)
    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('not signed')
    expect(result.next_actions?.length).toBeGreaterThan(0)
  })

  it('is unknown when codesign cannot run (absent / non-macOS)', async () => {
    const result = await checkCodeSigning('/x/Demo.app', fakeRun({}))
    expect(result.status).toBe('unknown')
    expect(result.detail).toContain('macOS')
  })
})

describe('checkGatekeeper', () => {
  it('passes when spctl accepts the app', async () => {
    const run = fakeRun({
      spctl: { ok: true, code: 0, stdout: '', stderr: '/x/Demo.app: accepted' },
    })
    expect((await checkGatekeeper('/x/Demo.app', run)).status).toBe('pass')
  })

  it('fails when spctl rejects the app', async () => {
    const run = fakeRun({
      spctl: { ok: false, code: 3, stdout: '', stderr: '/x/Demo.app: rejected' },
    })
    const result = await checkGatekeeper('/x/Demo.app', run)
    expect(result.status).toBe('fail')
    expect(result.next_actions?.length).toBeGreaterThan(0)
  })

  it('is unknown when spctl cannot run', async () => {
    expect((await checkGatekeeper('/x/Demo.app', fakeRun({}))).status).toBe('unknown')
  })
})

describe('checkNotarization', () => {
  it('passes when a ticket is stapled and reports the spctl source as evidence', async () => {
    const run = fakeRun({
      staplerValidate: { ok: true, code: 0, stdout: 'The validate action worked!', stderr: '' },
      spctl: {
        ok: true,
        code: 0,
        stdout: '',
        stderr:
          '/x/Demo.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Acme (TEAMID)',
      },
    })
    const result = await checkNotarization('/x/Demo.app', run)
    expect(result.status).toBe('pass')
    expect(result.evidence).toBe('source=Notarized Developer ID')
  })

  it('still passes (without evidence) when the source read fails', async () => {
    // stapler validate succeeds, but the spctl source read is unconfigured -> command-not-found, so
    // the verdict is unchanged and no evidence is attached.
    const run = fakeRun({
      staplerValidate: { ok: true, code: 0, stdout: 'The validate action worked!', stderr: '' },
    })
    const result = await checkNotarization('/x/Demo.app', run)
    expect(result.status).toBe('pass')
    expect(result.evidence).toBeUndefined()
  })

  it('fails when no ticket is stapled, with remediation', async () => {
    const run = fakeRun({
      staplerValidate: {
        ok: false,
        code: 65,
        stdout: 'Processing: /x/Demo.app\nThe validate action failed! Error 65.',
        stderr: 'CloudKit query failed: the app does not have a ticket stapled to it.',
      },
    })
    const result = await checkNotarization('/x/Demo.app', run)
    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('ticket stapled')
    expect(result.next_actions?.length).toBeGreaterThan(0)
  })

  it('reads fail evidence from stdout when stderr is empty (stream varies by toolchain)', async () => {
    const run = fakeRun({
      staplerValidate: {
        ok: false,
        code: 65,
        stdout: 'The validate action failed! Error 65.',
        stderr: '',
      },
    })
    const result = await checkNotarization('/x/Demo.app', run)
    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('validate action failed')
  })

  it('is unknown when xcrun cannot run (absent / non-macOS)', async () => {
    const result = await checkNotarization('/x/Demo.app', fakeRun({}))
    expect(result.status).toBe('unknown')
    expect(result.detail).toContain('macOS')
  })

  it('is unknown when xcrun runs but cannot find stapler', async () => {
    const run = fakeRun({
      staplerValidate: {
        ok: false,
        code: 72,
        stdout: '',
        stderr: 'xcrun: error: unable to find utility "stapler", not a developer tool or in PATH',
      },
    })
    const result = await checkNotarization('/x/Demo.app', run)
    expect(result.status).toBe('unknown')
    expect(result.evidence).toContain('unable to find utility')
  })

  it('is unknown when the active developer path is invalid', async () => {
    const run = fakeRun({
      staplerValidate: {
        ok: false,
        code: 1,
        stdout: '',
        stderr:
          'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun',
      },
    })
    const result = await checkNotarization('/x/Demo.app', run)
    expect(result.status).toBe('unknown')
    expect(result.evidence).toContain('invalid active developer path')
  })
})

describe('runChecks', () => {
  it('runs all checks in canonical order by default', async () => {
    const results = await runChecks(await makeApp(), fakeRun({}))
    expect(results.map((r) => r.id)).toEqual([...CHECK_IDS])
  })

  it('runs only the requested subset, still in canonical order and deduped', async () => {
    const results = await runChecks(await makeApp(), fakeRun({}), [
      'gatekeeper',
      'bundle-structure',
      'gatekeeper',
    ])
    expect(results.map((r) => r.id)).toEqual(['bundle-structure', 'gatekeeper'])
  })

  it('runs notarization alone, independent of the other checks', async () => {
    const results = await runChecks(await makeApp(), fakeRun({}), ['notarization'])
    expect(results.map((r) => r.id)).toEqual(['notarization'])
  })
})
