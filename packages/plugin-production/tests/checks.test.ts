/**
 * Unit tests for the production checks (ADR-012). The shell-out checks run against a fake
 * {@link RunCommand} so every branch — pass / fail / unknown — is exercised on any OS without the
 * macOS toolchain; the bundle check runs against a synthetic .app on disk.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { afterEach, describe, expect, it } from 'vitest'

import {
  checkBundleStructure,
  checkCodeSigning,
  checkCrashReporter,
  checkGatekeeper,
  checkInfoPlist,
  checkNotarization,
  checkProtocolSchemes,
  checkUpdaterFeed,
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
 * stub replayed for both. `xcrun stapler validate` (notarization) is keyed as `staplerValidate`,
 * `plutil -convert json` (info-plist) as `plutil`; `spctl` doubles as the gatekeeper check AND the
 * notarization-pass evidence read. Anything unconfigured resolves to command-not-found.
 */
function fakeRun(plan: {
  codesignVerify?: CommandResult
  codesignDisplay?: CommandResult
  staplerValidate?: CommandResult
  plutil?: CommandResult
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
    if (command === 'plutil') return Promise.resolve(plan.plutil ?? NOT_FOUND)
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

describe('checkInfoPlist', () => {
  /** A clean `plutil -convert json` result for a well-formed Info.plist, with optional overrides. */
  const okPlist = (overrides: Record<string, unknown> = {}): CommandResult => ({
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      CFBundleIdentifier: 'com.example.demo',
      CFBundleShortVersionString: '1.2.3',
      CFBundleExecutable: 'Demo',
      CFBundleName: 'Demo',
      CFBundleVersion: '42',
      ...overrides,
    }),
    stderr: '',
  })

  it('passes when the required fields are present and the executable exists', async () => {
    const app = await makeApp() // writes Contents/MacOS/Demo
    const result = await checkInfoPlist(app, fakeRun({ plutil: okPlist() }))
    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('com.example.demo')
    expect(result.evidence).toContain('1.2.3')
  })

  it('passes a minimal plist with only the required keys (evidence omits build/name)', async () => {
    const app = await makeApp()
    const plutil: CommandResult = {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        CFBundleIdentifier: 'com.example.demo',
        CFBundleShortVersionString: '1.2.3',
        CFBundleExecutable: 'Demo',
      }),
      stderr: '',
    }
    const result = await checkInfoPlist(app, fakeRun({ plutil }))
    expect(result.status).toBe('pass')
    expect(result.evidence).toBe('com.example.demo v1.2.3')
  })

  it('fails when a required key is missing', async () => {
    const app = await makeApp()
    const plutil: CommandResult = {
      ok: true,
      code: 0,
      // No CFBundleShortVersionString.
      stdout: JSON.stringify({
        CFBundleIdentifier: 'com.example.demo',
        CFBundleExecutable: 'Demo',
      }),
      stderr: '',
    }
    const result = await checkInfoPlist(app, fakeRun({ plutil }))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('CFBundleShortVersionString')
  })

  it('fails when CFBundleIdentifier is not reverse-DNS', async () => {
    const app = await makeApp()
    const result = await checkInfoPlist(
      app,
      fakeRun({ plutil: okPlist({ CFBundleIdentifier: 'notreversedns' }) }),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('reverse-DNS')
  })

  it('fails when the declared CFBundleExecutable is not on disk', async () => {
    const app = await makeApp() // has MacOS/Demo, but the plist names Ghost
    const result = await checkInfoPlist(
      app,
      fakeRun({ plutil: okPlist({ CFBundleExecutable: 'Ghost' }) }),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('Ghost')
  })

  it('fails when CFBundleExecutable is a path instead of a file name', async () => {
    const app = await makeApp()
    await mkdir(path.join(app, 'Contents', 'Resources'), { recursive: true })
    await writeFile(path.join(app, 'Contents', 'Resources', 'Ghost'), '#!/bin/sh\n')
    const result = await checkInfoPlist(
      app,
      fakeRun({ plutil: okPlist({ CFBundleExecutable: '../Resources/Ghost' }) }),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('must be a file name')
  })

  it('fails when plutil cannot parse the plist (missing/malformed)', async () => {
    const plutil: CommandResult = {
      ok: false,
      code: 1,
      stdout: '',
      stderr: 'Demo.app/Contents/Info.plist: Property List error: Unexpected character at line 1.',
    }
    const result = await checkInfoPlist('/x/Demo.app', fakeRun({ plutil }))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('parse')
  })

  it('fails when the plist root is not a dictionary', async () => {
    const plutil: CommandResult = { ok: true, code: 0, stdout: '[1, 2, 3]', stderr: '' }
    const result = await checkInfoPlist('/x/Demo.app', fakeRun({ plutil }))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('dictionary')
  })

  it('is unknown when plutil exits cleanly but emits non-JSON', async () => {
    const plutil: CommandResult = { ok: true, code: 0, stdout: 'not json at all', stderr: '' }
    const result = await checkInfoPlist('/x/Demo.app', fakeRun({ plutil }))
    expect(result.status).toBe('unknown')
  })

  it('is unknown when plutil exits cleanly but writes nothing', async () => {
    const plutil: CommandResult = { ok: true, code: 0, stdout: '', stderr: '' }
    const result = await checkInfoPlist('/x/Demo.app', fakeRun({ plutil }))
    expect(result.status).toBe('unknown')
  })

  it('fails with stdout evidence when plutil errors only to stdout', async () => {
    const plutil: CommandResult = {
      ok: false,
      code: 1,
      stdout: 'Info.plist: malformed on stdout',
      stderr: '',
    }
    const result = await checkInfoPlist('/x/Demo.app', fakeRun({ plutil }))
    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('malformed on stdout')
  })

  it('is unknown when plutil cannot run (absent / non-macOS)', async () => {
    const result = await checkInfoPlist('/x/Demo.app', fakeRun({}))
    expect(result.status).toBe('unknown')
    expect(result.detail).toContain('macOS')
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

describe('checkProtocolSchemes', () => {
  /** A clean plutil result whose plist declares `urlTypes` (omit the key entirely when undefined). */
  const plistWith = (urlTypes?: unknown): CommandResult => ({
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      CFBundleIdentifier: 'com.example.demo',
      ...(urlTypes !== undefined ? { CFBundleURLTypes: urlTypes } : {}),
    }),
    stderr: '',
  })

  it('passes well-formed declarations and lists the schemes as evidence', async () => {
    const run = fakeRun({
      plutil: plistWith([
        { CFBundleURLName: 'Demo links', CFBundleURLSchemes: ['demo', 'demo-dev'] },
      ]),
    })
    const result = await checkProtocolSchemes('/x/Demo.app', run)
    expect(result).toMatchObject({ id: 'protocol-schemes', status: 'pass' })
    expect(result.evidence).toBe('demo, demo-dev')
  })

  it('passes when CFBundleURLTypes is absent (no custom schemes is a verified outcome)', async () => {
    const result = await checkProtocolSchemes('/x/Demo.app', fakeRun({ plutil: plistWith() }))
    expect(result.status).toBe('pass')
    expect(result.detail).toContain('no custom URL schemes')
  })

  it('passes when CFBundleURLTypes is an empty array', async () => {
    const result = await checkProtocolSchemes('/x/Demo.app', fakeRun({ plutil: plistWith([]) }))
    expect(result.status).toBe('pass')
  })

  it('fails when CFBundleURLTypes is not an array', async () => {
    const result = await checkProtocolSchemes(
      '/x/Demo.app',
      fakeRun({ plutil: plistWith({ CFBundleURLSchemes: ['demo'] }) }),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('not an array')
  })

  it('fails when an entry is not a dictionary', async () => {
    const result = await checkProtocolSchemes(
      '/x/Demo.app',
      fakeRun({ plutil: plistWith(['demo']) }),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('entry 0 is not a dictionary')
  })

  it('fails when an entry has no (or an empty) CFBundleURLSchemes array', async () => {
    const result = await checkProtocolSchemes(
      '/x/Demo.app',
      fakeRun({ plutil: plistWith([{ CFBundleURLName: 'x', CFBundleURLSchemes: [] }]) }),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('no CFBundleURLSchemes')
  })

  it('fails non-string and shape-invalid schemes', async () => {
    const result = await checkProtocolSchemes(
      '/x/Demo.app',
      fakeRun({ plutil: plistWith([{ CFBundleURLSchemes: [42, 'my app'] }]) }),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('non-string')
    expect(result.detail).toContain('RFC 3986')
  })

  it('fails a scheme that shadows a well-known system scheme', async () => {
    const result = await checkProtocolSchemes(
      '/x/Demo.app',
      fakeRun({ plutil: plistWith([{ CFBundleURLSchemes: ['HTTPS'] }]) }),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('shadows a well-known system scheme')
  })

  it('fails a scheme declared more than once (across entries, case-insensitive)', async () => {
    const result = await checkProtocolSchemes(
      '/x/Demo.app',
      fakeRun({
        plutil: plistWith([{ CFBundleURLSchemes: ['demo'] }, { CFBundleURLSchemes: ['Demo'] }]),
      }),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('declared more than once')
  })

  it('clips an oversized (but shape-valid) scheme in the evidence without changing the verdict', async () => {
    const longScheme = `x${'a'.repeat(400)}`
    const result = await checkProtocolSchemes(
      '/x/Demo.app',
      fakeRun({ plutil: plistWith([{ CFBundleURLSchemes: [longScheme] }]) }),
    )
    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('…')
    expect((result.evidence ?? '').length).toBeLessThan(longScheme.length)
  })

  it('caps the evidence list and reports the elision', async () => {
    const schemes = Array.from({ length: 10 }, (_, i) => `demo${i}`)
    const result = await checkProtocolSchemes(
      '/x/Demo.app',
      fakeRun({ plutil: plistWith([{ CFBundleURLSchemes: schemes }]) }),
    )
    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('(+2 more)')
    expect(result.evidence).not.toContain('demo9')
  })

  it('fails when plutil cannot parse the plist, independent of the info-plist check', async () => {
    const plutil: CommandResult = { ok: false, code: 1, stdout: '', stderr: 'malformed' }
    const result = await checkProtocolSchemes('/x/Demo.app', fakeRun({ plutil }))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('parse')
  })

  it('is unknown when plutil cannot run (absent / non-macOS)', async () => {
    const result = await checkProtocolSchemes('/x/Demo.app', fakeRun({}))
    expect(result.status).toBe('unknown')
    expect(result.detail).toContain('macOS')
  })
})

describe('checkUpdaterFeed', () => {
  /** Build a synthetic app with an optional `Contents/Resources/app-update.yml` body. */
  async function makeAppWithFeed(yml?: string): Promise<string> {
    const app = await makeApp()
    if (yml !== undefined) {
      await mkdir(path.join(app, 'Contents', 'Resources'), { recursive: true })
      await writeFile(path.join(app, 'Contents', 'Resources', 'app-update.yml'), yml)
    }
    return app
  }

  it('is unknown when app-update.yml is absent (runtime feeds are not statically visible)', async () => {
    const result = await checkUpdaterFeed(await makeAppWithFeed())
    expect(result).toMatchObject({ id: 'updater-feed', status: 'unknown' })
    expect(result.detail).toContain('app-update.yml is absent')
  })

  it('fails when app-update.yml exists but is empty', async () => {
    const result = await checkUpdaterFeed(await makeAppWithFeed('  \n'))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('empty')
  })

  it('fails when app-update.yml is not a regular file', async () => {
    const app = await makeAppWithFeed()
    await mkdir(path.join(app, 'Contents', 'Resources', 'app-update.yml'), { recursive: true })
    const result = await checkUpdaterFeed(app)
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('not a regular file')
  })

  it('passes a generic provider with an https url, with provider and url as evidence', async () => {
    const result = await checkUpdaterFeed(
      await makeAppWithFeed('provider: generic\nurl: https://updates.example.com/stable\n'),
    )
    expect(result.status).toBe('pass')
    expect(result.evidence).toBe('provider=generic url=https://updates.example.com/stable')
  })

  it('fails a generic provider that declares no url', async () => {
    const result = await checkUpdaterFeed(await makeAppWithFeed('provider: generic\n'))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('requires url')
  })

  it('passes a github provider with owner and repo (and channel in evidence)', async () => {
    const result = await checkUpdaterFeed(
      await makeAppWithFeed('provider: github\nowner: acme\nrepo: demo\nchannel: beta\n'),
    )
    expect(result.status).toBe('pass')
    expect(result.evidence).toBe('provider=github owner=acme repo=demo channel=beta')
  })

  it('fails a github provider missing owner or repo', async () => {
    const result = await checkUpdaterFeed(await makeAppWithFeed('provider: github\nowner: acme\n'))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('requires repo')
  })

  it('fails an s3 provider without a bucket', async () => {
    const result = await checkUpdaterFeed(await makeAppWithFeed('provider: s3\n'))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('requires bucket')
  })

  it('fails an http (non-https) feed url with the ATS rationale', async () => {
    const result = await checkUpdaterFeed(
      await makeAppWithFeed('provider: generic\nurl: http://updates.example.com\n'),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('not https')
    expect(result.detail).toContain('Transport Security')
  })

  it('fails an unparseable url', async () => {
    const result = await checkUpdaterFeed(
      await makeAppWithFeed('provider: generic\nurl: not a url\n'),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('not a valid URL')
  })

  it('passes an unrecognised provider on presence alone (forward-compatible)', async () => {
    const result = await checkUpdaterFeed(await makeAppWithFeed('provider: keygen\n'))
    expect(result.status).toBe('pass')
    expect(result.evidence).toBe('provider=keygen')
  })

  it('classifies a provider colliding with Object.prototype members instead of crashing', async () => {
    // A bare lookup into the provider matrix would resolve __proto__/constructor/
    // toString to inherited non-arrays and throw; the check must return a result.
    for (const hostile of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const result = await checkUpdaterFeed(await makeAppWithFeed(`provider: ${hostile}\n`))
      expect(result.status).toBe('pass')
      expect(result.evidence).toBe(`provider=${hostile}`)
    }
  })

  it('clips oversized field values in the evidence, not only the url', async () => {
    const bigBucket = 'b'.repeat(500)
    const result = await checkUpdaterFeed(
      await makeAppWithFeed(`provider: s3\nbucket: ${bigBucket}\n`),
    )
    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('bucket=')
    expect(result.evidence).toContain('…')
    expect((result.evidence ?? '').length).toBeLessThan(bigBucket.length)
  })

  it('strips surrounding quotes from YAML values', async () => {
    const result = await checkUpdaterFeed(
      await makeAppWithFeed('provider: \'generic\'\nurl: "https://updates.example.com"\n'),
    )
    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('url=https://updates.example.com')
  })

  it('fails an implausibly large app-update.yml without reading it into memory', async () => {
    const result = await checkUpdaterFeed(
      await makeAppWithFeed(`provider: generic\n${'#'.repeat(300 * 1024)}\n`),
    )
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('implausibly large')
  })

  it('truncates an oversized feed url in the evidence', async () => {
    const longUrl = `https://updates.example.com/${'a'.repeat(150)}`
    const result = await checkUpdaterFeed(
      await makeAppWithFeed(`provider: generic\nurl: ${longUrl}\n`),
    )
    expect(result.status).toBe('pass')
    expect(result.evidence?.length).toBeLessThan(longUrl.length)
    expect(result.evidence).toContain('…')
  })
})

describe('checkCrashReporter', () => {
  /** Build a synthetic app with the Electron Framework layout (handler optional, mode-settable). */
  async function makeElectronApp(opts: {
    framework?: boolean
    handler?: boolean
    mode?: number
    version?: string
  }): Promise<string> {
    const app = await makeApp()
    if (opts.framework === false) return app
    const helpers = path.join(
      app,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      opts.version ?? 'A',
      'Helpers',
    )
    await mkdir(helpers, { recursive: true })
    if (opts.handler !== false) {
      await writeFile(path.join(helpers, 'chrome_crashpad_handler'), '\x7fELF', {
        mode: opts.mode ?? 0o755,
      })
    }
    return app
  }

  it('passes when the crashpad handler ships executable, with its bundle path as evidence', async () => {
    const result = await checkCrashReporter(await makeElectronApp({}))
    expect(result).toMatchObject({ id: 'crash-reporter', status: 'pass' })
    expect(result.evidence).toBe(path.join('Versions', 'A', 'Helpers', 'chrome_crashpad_handler'))
    expect(result.detail).toContain('runtime configuration')
  })

  it('finds the handler in a non-A framework version directory', async () => {
    const result = await checkCrashReporter(await makeElectronApp({ version: 'B' }))
    expect(result.status).toBe('pass')
  })

  it('is unknown when there is no Electron Framework (not an Electron-shaped bundle)', async () => {
    const result = await checkCrashReporter(await makeElectronApp({ framework: false }))
    expect(result.status).toBe('unknown')
    expect(result.detail).toContain('does not look like a packaged Electron app')
  })

  it('fails when the framework is present but the handler is missing', async () => {
    const result = await checkCrashReporter(await makeElectronApp({ handler: false }))
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('chrome_crashpad_handler')
    expect(result.next_actions?.length).toBeGreaterThan(0)
  })

  it('fails when the framework exists but its Versions directory is missing', async () => {
    const app = await makeApp()
    await mkdir(path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework'), {
      recursive: true,
    })
    const result = await checkCrashReporter(app)
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('Versions')
  })

  it.skipIf(process.platform === 'win32')(
    'fails when the handler lost its execute bit (zip-roundtrip repackaging)',
    async () => {
      const result = await checkCrashReporter(await makeElectronApp({ mode: 0o644 }))
      expect(result.status).toBe('fail')
      expect(result.detail).toContain('not executable')
    },
  )
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
