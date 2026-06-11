/**
 * Shared dialog auto-response policy resolution, used by every transport that
 * captures native JS dialogs (Playwright today, CDP's
 * `Page.javascriptDialogOpening` as well). Extracted so the per-type override,
 * prompt-text, and one-shot semantics can never drift between transports.
 *
 * @module
 */

import type { DialogAction, DialogPolicy, DialogType } from './types.js'

/** The concrete response a transport must apply to one dialog. */
export interface ResolvedDialogResponse {
  /** The action the policy selects for this dialog type. */
  readonly action: DialogAction
  /** Text to submit when accepting a `prompt()`; undefined otherwise. */
  readonly promptText?: string
}

/**
 * Resolve the response for a dialog of `type` under `policy`: per-type override
 * first, then the default action; `promptText` only applies to an accepted
 * `prompt()`.
 */
export function resolveDialogResponse(policy: DialogPolicy, type: string): ResolvedDialogResponse {
  const action: DialogAction = policy.perType?.[type as DialogType] ?? policy.action
  const promptText = action === 'accept' && type === 'prompt' ? policy.promptText : undefined
  return { action, ...(promptText !== undefined ? { promptText } : {}) }
}

/** Deep-copy a policy so callers can never mutate the session's active policy. */
export function copyDialogPolicy(policy: DialogPolicy): DialogPolicy {
  return {
    action: policy.action,
    ...(policy.promptText !== undefined ? { promptText: policy.promptText } : {}),
    ...(policy.perType !== undefined ? { perType: { ...policy.perType } } : {}),
    ...(policy.oneShot !== undefined ? { oneShot: policy.oneShot } : {}),
  }
}
