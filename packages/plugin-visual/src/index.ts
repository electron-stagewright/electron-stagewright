/**
 * `@electron-stagewright/plugin-visual` — explicit, root-confined visual
 * baseline capture and comparison for selected Electron BrowserWindow surfaces.
 */

import { randomUUID } from 'node:crypto'
import process from 'node:process'

import {
  defineTool,
  makePluginError,
  makeSuccess,
  readPackageVersion,
  withProgressPhases,
  type AnyToolDefinition,
  type StagewrightPlugin,
  type ToolContext,
  type ToolResult,
} from '@electron-stagewright/core'
import {
  createPluginConfigState,
  createSessionCleanup,
  requireTransportCapability,
  sessionIdField,
} from '@electron-stagewright/core/plugin-sdk'
import { z } from 'zod'

import {
  CLEANUP_CAPTURE_BODY,
  PREPARE_CAPTURE_BODY,
  type AnimationMode,
  type CapturePreparationResult,
  type CaretMode,
} from './capture.js'
import {
  assertImageBounds,
  captureProfileHash,
  comparePngs,
  decodePng,
  incompatibleMetadata,
  sha256,
  type VisualMetadata,
  type VisualEnvironment,
  VisualImageError,
  VisualImageLimitError,
} from './image.js'
import {
  artifactStem,
  assertVisualName,
  canonicalRoot,
  readConfinedFile,
  VisualBaselineMissingError,
  VisualPathError,
  writeConfinedAtomically,
  writeConfinedMismatchPairAtomically,
} from './storage.js'

const VISUAL_NAMESPACE = 'visual'
const VISUAL_PLUGIN_VERSION = readPackageVersion(import.meta.url)
const VISUAL_INTROSPECTION = {
  requirements: { transportCapabilities: ['supportsRendererEval', 'supportsSurfaceTargeting'] },
  config: { safeFields: ['baselineDir', 'artifactsDir', 'fontFingerprint'] },
} as const

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const selectorSchema = z.string().trim().min(1).max(512)
const styleSchema = z
  .string()
  .max(8_000)
  .refine((style) => !/(?:@import\b|\burl\s*\()/i.test(style), {
    message: 'Visual capture style cannot import or load external resources.',
  })
const captureOptions = {
  name: nameSchema.describe('Stable root-level baseline name; not a path.'),
  fullPage: z.boolean().default(false).describe('Capture the full scrollable BrowserWindow page.'),
  animations: z
    .enum(['disabled', 'allow'])
    .default('disabled')
    .describe('Disable CSS animations and transitions during capture by default.'),
  caret: z
    .enum(['hide', 'initial'])
    .default('hide')
    .describe('Hide the text caret during capture by default.'),
  style: z
    .optional(styleSchema)
    .describe(
      'Bounded CSS applied only for this capture, then removed; resource-loading CSS is rejected.',
    ),
  masks: z
    .array(selectorSchema)
    .max(20)
    .default([])
    .describe('CSS selectors covered by temporary diagnostic masks; at most 20 selectors.'),
  settleMs: z
    .number()
    .int()
    .min(0)
    .max(5_000)
    .default(100)
    .describe('Bounded layout settle delay after two animation frames. Default 100 ms.'),
} as const

const captureSchema = z.object({ ...captureOptions, ...sessionIdField })
const expectSchema = z.object({
  ...captureOptions,
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe('Perceptual pixel threshold from 0 (strict) to 1. Default 0.1.'),
  maxDiffPixels: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .default(0)
    .describe('Maximum differing pixels allowed before mismatch. Default 0.'),
  maxDiffRatio: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Maximum differing-pixel ratio allowed before mismatch. Default 0.'),
  ...sessionIdField,
})
const updateSchema = z.object({
  ...captureOptions,
  confirm: z.literal(true).describe('Required explicit confirmation before replacing a baseline.'),
  ...sessionIdField,
})

const visualConfigSchema = z
  .object({
    baselineDir: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Absolute root directory for accepted baseline PNGs; required before comparison or update.',
      ),
    artifactsDir: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Absolute root directory for captures and mismatch artifacts; required before capture.',
      ),
    fontFingerprint: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'Optional operator-owned font-environment fingerprint required to match a baseline.',
      ),
  })
  .strict()

type VisualConfig = z.infer<typeof visualConfigSchema>
type CaptureArgs = z.infer<typeof captureSchema>
type ExpectArgs = z.infer<typeof expectSchema>
type UpdateArgs = z.infer<typeof updateSchema>

interface CapturedVisual {
  readonly sessionId: string
  readonly surfaceId: string
  readonly screenshot: Buffer
  readonly metadata: VisualMetadata
  readonly masksTruncated: boolean
}

/** Serialize calls by key so temporary renderer preparation and baseline sidecars cannot interleave. */
class KeyedSerial {
  readonly #tails = new Map<string, Promise<void>>()

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release: (() => void) | undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.#tails.set(key, tail)
    await previous
    try {
      return await work()
    } finally {
      release?.()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }

  delete(key: string): void {
    this.#tails.delete(key)
  }

  clear(): void {
    this.#tails.clear()
  }
}

/** Create a fresh visual plugin instance for one Stagewright server. */
export function createVisualPlugin(): StagewrightPlugin {
  const config = createPluginConfigState<VisualConfig>({})
  const sessionSerial = new KeyedSerial()
  const baselineSerial = new KeyedSerial()
  const sessionCleanup = createSessionCleanup(
    (sessionId) => sessionSerial.delete(sessionId),
    () => {
      sessionSerial.clear()
      baselineSerial.clear()
      config.reset()
    },
  )

  async function capture(
    args: CaptureArgs | ExpectArgs | UpdateArgs,
    ctx: ToolContext,
    managed: ReturnType<ToolContext['sessions']['resolve']>,
  ): Promise<CapturedVisual | ToolResult> {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    for (const capability of ['supportsRendererEval', 'supportsSurfaceTargeting'] as const) {
      const support = requireTransportCapability(managed.transport.capabilities, capability, () =>
        makePluginError('visual.UNSUPPORTED', {
          ...meta,
          message:
            'Visual capture requires a Playwright session with renderer evaluation and explicit surface targeting.',
        }),
      )
      if (!support.supported) return support.fallback
    }
    const session = managed.session
    const surface = await session.activeSurface()
    if (surface.kind !== 'window') {
      return makePluginError('visual.SURFACE_UNSUPPORTED', {
        ...meta,
        message:
          'Visual capture is currently BrowserWindow-scoped; select a window surface before capture rather than approximating a frame, webview, or WebContentsView crop.',
        details: { surface_id: surface.id, kind: surface.kind },
        next_actions: [
          'electron_surfaces_list()',
          'electron_switch_surface({ surfaceId: "<window surface id>" })',
        ],
      })
    }
    const activeWindow = (await session.windowsList()).find((window) => window.focused)
    if (activeWindow === undefined) {
      return makePluginError('visual.CAPTURE_FAILED', {
        ...meta,
        message: 'No focused BrowserWindow is available for a visual capture.',
      })
    }

    const token = randomUUID()
    let preparation: CapturePreparationResult
    try {
      preparation = await session.evaluate<CapturePreparationResult>(
        'renderer',
        PREPARE_CAPTURE_BODY,
        {
          token,
          animations: args.animations as AnimationMode,
          caret: args.caret as CaretMode,
          ...(args.style !== undefined ? { style: args.style } : {}),
          masks: args.masks,
          settleMs: args.settleMs,
        },
      )
    } catch (cause) {
      return makePluginError('visual.CAPTURE_FAILED', {
        ...meta,
        message: `Could not prepare the selected BrowserWindow for capture: ${messageOf(cause)}`,
      })
    }
    if (preparation.kind === 'invalid_selector') {
      return makePluginError('visual.INVALID_SELECTOR', {
        ...meta,
        message: `Invalid visual mask selector ${JSON.stringify(preparation.selector)}: ${preparation.message}`,
        details: { selector: preparation.selector },
      })
    }
    if (preparation.kind === 'unstable') {
      return makePluginError('visual.UNSTABLE', {
        ...meta,
        message:
          'The selected BrowserWindow changed size or layout while preparing the visual capture.',
      })
    }

    let screenshot: Buffer
    try {
      screenshot = await session.screenshot(
        { kind: 'id', id: activeWindow.id },
        { fullPage: args.fullPage, format: 'png' },
      )
    } catch (cause) {
      return makePluginError('visual.CAPTURE_FAILED', {
        ...meta,
        message: `Could not capture the selected BrowserWindow: ${messageOf(cause)}`,
      })
    } finally {
      await session.evaluate('renderer', CLEANUP_CAPTURE_BODY, token).catch(() => undefined)
    }

    try {
      const png = decodePng(screenshot)
      assertImageBounds(png, screenshot.byteLength)
      const environment: VisualEnvironment = {
        ...preparation.environment,
        platform: process.platform,
        arch: process.arch,
        ...(config.current.fontFingerprint !== undefined
          ? { fontFingerprint: config.current.fontFingerprint }
          : {}),
      }
      return {
        sessionId: managed.id,
        surfaceId: surface.id,
        screenshot,
        masksTruncated: preparation.masksTruncated,
        metadata: {
          schemaVersion: 1,
          name: args.name,
          capturedAt: new Date(ctx.now()).toISOString(),
          image: { sha256: sha256(screenshot), width: png.width, height: png.height },
          environment,
          captureProfile: {
            fullPage: args.fullPage,
            hash: captureProfileHash({
              fullPage: args.fullPage,
              animations: args.animations as AnimationMode,
              caret: args.caret as CaretMode,
              ...(args.style !== undefined ? { style: args.style } : {}),
              masks: args.masks,
            }),
          },
        },
      }
    } catch (cause) {
      const code =
        cause instanceof VisualImageLimitError ? 'visual.IMAGE_TOO_LARGE' : 'visual.CAPTURE_FAILED'
      return makePluginError(code, {
        ...meta,
        message: messageOf(cause),
        ...(code === 'visual.IMAGE_TOO_LARGE'
          ? { next_actions: ['Retry with fullPage: false or a smaller BrowserWindow viewport.'] }
          : {}),
      })
    }
  }

  async function writeCaptureArtifact(captured: CapturedVisual, root: string, now: number) {
    const canonical = await canonicalRoot(root, true)
    const stem = artifactStem(captured.metadata.name, now)
    const imagePath = await writeConfinedAtomically(
      canonical,
      `${stem}.capture.png`,
      captured.screenshot,
    )
    const metaPath = await writeConfinedAtomically(
      canonical,
      `${stem}.capture.meta.json`,
      `${JSON.stringify(captured.metadata, null, 2)}\n`,
    )
    return { imagePath, metaPath }
  }

  const captureTool: AnyToolDefinition = defineTool({
    name: 'capture',
    title: 'Capture a bounded visual diagnostic artifact',
    description:
      'Capture the selected BrowserWindow to a unique artifact under the configured visual artifact root. This never creates or changes a baseline. Fixed temporary preparation can settle layout, disable animations, hide the caret, apply bounded CSS, and mask bounded CSS selectors. Errors: visual.UNSUPPORTED, visual.SURFACE_UNSUPPORTED, visual.INVALID_SELECTOR, visual.UNSTABLE, visual.CAPTURE_FAILED, visual.IMAGE_TOO_LARGE, visual.PATH_INVALID.',
    inputSchema: captureSchema,
    operationType: 'screenshot',
    handler: async (args, ctx) =>
      withProgressPhases({ reporter: ctx.progress }, async (phase) => {
        const meta = { startedAt: ctx.startedAt, now: ctx.now }
        const managed = ctx.sessions.resolve(args.sessionId)
        try {
          assertVisualName(args.name)
          phase('Preparing visual capture')
          const artifactRoot = await canonicalRoot(
            configuredRoot(config.current, 'artifactsDir'),
            true,
          )
          return await sessionSerial.run(managed.id, async () => {
            phase('Capturing visual surface')
            const captured = await capture(args, ctx, managed)
            if ('ok' in captured) return captured
            phase('Writing visual artifact')
            const artifact = await writeCaptureArtifact(captured, artifactRoot, ctx.now())
            return makeSuccess(
              {
                session_id: captured.sessionId,
                surface_id: captured.surfaceId,
                artifact: { path: artifact.imagePath, metadata_path: artifact.metaPath },
                metadata: captured.metadata,
                masks_truncated: captured.masksTruncated,
              },
              { ...meta, session_id: captured.sessionId },
            )
          })
        } catch (cause) {
          return filesystemError(cause, meta)
        }
      }),
  })

  const updateTool: AnyToolDefinition = defineTool({
    name: 'update_baseline',
    title: 'Explicitly replace a visual baseline',
    description:
      'Capture the selected BrowserWindow and explicitly replace its configured-root baseline only when confirm is true. This destructive operation is separate from visual_expect; CI comparisons never update baselines implicitly. Errors: visual.UNSUPPORTED, visual.SURFACE_UNSUPPORTED, visual.INVALID_SELECTOR, visual.UNSTABLE, visual.CAPTURE_FAILED, visual.IMAGE_TOO_LARGE, visual.PATH_INVALID, visual.WRITE_FAILED.',
    inputSchema: updateSchema,
    operationType: 'command',
    handler: async (args, ctx) =>
      withProgressPhases({ reporter: ctx.progress }, async (phase) => {
        const meta = { startedAt: ctx.startedAt, now: ctx.now }
        const managed = ctx.sessions.resolve(args.sessionId)
        try {
          assertVisualName(args.name)
          phase('Preparing visual baseline update')
          const baselineRoot = await canonicalRoot(
            configuredRoot(config.current, 'baselineDir'),
            true,
          )
          return await sessionSerial.run(managed.id, () =>
            baselineSerial.run(args.name, async () => {
              phase('Capturing visual baseline')
              const captured = await capture(args, ctx, managed)
              if ('ok' in captured) return captured
              phase('Writing visual baseline')
              const imagePath = await writeConfinedAtomically(
                baselineRoot,
                `${args.name}.png`,
                captured.screenshot,
              )
              const metadataPath = await writeConfinedAtomically(
                baselineRoot,
                `${args.name}.meta.json`,
                `${JSON.stringify(captured.metadata, null, 2)}\n`,
              )
              return makeSuccess(
                {
                  session_id: captured.sessionId,
                  surface_id: captured.surfaceId,
                  baseline: { path: imagePath, metadata_path: metadataPath, replaced: true },
                  metadata: captured.metadata,
                  masks_truncated: captured.masksTruncated,
                },
                { ...meta, session_id: captured.sessionId },
              )
            }),
          )
        } catch (cause) {
          return filesystemError(cause, meta)
        }
      }),
  })

  const expectTool: AnyToolDefinition = defineTool({
    name: 'expect',
    title: 'Compare the selected BrowserWindow with an existing visual baseline',
    description:
      'Compare a stable selected-BrowserWindow PNG against an existing configured-root baseline. A missing baseline is an error; this tool never writes or updates one. Metadata must match before comparison. A mismatch atomically writes unique actual and diff artifacts. Errors: visual.BASELINE_NOT_FOUND, visual.BASELINE_INVALID, visual.ENV_MISMATCH, visual.MISMATCH, visual.UNSUPPORTED, visual.SURFACE_UNSUPPORTED, visual.INVALID_SELECTOR, visual.UNSTABLE, visual.CAPTURE_FAILED, visual.IMAGE_TOO_LARGE, visual.PATH_INVALID, visual.WRITE_FAILED.',
    inputSchema: expectSchema,
    operationType: 'query',
    handler: async (args, ctx) =>
      withProgressPhases({ reporter: ctx.progress }, async (phase) => {
        const meta = { startedAt: ctx.startedAt, now: ctx.now }
        const managed = ctx.sessions.resolve(args.sessionId)
        try {
          assertVisualName(args.name)
          phase('Loading visual baseline')
          const baselineRoot = await canonicalRoot(
            configuredRoot(config.current, 'baselineDir'),
            false,
          )
          return await sessionSerial.run(managed.id, () =>
            baselineSerial.run(args.name, async () => {
              const [baselineBuffer, metadataBuffer] = await Promise.all([
                readConfinedFile(baselineRoot, `${args.name}.png`),
                readConfinedFile(baselineRoot, `${args.name}.meta.json`),
              ])
              const baseline = parseMetadata(metadataBuffer)
              if (baseline.name !== args.name || baseline.image.sha256 !== sha256(baselineBuffer)) {
                return makePluginError('visual.BASELINE_INVALID', {
                  ...meta,
                  message:
                    'The visual baseline PNG and metadata sidecar do not form a verified pair.',
                })
              }
              const expected = decodePng(baselineBuffer)
              assertImageBounds(expected, baselineBuffer.byteLength)
              phase('Capturing visual comparison')
              const captured = await capture(args, ctx, managed)
              if ('ok' in captured) return captured
              const incompatible = incompatibleMetadata(baseline, captured.metadata)
              if (incompatible.length > 0) {
                return makePluginError('visual.ENV_MISMATCH', {
                  ...meta,
                  message:
                    'The current capture environment is incompatible with the accepted visual baseline; no diff was computed.',
                  details: { fields: incompatible },
                })
              }
              const actual = decodePng(captured.screenshot)
              assertImageBounds(actual, captured.screenshot.byteLength)
              phase('Comparing visual baseline')
              const comparison = comparePngs(expected, actual, args.threshold)
              const totalPixels = expected.width * expected.height
              const diffRatio = comparison.diffPixels / totalPixels
              const matches =
                comparison.diffPixels <= args.maxDiffPixels && diffRatio <= args.maxDiffRatio
              if (matches) {
                return makeSuccess(
                  {
                    session_id: captured.sessionId,
                    surface_id: captured.surfaceId,
                    name: args.name,
                    matched: true,
                    diff_pixels: comparison.diffPixels,
                    diff_ratio: diffRatio,
                    masks_truncated: captured.masksTruncated,
                  },
                  { ...meta, session_id: captured.sessionId },
                )
              }
              const artifactRoot = await canonicalRoot(
                configuredRoot(config.current, 'artifactsDir'),
                true,
              )
              phase('Writing visual mismatch artifacts')
              const stem = artifactStem(args.name, ctx.now())
              const { actualPath, diffPath } = await writeConfinedMismatchPairAtomically(
                artifactRoot,
                `${stem}.mismatch`,
                captured.screenshot,
                comparison.diffPng,
              )
              return makePluginError('visual.MISMATCH', {
                ...meta,
                message: `Visual baseline ${JSON.stringify(args.name)} exceeded its allowed pixel difference.`,
                details: {
                  name: args.name,
                  diff_pixels: comparison.diffPixels,
                  diff_ratio: diffRatio,
                  max_diff_pixels: args.maxDiffPixels,
                  max_diff_ratio: args.maxDiffRatio,
                  actual_path: actualPath,
                  diff_path: diffPath,
                  masks_truncated: captured.masksTruncated,
                },
                next_actions: [
                  'Inspect the actual_path and diff_path artifacts, then use visual_update_baseline only after intentional review.',
                ],
              })
            }),
          )
        } catch (cause) {
          return filesystemError(cause, meta)
        }
      }),
  })

  return {
    name: VISUAL_NAMESPACE,
    version: VISUAL_PLUGIN_VERSION,
    coreVersionRange: '*',
    configSchema: visualConfigSchema,
    introspection: VISUAL_INTROSPECTION,
    errorCodes: {
      UNSUPPORTED: {
        http: 409,
        retryable: false,
        hint: 'Use a Playwright launch session with renderer evaluation and surface targeting.',
      },
      SURFACE_UNSUPPORTED: {
        http: 409,
        retryable: false,
        hint: 'Select a BrowserWindow surface; frame, webview, and WebContentsView screenshots are not approximated.',
      },
      INVALID_SELECTOR: {
        http: 400,
        retryable: false,
        hint: 'Correct the visual mask selector and retry.',
      },
      UNSTABLE: {
        http: 409,
        retryable: true,
        hint: 'Wait for the UI to settle or increase settleMs, then retry.',
      },
      CAPTURE_FAILED: {
        http: 500,
        retryable: true,
        hint: 'Confirm the selected BrowserWindow is live and retry the capture.',
      },
      IMAGE_TOO_LARGE: {
        http: 413,
        retryable: false,
        hint: 'Use a smaller viewport or fullPage: false so visual artifacts remain bounded.',
      },
      PATH_INVALID: {
        http: 400,
        retryable: false,
        hint: 'Use a safe baseline name and configured absolute artifact or baseline roots.',
      },
      BASELINE_NOT_FOUND: {
        http: 404,
        retryable: false,
        hint: 'Review the capture, then create it explicitly with visual_update_baseline.',
      },
      BASELINE_INVALID: {
        http: 409,
        retryable: false,
        hint: 'Restore a matching baseline PNG and metadata sidecar from version control.',
      },
      ENV_MISMATCH: {
        http: 409,
        retryable: false,
        hint: 'Match the baseline platform, viewport, DPR, Electron version, locale, color scheme, and font fingerprint before comparison.',
      },
      MISMATCH: {
        http: 409,
        retryable: false,
        hint: 'Inspect the actual and diff artifacts; update a baseline only after intentional review.',
      },
      WRITE_FAILED: {
        http: 500,
        retryable: true,
        hint: 'Check that configured visual roots are writable and retry.',
      },
    },
    tools: [captureTool, expectTool, updateTool],
    setup: (raw, context) => {
      config.set(visualConfigSchema.parse(raw))
      return sessionCleanup.setup(context)
    },
    teardown: () => sessionCleanup.teardown(),
  }
}

/** API 1.2 descriptor; the loader obtains a fresh instance per server. */
export const visualPlugin: StagewrightPlugin = {
  name: VISUAL_NAMESPACE,
  version: VISUAL_PLUGIN_VERSION,
  coreVersionRange: '*',
  configSchema: visualConfigSchema,
  introspection: VISUAL_INTROSPECTION,
  get tools() {
    return createVisualPlugin().tools ?? []
  },
  get errorCodes() {
    return createVisualPlugin().errorCodes ?? {}
  },
  createInstance: createVisualPlugin,
}

export default visualPlugin

function parseMetadata(input: Buffer): VisualMetadata {
  try {
    const parsed: unknown = JSON.parse(input.toString('utf8'))
    const result = z
      .object({
        schemaVersion: z.literal(1),
        name: nameSchema,
        capturedAt: z.string().datetime(),
        image: z.object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        }),
        environment: z.object({
          platform: z.string().min(1),
          arch: z.string().min(1),
          electronVersion: z.string().min(1),
          userAgent: z.string().min(1).max(1024),
          viewport: z.object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          }),
          devicePixelRatio: z.number().positive(),
          colorScheme: z.enum(['dark', 'light', 'no-preference']),
          locale: z.string().min(1).max(256),
          fontFingerprint: z.string().min(1).max(512).optional(),
        }),
        captureProfile: z.object({
          fullPage: z.boolean(),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      })
      .strict()
      .safeParse(parsed)
    if (!result.success)
      throw new VisualImageError('The visual baseline metadata sidecar has an invalid schema.')
    const { fontFingerprint, ...environment } = result.data.environment
    return {
      ...result.data,
      environment: {
        ...environment,
        ...(fontFingerprint !== undefined ? { fontFingerprint } : {}),
      },
    }
  } catch (cause) {
    if (cause instanceof VisualImageError) throw cause
    throw new VisualImageError('The visual baseline metadata sidecar is not valid JSON.')
  }
}

function filesystemError(
  cause: unknown,
  meta: { readonly startedAt: number; readonly now: () => number },
): ToolResult {
  if (cause instanceof VisualBaselineMissingError) {
    return makePluginError('visual.BASELINE_NOT_FOUND', { ...meta, message: cause.message })
  }
  if (cause instanceof VisualPathError) {
    return makePluginError('visual.PATH_INVALID', { ...meta, message: cause.message })
  }
  if (cause instanceof VisualImageLimitError) {
    return makePluginError('visual.IMAGE_TOO_LARGE', { ...meta, message: cause.message })
  }
  if (cause instanceof VisualImageError) {
    return makePluginError('visual.BASELINE_INVALID', { ...meta, message: cause.message })
  }
  return makePluginError('visual.WRITE_FAILED', {
    ...meta,
    message: `Could not write or read visual artifacts: ${messageOf(cause)}`,
  })
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? (cause.message.split('\n', 1)[0] ?? cause.message) : String(cause)
}

function configuredRoot(config: VisualConfig, field: 'baselineDir' | 'artifactsDir'): string {
  const root = config[field]
  if (root === undefined) {
    throw new VisualPathError(
      `visual plugin config requires ${field}; pass --plugin-config visual='{"${field}":"/absolute/path"}'.`,
    )
  }
  return root
}
