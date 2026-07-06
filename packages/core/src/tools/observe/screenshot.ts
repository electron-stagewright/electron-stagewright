/**
 * `electron_screenshot` — capture a window (or a single element) to an image file
 * and return its path. The image is written to disk on the server host and the
 * tool returns the path + size + dimensions, never the bytes inline (returning
 * base64 in the JSON envelope would blow the agent's token budget — ADR-007 P2).
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import type { ScreenshotOptions, TransportSession, WindowRef } from '../../transports/index.js'
import { refField, selectorField, sessionIdField } from '../schema.js'
import { buildProbeBody, loadInjectedWalker } from '../snapshot/inject.js'
import { buildMissError, refFreshnessError, refName, resolveTarget } from '../target.js'
import { type AnyToolDefinition, defineTool } from '../types.js'

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

/** Build the {@link WindowRef} from the targeting args; defaults to the active (first) window. */
function toWindowRef(args: {
  readonly windowId?: string | undefined
  readonly windowTitle?: string | undefined
  readonly windowIndex?: number | undefined
}): WindowRef {
  if (args.windowId !== undefined) return { kind: 'id', id: args.windowId }
  if (args.windowTitle !== undefined) return { kind: 'title', pattern: args.windowTitle }
  if (args.windowIndex !== undefined) return { kind: 'index', index: args.windowIndex }
  return { kind: 'index', index: 0 }
}

/** Resolve an element's bounding box (CSS px) via the renderer probe, or null if absent. */
async function elementClip(
  session: TransportSession,
  selector: string,
  bundle: string,
): Promise<ElementClipResult> {
  const raw = await session.evaluate<{
    found?: boolean
    invalid_selector?: boolean
    error?: string
    bbox?: { x: number; y: number; w: number; h: number }
  }>('renderer', buildProbeBody(bundle), { mode: 'element', selector })
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
  'Returns: { ok, session_id, path, bytes, format, width?, height? } (path is the absolute file written).',
  'Errors: ABSOLUTE_PATH_REQUIRED (relative path), REF_NOT_FOUND (no such window),',
  'SELECTOR_NO_MATCH (element not found), NOT_RUNNING, BAD_ARGUMENT (invalid selector/options).',
].join(' ')

/** Build the `electron_screenshot` tool. */
export function makeScreenshotTool(deps: ScreenshotToolDeps = {}): AnyToolDefinition {
  const loadBundle = deps.loadBundle ?? loadInjectedWalker
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
      sessionId: sessionIdField,
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
        // runs on the active (first) window, but a window-targeting arg would aim
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

      // Element capture (ref/selector) resolves the element's bbox into a clip;
      // otherwise an explicit clip may be supplied for a window capture.
      let clip: ClipRect | undefined
      if (elementTargeted) {
        const selector = resolveTarget({ ref: args.ref, selector: args.selector })
        const stale = await refFreshnessError(ctx, managed.session, meta, args.ref)
        if (stale !== undefined) return stale

        const resolved = await elementClip(managed.session, selector, loadBundle())
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
            nameHint: refName(ctx.snapshots.get(managed.id), args.ref),
          })
        }
        clip = resolved.clip
      } else if (args.clip !== undefined) {
        clip = args.clip
      }

      const opts: ScreenshotOptions = {
        format,
        ...(args.fullPage !== undefined ? { fullPage: args.fullPage } : {}),
        ...(args.quality !== undefined ? { quality: args.quality } : {}),
        ...(clip !== undefined ? { clip } : {}),
      }

      // A bad window ref throws REF_NOT_FOUND from the transport; the dispatcher maps it.
      const buffer = await managed.session.screenshot(toWindowRef(args), opts)

      // Output path precedence: explicit file `path` > explicit `dir` (generated name) >
      // the server-configured default dir (--screenshot-dir) > the OS temp dir. Preferring
      // dir/screenshotDir over the temp dir gives agents a stable artifact location.
      const ext = format === 'jpeg' ? 'jpg' : 'png'
      const baseDir = args.dir ?? ctx.screenshotDir ?? tmpdir()
      const outPath = args.path ?? path.join(baseDir, `stagewright-${randomUUID()}.${ext}`)
      await mkdir(path.dirname(outPath), { recursive: true })
      await writeFile(outPath, buffer)

      return makeSuccess(
        {
          session_id: managed.id,
          path: outPath,
          bytes: buffer.length,
          format,
          ...parseImageSize(buffer, format),
        },
        meta,
      )
    },
  })
}

/** The default `electron_screenshot` tool registered by the server. */
export const screenshotTool: AnyToolDefinition = makeScreenshotTool()
