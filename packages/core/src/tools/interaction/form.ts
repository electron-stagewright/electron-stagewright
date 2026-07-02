/**
 * Form interaction tools: `electron_select_option`, `electron_check`,
 * `electron_uncheck`, `electron_set_files`.
 *
 * `set_files` validates its paths in-process (the MCP server host is where the
 * paths live): each must be absolute and exist, with a sanity cap on count and
 * size so a glob-expanded list or a huge binary fails fast instead of wedging
 * the transport.
 *
 * @module
 */

import { statSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { StagewrightError } from '../../errors/registry.js'
import { assertPathsWithinAppRoot } from '../app-root.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { refField, selectorField, sessionIdField, forceField, timeoutField } from './schema.js'
import { runTargetedInteraction } from './target.js'

/** Max files a single `set_files` call accepts. */
const MAX_FILES = 20
/** Max size (bytes) of any single file passed to `set_files`. */
const MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * Validate file paths for `set_files`: absolute, existing, regular files, within
 * the count and size caps. Throws a registered {@link StagewrightError} the tool
 * layer surfaces as `ABSOLUTE_PATH_REQUIRED` / `FILE_NOT_FOUND` / `BAD_ARGUMENT`.
 */
function validateFilePaths(paths: readonly string[]): void {
  if (paths.length > MAX_FILES) {
    throw new StagewrightError(
      'BAD_ARGUMENT',
      `Too many files: ${paths.length} (max ${MAX_FILES}).`,
      { count: paths.length, max: MAX_FILES },
    )
  }
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
    if (stat.size > MAX_FILE_BYTES) {
      throw new StagewrightError(
        'BAD_ARGUMENT',
        `File too large: ${filePath} (${stat.size} > ${MAX_FILE_BYTES} bytes).`,
        { path: filePath, size: stat.size, max: MAX_FILE_BYTES },
      )
    }
  }
}

/** `electron_select_option` — choose option(s) by value in a <select>. */
export const selectOptionTool: AnyToolDefinition = defineTool({
  name: 'electron_select_option',
  title: 'Select option(s) in a dropdown',
  description: [
    'Select option(s) by value in the <select> identified by ref or selector. Options: force, timeoutMs.',
    'Returns: { ok, session_id, target, selected } (selected = the values actually chosen).',
    'Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'ELEMENT_DISABLED, NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    values: z.array(z.string()).min(1).describe('Option values to select.'),
    force: forceField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, opts) => {
      const selected = await session.selectOption(selector, args.values, opts)
      return { target: selector, selected }
    }),
})

/** `electron_check` — check a checkbox / radio. */
export const checkTool: AnyToolDefinition = defineTool({
  name: 'electron_check',
  title: 'Check a checkbox or radio',
  description: [
    'Check the checkbox/radio identified by ref or selector (no-op if already checked).',
    'Options: force, timeoutMs. Returns: { ok, session_id, target, checked: true }.',
    'Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'ELEMENT_DISABLED, NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    force: forceField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, opts) => {
      await session.setChecked(selector, true, opts)
      return { target: selector, checked: true }
    }),
})

/** `electron_uncheck` — uncheck a checkbox / radio. */
export const uncheckTool: AnyToolDefinition = defineTool({
  name: 'electron_uncheck',
  title: 'Uncheck a checkbox',
  description: [
    'Uncheck the checkbox identified by ref or selector (no-op if already unchecked).',
    'Options: force, timeoutMs. Returns: { ok, session_id, target, checked: false }.',
    'Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable),',
    'ELEMENT_DISABLED, NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    force: forceField,
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, opts) => {
      await session.setChecked(selector, false, opts)
      return { target: selector, checked: false }
    }),
})

/** `electron_set_files` — set the files of a file input (absolute paths). */
export const setFilesTool: AnyToolDefinition = defineTool({
  name: 'electron_set_files',
  title: 'Set files on a file input',
  description: [
    'Set the files of the <input type=file> identified by ref or selector. Paths must be ABSOLUTE and',
    `exist on the host running the server (max ${MAX_FILES} files, ${MAX_FILE_BYTES} bytes each).`,
    'Options: timeoutMs. Returns: { ok, session_id, target, files }.',
    'Errors: ABSOLUTE_PATH_REQUIRED (relative path; not retryable), FILE_NOT_FOUND (missing path),',
    'BAD_ARGUMENT (too many/large files, or ref+selector both), SELECTOR_NO_MATCH / REF_NOT_FOUND',
    '(carries similar_refs), NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    paths: z.array(z.string()).min(1).describe('Absolute file paths to attach.'),
    timeoutMs: timeoutField,
    sessionId: sessionIdField,
  }),
  operationType: 'command',
  handler: (args, ctx) =>
    runTargetedInteraction(ctx, args, async (session, selector, opts) => {
      validateFilePaths(args.paths)
      // Same confinement launch enforces: with --app-root set, the host files handed
      // to the file input must live inside the root.
      assertPathsWithinAppRoot(ctx.appRoot, args.paths)
      await session.setInputFiles(selector, args.paths, opts)
      return { target: selector, files: args.paths.length }
    }),
})
