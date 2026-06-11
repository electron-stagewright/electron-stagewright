/**
 * `electron_drop_file` — simulate dropping OS files onto a drop zone.
 *
 * Web DataTransfer mode: the server (where the paths live) reads each file,
 * ships the bytes base64 into the renderer, builds real `File` objects inside a
 * `DataTransfer`, and dispatches `dragenter` → `dragover` → `drop` on the
 * target element. This engages standard web drag-and-drop handlers (React
 * dropzones, plain `ondrop`, etc.).
 *
 * A native-path mode (apps that read `webUtils.getPathForFile` / rely on OS
 * paths) needs an app-level IPC convention and is deliberately not implemented.
 *
 * The size caps are tighter than `electron_set_files` because the bytes travel
 * through the eval channel as base64 — a huge payload would bloat the transport
 * round-trip rather than stream.
 *
 * @module
 */

import { promises as fs, statSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { StagewrightError } from '../../errors/registry.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { refField, selectorField, sessionIdField, timeoutField } from './schema.js'
import { runTargetedInteraction } from './target.js'

/** Max files a single drop accepts. */
const MAX_DROP_FILES = 10
/** Max size (bytes) of any single dropped file — base64 travels over the eval channel. */
const MAX_DROP_FILE_BYTES = 5 * 1024 * 1024
/** Max combined size (bytes) of all dropped files. */
const MAX_DROP_TOTAL_BYTES = 10 * 1024 * 1024

/** Minimal extension → MIME map for common drop targets; octet-stream otherwise. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
}

/** Resolve a file's MIME type from its extension (override wins). */
function mimeFor(filePath: string, override?: string): string {
  if (override !== undefined) return override
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Validate drop paths: absolute, existing regular files within the caps.
 * Mirrors `electron_set_files` validation with drop-sized limits.
 */
function validateDropPaths(paths: readonly string[]): void {
  if (paths.length > MAX_DROP_FILES) {
    throw new StagewrightError(
      'BAD_ARGUMENT',
      `Too many files: ${paths.length} (max ${MAX_DROP_FILES}).`,
      { count: paths.length, max: MAX_DROP_FILES },
    )
  }
  let total = 0
  for (const filePath of paths) {
    if (!path.isAbsolute(filePath)) {
      throw new StagewrightError(
        'ABSOLUTE_PATH_REQUIRED',
        `File path must be absolute: ${filePath}`,
        { path: filePath },
      )
    }
    let stat
    try {
      stat = statSync(filePath)
    } catch {
      throw new StagewrightError('FILE_NOT_FOUND', `File not found: ${filePath}`, {
        path: filePath,
      })
    }
    if (!stat.isFile()) {
      throw new StagewrightError('FILE_NOT_FOUND', `Not a regular file: ${filePath}`, {
        path: filePath,
      })
    }
    if (stat.size > MAX_DROP_FILE_BYTES) {
      throw new StagewrightError(
        'BAD_ARGUMENT',
        `File too large to drop: ${filePath} (${stat.size} > ${MAX_DROP_FILE_BYTES} bytes).`,
        { path: filePath, size: stat.size, max: MAX_DROP_FILE_BYTES },
      )
    }
    total += stat.size
  }
  if (total > MAX_DROP_TOTAL_BYTES) {
    throw new StagewrightError(
      'BAD_ARGUMENT',
      `Files too large to drop together: ${total} > ${MAX_DROP_TOTAL_BYTES} bytes.`,
      { total, max: MAX_DROP_TOTAL_BYTES },
    )
  }
}

/**
 * Renderer body: rebuild the files from base64, assemble a DataTransfer, and
 * dispatch the dragenter/dragover/drop sequence on the resolved target.
 * Returns a discriminated result so the tool maps failures to registered codes.
 */
const DROP_BODY = `
let target = null;
try {
  target = document.querySelector(String(arg.selector));
} catch {
  return { ok: false, reason: 'bad-selector' };
}
if (target === null) return { ok: false, reason: 'no-match' };
function bytesOf(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
const dt = new DataTransfer();
for (const f of arg.files) {
  dt.items.add(new File([bytesOf(f.data)], f.name, { type: f.type }));
}
const rect = typeof target.getBoundingClientRect === 'function'
  ? target.getBoundingClientRect()
  : { x: 0, y: 0, width: 0, height: 0 };
const clientX = rect.x + rect.width / 2;
const clientY = rect.y + rect.height / 2;
function fire(type) {
  const ev = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    dataTransfer: dt,
  });
  if (ev.dataTransfer === null) {
    // Some engines ignore dataTransfer in DragEventInit; attach it explicitly.
    try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch {}
  }
  return target.dispatchEvent(ev);
}
fire('dragenter');
fire('dragover');
const dropDefaultPrevented = !fire('drop');
return { ok: true, default_prevented: dropDefaultPrevented };
`

/** Discriminated result returned by {@link DROP_BODY}. */
interface DropEvalResult {
  readonly ok: boolean
  readonly reason?: string
  readonly default_prevented?: boolean
}

/** `electron_drop_file` — drop OS files onto an element via web DataTransfer events. */
export const dropFileTool: AnyToolDefinition = defineTool({
  name: 'electron_drop_file',
  title: 'Drop files onto an element',
  description: [
    'Simulate dropping OS files onto the element identified by ref or selector. Web DataTransfer',
    'mode: reads each path on the host running the server, rebuilds the files in the renderer, and',
    'dispatches dragenter/dragover/drop with a real DataTransfer — engaging standard web drop',
    `handlers. Paths must be ABSOLUTE (max ${MAX_DROP_FILES} files, ${MAX_DROP_FILE_BYTES} bytes each).`,
    'default_prevented reports whether a drop handler engaged (called preventDefault); false usually',
    'means the target has no web drop handler. Apps that resolve dropped files to native OS paths',
    'need an app-specific IPC convention this tool does not simulate. Options: mimeType, timeoutMs.',
    'Returns: { ok, session_id, target, files, default_prevented }.',
    'Errors: ABSOLUTE_PATH_REQUIRED, FILE_NOT_FOUND, BAD_ARGUMENT (too many/large files, or',
    'ref+selector both), SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    paths: z.array(z.string()).min(1).max(MAX_DROP_FILES).describe('Absolute file paths to drop.'),
    mimeType: z
      .string()
      .optional()
      .describe('MIME type override applied to every file (defaults to extension-based).'),
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, _opts) => {
      validateDropPaths(args.paths)
      const files = await Promise.all(
        args.paths.map(async (filePath) => ({
          name: path.basename(filePath),
          type: mimeFor(filePath, args.mimeType),
          data: (await fs.readFile(filePath)).toString('base64'),
        })),
      )
      const result = await session.evaluate<DropEvalResult>('renderer', DROP_BODY, {
        selector,
        files,
      })
      if (result.ok !== true) {
        if (result.reason === 'no-match') {
          throw new StagewrightError(
            'SELECTOR_NO_MATCH',
            `drop target "${selector}" matched no element.`,
            { selector },
          )
        }
        throw new StagewrightError('BAD_ARGUMENT', `Invalid drop target selector: ${selector}`, {
          selector,
        })
      }
      return {
        target: selector,
        files: args.paths.length,
        default_prevented: result.default_prevented === true,
      }
    }),
})
