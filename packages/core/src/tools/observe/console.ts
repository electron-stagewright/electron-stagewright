/**
 * `electron_console_logs` — read the session's captured renderer console output,
 * with query-time filters (type, text regex, time range) so an agent pulls only
 * the entries it needs. Surfaces `overflowed` when the rolling buffer dropped
 * older entries, so the agent knows the view is incomplete.
 *
 * @module
 */

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import type { ConsoleEntry } from '../../transports/index.js'
import { sessionIdField } from '../schema.js'
import { type AnyToolDefinition, defineTool } from '../types.js'

/** Default cap on returned entries when the caller omits `limit`. */
const DEFAULT_LIMIT = 200
/** Hard ceiling on `limit`. */
const MAX_LIMIT = 1000

const DESCRIPTION = [
  'Read the captured renderer console output for the session, newest-relevant entries last.',
  'Filters (all optional, ANDed): type (one or more of log/info/warning/error/debug/...),',
  'match (a regular expression the text must match), since (epoch ms — only entries at/after it),',
  'limit (max entries, default 200, max 1000 — the most recent are kept).',
  'Returns: { ok, session_id, entries: [{ type, text, timestamp, location? }], count, overflowed }.',
  'overflowed is the number of older entries the buffer dropped. Errors: NOT_RUNNING,',
  'BAD_ARGUMENT (invalid regex, or multiple sessions).',
].join(' ')

/** `electron_console_logs` — filtered read of the session console buffer. */
export const consoleLogsTool: AnyToolDefinition = defineTool({
  name: 'electron_console_logs',
  title: 'Read console logs',
  description: DESCRIPTION,
  inputSchema: z.object({
    type: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe('Console level(s) to include, e.g. "error" or ["warning", "error"].'),
    match: z.string().optional().describe('Regular expression the entry text must match.'),
    since: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Only entries with timestamp >= this (epoch ms).'),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max entries to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); keeps the most recent.`,
      ),
    sessionId: sessionIdField,
  }),
  operationType: 'logs',
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }

    let matcher: RegExp | undefined
    if (args.match !== undefined) {
      try {
        matcher = new RegExp(args.match)
      } catch (err) {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message: `Invalid match regular expression: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    const types = args.type === undefined ? undefined : new Set([args.type].flat())
    const { entries, overflowed } = await managed.session.consoleLogs()
    const filtered = entries.filter(
      (entry: ConsoleEntry) =>
        (types === undefined || types.has(entry.type)) &&
        (matcher === undefined || matcher.test(entry.text)) &&
        (args.since === undefined || entry.timestamp >= args.since),
    )
    const limit = args.limit ?? DEFAULT_LIMIT
    // Keep the most recent `limit` entries (the buffer is oldest-first).
    const kept = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered

    return makeSuccess(
      { session_id: managed.id, entries: kept, count: kept.length, overflowed },
      meta,
    )
  },
})
