/** In-process contract coverage for safe visual baseline operations. */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { StagewrightServer, TransportCapabilities } from '@electron-stagewright/core'
import {
  FakeSession,
  fullCapabilities,
  TestLifecycle,
  type FakeSessionOptions,
} from '@electron-stagewright/testkit'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'

import packageJson from '../package.json' with { type: 'json' }
import visualPlugin from '../src/index.js'

const lifecycle = new TestLifecycle()
const directories = new Set<string>()
afterEach(async () => {
  await lifecycle.cleanup()
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  )
  directories.clear()
})

interface VisualRoots {
  readonly baselineDir: string
  readonly artifactsDir: string
}

async function roots(): Promise<VisualRoots> {
  const root = await mkdtemp(path.join(tmpdir(), 'stagewright-visual-'))
  directories.add(root)
  return { baselineDir: path.join(root, 'baselines'), artifactsDir: path.join(root, 'artifacts') }
}

function png(red: number, width = 2, height = 1): Buffer {
  const image = new PNG({ width, height, fill: true })
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = red
    image.data[index + 1] = 20
    image.data[index + 2] = 30
    image.data[index + 3] = 255
  }
  return PNG.sync.write(image)
}

function oversizedPngHeader(): Buffer {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(4_001, 16)
  header.writeUInt32BE(4_000, 20)
  return header
}

function session(
  screenshot: Buffer,
  opts: {
    readonly colorScheme?: 'dark' | 'light' | 'no-preference'
    readonly masksTruncated?: boolean
    readonly preparation?: unknown
    readonly surfaces?: FakeSessionOptions['surfaces']
  } = {},
): FakeSession {
  return new FakeSession({
    screenshotResult: screenshot,
    windows: [{ id: 'window-1', index: 0, title: 'Visual fixture', visible: true, focused: true }],
    ...(opts.surfaces !== undefined ? { surfaces: opts.surfaces } : {}),
    evaluate: async (_target, body) => {
      if (body.includes('const input = arg')) {
        return (
          opts.preparation ?? {
            kind: 'prepared',
            masksTruncated: opts.masksTruncated ?? false,
            environment: {
              electronVersion: '42.3.0',
              userAgent: 'VisualFixture Electron/42.3.0',
              viewport: { width: 800, height: 600 },
              devicePixelRatio: 1,
              colorScheme: opts.colorScheme ?? 'light',
              locale: 'en-US',
            },
          }
        )
      }
      return { cleaned: true }
    },
  })
}

async function open(
  roots: VisualRoots,
  current: FakeSession,
  opts: { readonly capabilities?: TransportCapabilities; readonly fontFingerprint?: string } = {},
): Promise<StagewrightServer> {
  const { server } = await lifecycle.createPluginTestServer(visualPlugin, {
    session: current,
    capabilities: opts.capabilities ?? fullCapabilities(),
    pluginConfigs: {
      visual: {
        ...roots,
        ...(opts.fontFingerprint !== undefined ? { fontFingerprint: opts.fontFingerprint } : {}),
      },
    },
  })
  return server
}

async function launch(server: StagewrightServer): Promise<string> {
  return lifecycle.launch(server)
}

describe('visual plugin (in-process)', () => {
  it('advertises its explicit roots, BrowserWindow contract, and non-eval-gated tools', async () => {
    const configured = await roots()
    const server = await open(configured, session(png(10)), { fontFingerprint: 'fonts-v1' })
    expect(await server.dispatcher.dispatch('electron_plugins', {})).toMatchObject({
      ok: true,
      plugins: [
        {
          name: 'visual',
          version: packageJson.version,
          tools: [
            { name: 'visual_capture', state: 'enabled' },
            { name: 'visual_expect', state: 'enabled' },
            { name: 'visual_update_baseline', state: 'enabled' },
          ],
          requirements: {
            transportCapabilities: ['supportsRendererEval', 'supportsSurfaceTargeting'],
          },
          effectiveConfig: {
            baselineDir: configured.baselineDir,
            artifactsDir: configured.artifactsDir,
            fontFingerprint: 'fonts-v1',
          },
        },
      ],
    })
    for (const name of ['visual_capture', 'visual_expect', 'visual_update_baseline']) {
      const manifest = server.dispatcher.listManifest().find((entry) => entry.name === name)
      expect(manifest?.requiresEvalFlag).toBeUndefined()
    }
  })

  it('keeps capture, explicit baseline update, and matching expectation separate', async () => {
    const configured = await roots()
    const current = session(png(10), { masksTruncated: true })
    const server = await open(configured, current, { fontFingerprint: 'fonts-v1' })
    const sessionId = await launch(server)

    const capture = await server.dispatcher.dispatch('visual_capture', {
      sessionId,
      name: 'checkout',
      masks: ['.clock'],
    })
    expect(capture).toMatchObject({
      ok: true,
      surface_id: '__default__',
      masks_truncated: true,
      artifact: { path: expect.stringContaining('.capture.png') },
    })
    await expect(readdir(configured.baselineDir)).rejects.toMatchObject({ code: 'ENOENT' })

    expect(
      await server.dispatcher.dispatch('visual_expect', { sessionId, name: 'checkout' }),
    ).toMatchObject({ ok: false, code: 'visual.BASELINE_NOT_FOUND' })

    const updated = await server.dispatcher.dispatch('visual_update_baseline', {
      sessionId,
      name: 'checkout',
      confirm: true,
      masks: ['.clock'],
    })
    expect(updated).toMatchObject({ ok: true, baseline: { replaced: true } })

    expect(
      await server.dispatcher.dispatch('visual_expect', {
        sessionId,
        name: 'checkout',
        masks: ['.clock'],
      }),
    ).toMatchObject({ ok: true, matched: true, diff_pixels: 0, diff_ratio: 0 })
    expect(current.screenshotCalls).toHaveLength(3)
    expect(current.screenshotCalls[0]).toMatchObject({ target: { kind: 'id', id: 'window-1' } })
  })

  it('requires the literal confirmation field before replacing a baseline', async () => {
    const configured = await roots()
    const server = await open(configured, session(png(10)))
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('visual_update_baseline', {
        sessionId,
        name: 'checkout',
        confirm: false,
      }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
  })

  it('writes unique actual and diff artifacts for mismatches without changing the baseline', async () => {
    const configured = await roots()
    const baselineServer = await open(configured, session(png(10)))
    const baselineSessionId = await launch(baselineServer)
    await expect(
      baselineServer.dispatcher.dispatch('visual_update_baseline', {
        sessionId: baselineSessionId,
        name: 'checkout',
        confirm: true,
      }),
    ).resolves.toMatchObject({ ok: true })
    const baselineBefore = await readFile(path.join(configured.baselineDir, 'checkout.png'))

    const comparisonServer = await open(configured, session(png(240)))
    const comparisonSessionId = await launch(comparisonServer)
    const results = await Promise.all(
      [1, 2].map(() =>
        comparisonServer.dispatcher.dispatch('visual_expect', {
          sessionId: comparisonSessionId,
          name: 'checkout',
        }),
      ),
    )
    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        code: 'visual.MISMATCH',
        details: {
          diff_pixels: expect.any(Number),
          actual_path: expect.stringMatching(/\.mismatch[\\/]actual\.png$/),
          diff_path: expect.stringMatching(/\.mismatch[\\/]diff\.png$/),
        },
      })
    }
    const artifacts = await readdir(configured.artifactsDir)
    expect(artifacts.filter((entry) => entry.endsWith('.mismatch'))).toHaveLength(2)
    await expect(
      Promise.all(
        artifacts.map(async (entry) =>
          readdir(path.join(configured.artifactsDir, entry)).then((files) => files.sort()),
        ),
      ),
    ).resolves.toEqual([
      ['actual.png', 'diff.png'],
      ['actual.png', 'diff.png'],
    ])
    await expect(readFile(path.join(configured.baselineDir, 'checkout.png'))).resolves.toEqual(
      baselineBefore,
    )
  })

  it('rejects environment or capture-profile differences before computing a diff', async () => {
    const configured = await roots()
    const baselineServer = await open(configured, session(png(10), { colorScheme: 'light' }))
    const baselineSessionId = await launch(baselineServer)
    await baselineServer.dispatcher.dispatch('visual_update_baseline', {
      sessionId: baselineSessionId,
      name: 'checkout',
      confirm: true,
    })

    const comparisonServer = await open(configured, session(png(10), { colorScheme: 'dark' }))
    const comparisonSessionId = await launch(comparisonServer)
    expect(
      await comparisonServer.dispatcher.dispatch('visual_expect', {
        sessionId: comparisonSessionId,
        name: 'checkout',
      }),
    ).toMatchObject({
      ok: false,
      code: 'visual.ENV_MISMATCH',
      details: { fields: expect.arrayContaining(['environment.colorScheme']) },
    })
    await expect(readdir(configured.artifactsDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an externally substituted symlink or mismatched metadata sidecar', async () => {
    const configured = await roots()
    const server = await open(configured, session(png(10)))
    const sessionId = await launch(server)
    await server.dispatcher.dispatch('visual_update_baseline', {
      sessionId,
      name: 'checkout',
      confirm: true,
    })
    const outside = path.join(path.dirname(configured.baselineDir), 'outside.png')
    await writeFile(outside, png(240))
    await rm(path.join(configured.baselineDir, 'checkout.png'))
    await symlink(outside, path.join(configured.baselineDir, 'checkout.png'))
    expect(
      await server.dispatcher.dispatch('visual_expect', { sessionId, name: 'checkout' }),
    ).toMatchObject({ ok: false, code: 'visual.PATH_INVALID' })

    await rm(path.join(configured.baselineDir, 'checkout.png'))
    await writeFile(path.join(configured.baselineDir, 'checkout.png'), png(10))
    await writeFile(path.join(configured.baselineDir, 'checkout.meta.json'), '{"bad":true}\n')
    expect(
      await server.dispatcher.dispatch('visual_expect', { sessionId, name: 'checkout' }),
    ).toMatchObject({ ok: false, code: 'visual.BASELINE_INVALID' })
  })

  it('rejects an unreadable verified baseline before checking its environment', async () => {
    const configured = await roots()
    const baselineServer = await open(configured, session(png(10), { colorScheme: 'light' }))
    const baselineSessionId = await launch(baselineServer)
    await baselineServer.dispatcher.dispatch('visual_update_baseline', {
      sessionId: baselineSessionId,
      name: 'checkout',
      confirm: true,
    })
    const corrupt = Buffer.from('not a png')
    const sidecarPath = path.join(configured.baselineDir, 'checkout.meta.json')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as { image: { sha256: string } }
    sidecar.image.sha256 = createHash('sha256').update(corrupt).digest('hex')
    await writeFile(path.join(configured.baselineDir, 'checkout.png'), corrupt)
    await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`)

    const comparisonServer = await open(configured, session(png(10), { colorScheme: 'dark' }))
    const comparisonSessionId = await launch(comparisonServer)
    expect(
      await comparisonServer.dispatcher.dispatch('visual_expect', {
        sessionId: comparisonSessionId,
        name: 'checkout',
      }),
    ).toMatchObject({ ok: false, code: 'visual.BASELINE_INVALID' })
  })

  it('preserves core session errors and rejects an unconfigured root before capture', async () => {
    const configured = await roots()
    const missingSession = await open(configured, session(png(10)))
    expect(
      await missingSession.dispatcher.dispatch('visual_capture', {
        sessionId: 'stopped-session',
        name: 'checkout',
      }),
    ).toMatchObject({ ok: false, code: 'NOT_RUNNING' })

    const current = session(png(10))
    const { server } = await lifecycle.createPluginTestServer(visualPlugin, {
      session: current,
      capabilities: fullCapabilities(),
    })
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('visual_capture', { sessionId, name: 'checkout' }),
    ).toMatchObject({ ok: false, code: 'visual.PATH_INVALID' })
    expect(current.screenshotCalls).toHaveLength(0)
  })

  it('rejects an oversized PNG header before image decoding allocates its pixel buffer', async () => {
    const configured = await roots()
    const server = await open(configured, session(oversizedPngHeader()))
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('visual_capture', { sessionId, name: 'checkout' }),
    ).toMatchObject({ ok: false, code: 'visual.IMAGE_TOO_LARGE' })
  })

  it('rejects capture CSS that could load an external resource', async () => {
    const configured = await roots()
    const server = await open(configured, session(png(10)))
    const sessionId = await launch(server)
    expect(
      await server.dispatcher.dispatch('visual_capture', {
        sessionId,
        name: 'checkout',
        style: "body { background: url('https://example.test/track'); }",
      }),
    ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
  })

  it('fails clearly for unsupported capabilities, non-window surfaces, invalid selectors, and unstable preparation', async () => {
    const configured = await roots()
    const unsupported = await open(configured, session(png(10)), {
      capabilities: fullCapabilities({ supportsRendererEval: false }),
    })
    const unsupportedId = await launch(unsupported)
    expect(
      await unsupported.dispatcher.dispatch('visual_capture', {
        sessionId: unsupportedId,
        name: 'checkout',
      }),
    ).toMatchObject({ ok: false, code: 'visual.UNSUPPORTED' })

    const frame = await open(
      configured,
      session(png(10), {
        surfaces: [
          {
            id: 'frame-1',
            kind: 'frame',
            active: true,
            capabilities: { snapshot: true, interaction: true, rendererEval: true },
          },
        ],
      }),
    )
    const frameId = await launch(frame)
    expect(
      await frame.dispatcher.dispatch('visual_capture', { sessionId: frameId, name: 'checkout' }),
    ).toMatchObject({ ok: false, code: 'visual.SURFACE_UNSUPPORTED' })

    const invalid = await open(
      configured,
      session(png(10), {
        preparation: { kind: 'invalid_selector', selector: '[', message: 'bad selector' },
      }),
    )
    const invalidId = await launch(invalid)
    expect(
      await invalid.dispatcher.dispatch('visual_capture', {
        sessionId: invalidId,
        name: 'checkout',
        masks: ['['],
      }),
    ).toMatchObject({ ok: false, code: 'visual.INVALID_SELECTOR' })

    const unstable = await open(configured, session(png(10), { preparation: { kind: 'unstable' } }))
    const unstableId = await launch(unstable)
    expect(
      await unstable.dispatcher.dispatch('visual_capture', {
        sessionId: unstableId,
        name: 'checkout',
      }),
    ).toMatchObject({ ok: false, code: 'visual.UNSTABLE' })
  })
})
