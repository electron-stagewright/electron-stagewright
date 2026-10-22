/**
 * `electron_screenshot` — capture a window (or a single element) to an image file
 * and return its path. The image is written to disk on the server host and the
 * tool returns the path + size + dimensions, never the bytes inline (returning
 * base64 in the JSON envelope would blow the agent's token budget — ADR-007 P2).
 *
 * @module
 */

import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import type {
  ScreenshotOptions,
  TransportSession,
  WindowDescriptor,
  WindowRef,
} from '../../transports/index.js'
import { artifactOutputFields } from '../output-schema.js'
import { refField, selectorField, sessionIdField } from '../schema.js'
import { loadInjectedWalker, runProbe } from '../snapshot/inject.js'
import {
  buildMissError,
  refNameForActiveSurface,
  resolveTarget,
  staleRefError,
  withFreshRefs,
} from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { sleep } from '../wait/sleep.js'

/** Dependency seam — injected by tests so the probe bundle is not read from disk. */
export interface ScreenshotToolDeps {
  /** Loader for the bundled walker/probe IIFE (used only for element-clip capture). */
  readonly loadBundle?: () => string
}

/** A bounding box in CSS pixels, the shape Playwright's screenshot `clip` accepts. */
interface ClipRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

type ElementClipResult =
  | { readonly kind: 'clip'; readonly clip: ClipRect }
  | { readonly kind: 'invalid-selector'; readonly error?: string }
  | { readonly kind: 'not-found' }

/** Upper bound on the frame wait; rAF does not run in a hidden or minimised window. */
const FRAME_WAIT_TIMEOUT_MS = 250
/** Upper bound on `settleMs`. */
const MAX_SETTLE_MS = 5000
/** Captures remembered per server for `same_as_previous`; the oldest is dropped first. */
const MAX_REMEMBERED_CAPTURES = 200

/** Renderer body: resolve after two animation frames (a painted frame), or false on timeout. */
const NEXT_FRAMES_BODY = `
return await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), arg.timeoutMs);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve(true);
  }));
});
`

/** Whether `ref` names `window`, using the transports' exact-title rule. */
function refNamesWindow(ref: WindowRef, window: WindowDescriptor): boolean {
  if (ref.kind === 'id') return ref.id === window.id
  if (ref.kind === 'index') return ref.index === window.index
  return typeof ref.pattern === 'string'
    ? ref.pattern === window.title
    : ref.pattern.test(window.title)
}

/** Build an explicit {@link WindowRef} from targeting args, if the caller provided one. */
function explicitWindowRef(args: {
  readonly windowId?: string | undefined
  readonly windowTitle?: string | undefined
  readonly windowIndex?: number | undefined
}): WindowRef | undefined {
  if (args.windowId !== undefined) return { kind: 'id', id: args.windowId }
  if (args.windowTitle !== undefined) return { kind: 'title', pattern: args.windowTitle }
  if (args.windowIndex !== undefined) return { kind: 'index', index: args.windowIndex }
  return undefined
}

/** Resolve an element's bounding box (CSS px) via the renderer probe, or null if absent. */
async function elementClip(
  session: TransportSession,
  selector: string,
  bundle: string,
): Promise<ElementClipResult> {
  const raw = await runProbe<{
    found?: boolean
    invalid_selector?: boolean
    error?: string
    bbox?: { x: number; y: number; w: number; h: number }
  }>(session, bundle, { mode: 'element', selector })
  if (raw?.invalid_selector === true) {
    return {
      kind: 'invalid-selector',
      ...(raw.error !== undefined ? { error: raw.error } : {}),
    }
  }
  if (raw?.found === false || raw?.bbox === undefined) return { kind: 'not-found' }
  const b = raw.bbox
  return { kind: 'clip', clip: { x: b.x, y: b.y, width: b.w, height: b.h } }
}

/** Read width/height from a PNG/JPEG header; returns `{}` when it cannot be parsed. */
function parseImageSize(
  buffer: Buffer,
  format: 'png' | 'jpeg',
): { width?: number; height?: number } {
  try {
    if (format === 'png' && buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (format === 'jpeg') {
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = buffer[offset + 1]
        // 0xFF padding fill bytes: a marker can be preceded by any number of 0xFF; skip one.
        if (marker === 0xff) {
          offset += 1
          continue
        }
        // Standalone (length-less) markers: TEM (0x01), RSTn (0xD0–0xD7), SOI (0xD8), EOI (0xD9).
        // They have NO length field, so the two bytes after them are image/entropy data, not a
        // segment length — advance past just the marker, never reading a phantom length.
        if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd9)) {
          offset += 2
          continue
        }
        // SOF markers (0xC0–0xCF) carry dimensions, except DHT(C4)/JPG(C8)/DAC(CC).
        if (
          marker !== undefined &&
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
        }
        // A JPEG segment length includes its own 2 length bytes, so it is >= 2;
        // clamp to guarantee forward progress on a malformed/short length field.
        offset += 2 + Math.max(buffer.readUInt16BE(offset + 2), 2)
      }
    }
  } catch {
    // Malformed/short buffer — omit dimensions rather than fail the capture.
  }
  return {}
}

const DESCRIPTION = [
  'Capture a screenshot to an image file and return its path (the image is written on the server',
  'host; the bytes are NOT returned inline). With ref/selector, captures just that element; otherwise',
  'the targeted window (windowId > windowTitle > windowIndex, default the active window) with optional',
  'fullPage or clip. Options: format (png|jpeg), quality (jpeg), path (absolute file) or dir (absolute',
  'directory, generated filename). With neither, writes to the server --screenshot-dir if configured,',
  'else the OS temp dir — pass dir or set --screenshot-dir for a stable, retrievable artifact location.',
  'Before capturing it waits settleMs (optional), then for the active window to paint a new frame',
  '(waitForFrame, default true). Returns: { ok, session_id, path, bytes, format, width?, height?,',
  'content_sha256, same_as_previous (same bytes as the last capture of this target), overwrote',
  '(path existed; a viewer may show a cached copy), frame_waited }.',
  'When portable delivery is available, artifact metadata and an MCP resource_link let the client',
  'read the generated bytes before expires_at; otherwise artifact_unavailable explains the limit.',
  'Errors: ABSOLUTE_PATH_REQUIRED (relative path), REF_NOT_FOUND (no such window),',
  'SELECTOR_NO_MATCH (element not found), SURFACE_UNSUPPORTED (iframe element crops are not window-relative),',
  'NOT_RUNNING, BAD_ARGUMENT (invalid selector/options), RENDERER_NAVIGATED (the page was navigating).',
].join(' ')

/** Build the `electron_screenshot` tool. */
export function makeScreenshotTool(deps: ScreenshotToolDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
  // Last content hash per capture target, for same_as_previous.
  const lastCapture = new Map<string, string>()
  return defineTool({
    name: 'electron_screenshot',
    title: 'Capture a screenshot',
    description: DESCRIPTION,
    inputSchema: z.object({
      ref: refField,
      selector: selectorField,
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full scrollable page (window capture only).'),
      clip: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .optional()
        .describe('Explicit capture rectangle in CSS pixels (window capture only).'),
      format: z.enum(['png', 'jpeg']).default('png').describe('Image format. Default png.'),
      quality: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('JPEG quality 0-100 (jpeg only).'),
      path: z
        .string()
        .optional()
        .describe('Absolute output file path. Takes precedence over dir / the server default.'),
      dir: z
        .string()
        .optional()
        .describe(
          'Absolute output DIRECTORY; the filename is generated. Use this (or the server --screenshot-dir default) for a stable, per-session artifact location instead of the OS temp dir. Mutually exclusive with path.',
        ),
      windowId: z.string().optional().describe('Target window transport id (highest precedence).'),
      windowTitle: z.string().optional().describe('Target window by exact title.'),
      windowIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Target window by 0-based index.'),
      waitForFrame: z
        .boolean()
        .default(true)
        .describe('Wait for the active window to paint a new frame before capturing.'),
      settleMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_SETTLE_MS)
        .optional()
        .describe('Extra wait in ms before capturing, e.g. for animations.'),
      sessionId: sessionIdField,
    }),
    outputSchema: z.object({
      session_id: z.string(),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      format: z.enum(['png', 'jpeg']),
      width: z.number().optional(),
      height: z.number().optional(),
      content_sha256: z.string(),
      same_as_previous: z.boolean(),
      overwrote: z.boolean(),
      frame_waited: z.boolean(),
      ...artifactOutputFields,
    }),
    operationType: 'screenshot',
    handler: async (args, ctx) => {
      const managed = ctx.sessions.resolve(args.sessionId)
      const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }
      const format = args.format
      const elementTargeted = args.ref !== undefined || args.selector !== undefined

      if (args.path !== undefined && !path.isAbsolute(args.path)) {
        return makeError('ABSOLUTE_PATH_REQUIRED', {
          ...meta,
          message: `Screenshot path must be absolute: ${args.path}`,
          details: { path: args.path },
        })
      }
      if (args.dir !== undefined && !path.isAbsolute(args.dir)) {
        return makeError('ABSOLUTE_PATH_REQUIRED', {
          ...meta,
          message: `Screenshot dir must be absolute: ${args.dir}`,
          details: { dir: args.dir },
        })
      }
      if (args.path !== undefined && args.dir !== undefined) {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message: 'Provide at most one of path (full file) or dir (directory).',
          details: { path: args.path, dir: args.dir },
        })
      }
      if (args.quality !== undefined && format !== 'jpeg') {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message: 'quality is only valid for jpeg screenshots.',
          details: { format, quality: args.quality },
        })
      }
      if (elementTargeted && args.fullPage !== undefined) {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message: 'fullPage is only valid for window screenshots; omit it with ref or selector.',
        })
      }
      if (elementTargeted && args.clip !== undefined) {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message: 'clip is only valid for window screenshots; omit it with ref or selector.',
        })
      }
      if (
        elementTargeted &&
        (args.windowId !== undefined ||
          args.windowTitle !== undefined ||
          args.windowIndex !== undefined)
      ) {
        // The element's bounding box is resolved by a renderer probe that always
        // runs on the active session window, but a window-targeting arg would aim
        // the capture at a different window — clipping the active window's
        // coordinates onto another window's image. Reject the combination rather
        // than silently produce a wrong region. (Capturing an element in a
        // non-active window needs a transport that can probe an arbitrary window,
        // which is out of scope for this surface.)
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message:
            'Element capture (ref/selector) targets the active window; omit windowId/windowTitle/windowIndex.',
        })
      }

      const windows = await managed.session.windowsList()
      const active = windows.find((window) => window.focused) ?? windows[0]
      let target = explicitWindowRef(args)
      if (target === undefined) {
        if (active === undefined) {
          return makeError('REF_NOT_FOUND', {
            ...meta,
            message: 'No active Electron window is available for a screenshot.',
          })
        }
        target = { kind: 'id', id: active.id }
      }

      // The renderer evaluate runs in the active window, so only its frames can be awaited.
      const awaitFrame = args.waitForFrame && active !== undefined && refNamesWindow(target, active)
      let frameWaited = false
      const waitFrame = async (): Promise<void> => {
        if (!awaitFrame) return
        ctx.signal?.throwIfAborted()
        const painted = await managed.session.evaluate<unknown>('renderer', NEXT_FRAMES_BODY, {
          timeoutMs: FRAME_WAIT_TIMEOUT_MS,
        })
        frameWaited = painted === true
      }
      if (args.settleMs !== undefined && args.settleMs > 0) await sleep(args.settleMs, ctx.signal)

      // Element capture (ref/selector) resolves the element's bbox into a clip;
      // otherwise an explicit clip may be supplied for a window capture.
      let clip: ClipRect | undefined
      let elementSelector: string | undefined
      if (elementTargeted) {
        const selector = resolveTarget({ ref: args.ref, selector: args.selector })
        elementSelector = selector
        const surface = await managed.session.activeSurface()
        if (surface.kind === 'frame') {
          // A frame bbox is relative to the frame viewport, while the existing screenshot transport
          // deliberately captures a WindowRef. Applying those coordinates to the host image would
          // silently write the wrong crop, so keep screenshot addressing window-scoped for now.
          return makeError('SURFACE_UNSUPPORTED', {
            ...meta,
            message:
              'Element screenshots are not available for an iframe surface; select its root window or capture the window without ref/selector.',
          })
        }
        const run = await withFreshRefs(
          ctx,
          managed.session,
          managed.id,
          [args],
          async () => {
            // Wait for the frame before measuring, so the clip matches what is captured.
            await waitFrame()
            return elementClip(managed.session, selector, loadBundle())
          },
          { readOnly: true },
        )
        if ('staleRef' in run) return staleRefError(ctx, managed.session, meta, run.staleRef)
        const resolved = run.value
        if (resolved.kind === 'invalid-selector') {
          return makeError('BAD_ARGUMENT', {
            ...meta,
            message: `Invalid CSS selector ${selector}: ${resolved.error ?? 'selector parse failed'}`,
          })
        }
        if (resolved.kind === 'not-found') {
          return buildMissError('SELECTOR_NO_MATCH', {
            ctx,
            session: managed.session,
            meta,
            message: `No element matched ${selector}.`,
            nameHint: await refNameForActiveSurface(ctx, managed.session, managed.id, args.ref),
          })
        }
        clip = resolved.clip
      } else {
        await waitFrame()
        if (args.clip !== undefined) clip = args.clip
      }

      const opts: ScreenshotOptions = {
        format,
        ...(args.fullPage !== undefined ? { fullPage: args.fullPage } : {}),
        ...(args.quality !== undefined ? { quality: args.quality } : {}),
        ...(clip !== undefined ? { clip } : {}),
      }

      // A bad window ref throws REF_NOT_FOUND from the transport; the dispatcher maps it.
      ctx.signal?.throwIfAborted()
      const buffer = await managed.session.screenshot(target, opts)
      ctx.signal?.throwIfAborted()

      // Output path precedence: explicit file `path` > explicit `dir` (generated name) >
      // the server-configured default dir (--screenshot-dir) > the OS temp dir. Preferring
      // dir/screenshotDir over the temp dir gives agents a stable artifact location.
      const ext = format === 'jpeg' ? 'jpg' : 'png'
      const baseDir = args.dir ?? ctx.screenshotDir ?? tmpdir()
      const outPath = args.path ?? path.join(baseDir, `stagewright-${randomUUID()}.${ext}`)
      const overwrote =
        args.path !== undefined &&
        (await access(outPath).then(
          () => true,
          () => false,
        ))
      await mkdir(path.dirname(outPath), { recursive: true })
      await writeFile(outPath, buffer)
      ctx.signal?.throwIfAborted()

      const contentSha256 = createHash('sha256').update(buffer).digest('hex')
      // Key on the resolved window, so the same window addressed another way is the same target.
      const targetWindow = windows.find((window) => refNamesWindow(target, window))
      const captureKey = JSON.stringify([
        managed.id,
        targetWindow?.id ?? target,
        elementSelector ?? null,
        args.clip ?? null,
        args.fullPage ?? false,
        format,
        args.quality ?? null,
      ])
      const sameAsPrevious = lastCapture.get(captureKey) === contentSha256
      lastCapture.delete(captureKey)
      lastCapture.set(captureKey, contentSha256)
      if (lastCapture.size > MAX_REMEMBERED_CAPTURES) {
        const oldest = lastCapture.keys().next().value
        if (oldest !== undefined) lastCapture.delete(oldest)
      }

      return makeSuccess(
        {
          session_id: managed.id,
          path: outPath,
          bytes: buffer.length,
          format,
          ...parseImageSize(buffer, format),
          content_sha256: contentSha256,
          same_as_previous: sameAsPrevious,
          overwrote,
          frame_waited: frameWaited,
          ...ctx.artifacts?.publish(
            buffer,
            format === 'jpeg' ? 'image/jpeg' : 'image/png',
            `screenshot.${ext}`,
          ),
        },
        meta,
      )
    },
  })
}

/** The default `electron_screenshot` tool registered by the server. */
export const screenshotTool: AnyToolDefinition = makeScreenshotTool()
