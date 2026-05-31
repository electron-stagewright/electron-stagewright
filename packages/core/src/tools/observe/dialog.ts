/**
 * `electron_dialog_handler` — arm the session's auto-responder for native JS
 * dialogs (`alert` / `confirm` / `prompt` / `beforeunload`) and read back which
 * dialogs have fired. These dialogs block the renderer until something answers, so
 * an agent cannot respond to them turn-by-turn; instead it arms a policy ahead of
 * time and the session resolves each dialog the instant it appears.
 *
 * The tool is dual-purpose:
 *
 * - With `action` and/or `perType`, it ARMS a policy for future dialogs (optionally
 *   one-shot, optionally with `promptText` for `prompt()` accepts).
 * - With none of those, it is INSPECT-ONLY — it just returns the observed dialogs
 *   and the policy currently in effect, leaving the policy unchanged.
 *
 * @module
 */

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import type { DialogAction, DialogPolicy, DialogEvent, DialogType } from '../../transports/index.js'
import { sessionIdField } from '../schema.js'
import { type AnyToolDefinition, defineTool } from '../types.js'

/** Default cap on returned dialog events when the caller omits `limit`. */
const DEFAULT_LIMIT = 50
/** Hard ceiling on `limit` (matches the transport's dialog ring capacity). */
const MAX_LIMIT = 200

const dialogActionSchema = z.enum(['accept', 'dismiss'])
const dialogTypeSchema = z.enum(['alert', 'confirm', 'prompt', 'beforeunload'])

/**
 * Drop absent (undefined) keys from the validated per-type map so the policy holds
 * a clean `Partial<Record>` — Zod's optional fields infer a `| undefined` value
 * type that `exactOptionalPropertyTypes` rejects, even though at runtime an absent
 * key is simply not present.
 */
function toPerType(p: {
  readonly alert?: DialogAction | undefined
  readonly confirm?: DialogAction | undefined
  readonly prompt?: DialogAction | undefined
  readonly beforeunload?: DialogAction | undefined
}): Partial<Record<DialogType, DialogAction>> {
  return {
    ...(p.alert !== undefined ? { alert: p.alert } : {}),
    ...(p.confirm !== undefined ? { confirm: p.confirm } : {}),
    ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
    ...(p.beforeunload !== undefined ? { beforeunload: p.beforeunload } : {}),
  }
}

const DESCRIPTION = [
  'Arm the auto-responder for native JS dialogs (alert/confirm/prompt/beforeunload) and read which',
  'dialogs fired. Dialogs block the renderer, so the policy is applied automatically the instant one',
  'appears. Arming args (all optional): action (accept|dismiss — the default for every dialog),',
  'perType (per-kind overrides, e.g. {"confirm":"accept","beforeunload":"dismiss"}, falls back to action),',
  'promptText (text submitted to prompt() when it is accepted), oneShot (apply to exactly the next dialog,',
  'then revert to dismiss). With NO arming args the call is inspect-only and leaves the policy unchanged.',
  'Read args (all optional): type (one or more kinds to include), since (epoch ms), limit (max events,',
  'default 50, max 200 — most recent kept), clear (flush the whole buffer after reading).',
  'Until armed, the default policy is dismiss, so dialogs never hang the app.',
  'Returns: { ok, session_id, policy, entries: [{ type, message, action, defaultValue?, promptText?, timestamp }], count, overflowed }.',
  'overflowed counts dropped events across the whole buffer, not just the returned (type/since/limit-filtered) subset.',
  'Errors: NOT_RUNNING, BAD_ARGUMENT (promptText without an accepting prompt policy, or oneShot without a policy to arm).',
].join(' ')

/** `electron_dialog_handler` — arm the dialog auto-responder and read observed dialogs. */
export const dialogHandlerTool: AnyToolDefinition = defineTool({
  name: 'electron_dialog_handler',
  title: 'Handle native dialogs',
  description: DESCRIPTION,
  inputSchema: z.object({
    action: dialogActionSchema
      .optional()
      .describe(
        'Default response for every dialog. Omit (with no perType) for an inspect-only call.',
      ),
    perType: z
      .object({
        alert: dialogActionSchema.optional(),
        confirm: dialogActionSchema.optional(),
        prompt: dialogActionSchema.optional(),
        beforeunload: dialogActionSchema.optional(),
      })
      .optional()
      .describe('Per-kind response overrides; a kind not listed falls back to action.'),
    promptText: z
      .string()
      .optional()
      .describe('Text submitted to prompt() dialogs when they are accepted.'),
    oneShot: z
      .boolean()
      .optional()
      .describe('Apply the policy to exactly the next dialog, then revert to dismiss.'),
    type: z
      .union([dialogTypeSchema, z.array(dialogTypeSchema).min(1)])
      .optional()
      .describe('Dialog kind(s) to include when reading, e.g. "confirm" or ["confirm","prompt"].'),
    since: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Only events with timestamp >= this (epoch ms).'),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max events to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); keeps the most recent.`,
      ),
    clear: z
      .boolean()
      .optional()
      .describe('Flush the entire dialog buffer after reading (not just the returned subset).'),
    sessionId: sessionIdField,
  }),
  operationType: 'dialog',
  handler: async (args, ctx) => {
    const managed = ctx.sessions.resolve(args.sessionId)
    const meta = { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id }

    const arming = args.action !== undefined || args.perType !== undefined

    // promptText only does anything when prompt() dialogs are accepted. Reject the
    // meaningless combination rather than silently ignore it (mirrors the
    // screenshot tool's quality+png guard).
    if (args.promptText !== undefined) {
      const effectiveForPrompt = args.perType?.prompt ?? args.action
      if (effectiveForPrompt !== 'accept') {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message:
            'promptText is only valid when prompt dialogs are accepted; set action:"accept" or perType.prompt:"accept".',
        })
      }
    }

    // oneShot describes how an armed policy expires; without a policy to arm it is meaningless.
    if (args.oneShot === true && !arming) {
      return makeError('BAD_ARGUMENT', {
        ...meta,
        message: 'oneShot requires a policy to arm; set action or perType.',
      })
    }

    if (arming) {
      const policy: DialogPolicy = {
        // When only perType is given, the catch-all default stays the safe dismiss.
        action: args.action ?? 'dismiss',
        ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
        ...(args.perType !== undefined ? { perType: toPerType(args.perType) } : {}),
        ...(args.oneShot !== undefined ? { oneShot: args.oneShot } : {}),
      }
      await managed.session.setDialogPolicy(policy)
    }

    const { entries, overflowed, policy } = await managed.session.dialogEvents(
      args.clear !== undefined ? { clear: args.clear } : {},
    )

    const types = args.type === undefined ? undefined : new Set<string>([args.type].flat())
    const filtered = entries.filter(
      (event: DialogEvent) =>
        (types === undefined || types.has(event.type)) &&
        (args.since === undefined || event.timestamp >= args.since),
    )
    const limit = args.limit ?? DEFAULT_LIMIT
    // Keep the most recent `limit` events (the buffer is oldest-first).
    const kept = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered

    return makeSuccess(
      { session_id: managed.id, policy, entries: kept, count: kept.length, overflowed },
      meta,
    )
  },
})
