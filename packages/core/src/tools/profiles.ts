/**
 * Explicit core-tool profiles. Profiles reduce the manifest a host sends to an
 * agent without changing the default surface: `full` always contains every
 * non-eval core tool, while eval tools compose independently with the existing
 * per-target authorization policy.
 *
 * @module
 */

import type { AnyToolDefinition } from './types.js'

/** The profile identifiers accepted by the public server API and CLI. */
export const TOOL_PROFILES = ['essential', 'testing', 'debug', 'full'] as const

/** One supported core tool-profile identifier. */
export type ToolProfile = (typeof TOOL_PROFILES)[number]

/** The primary launch → observe → interact → assert workflow, measured below the 12K BPE target. */
export const ESSENTIAL_CORE_TOOL_NAMES = [
  'electron_launch',
  'electron_status',
  'electron_info',
  'electron_stop',
  'electron_snapshot',
  'electron_find',
  'electron_click',
  'electron_type',
  'electron_key',
  'electron_clear_input',
  'electron_select_option',
  'electron_check',
  'electron_uncheck',
  'electron_scroll',
  'electron_scroll_into_view',
  'electron_get_text',
  'electron_get_value',
  'electron_get_state',
  'electron_exists',
  'electron_wait_for_selector',
  'electron_wait_for_state',
  'electron_expect_text',
  'electron_expect_value',
  'electron_expect_visible',
  'electron_expect_state',
  'electron_expect_count',
  'electron_expect_url',
] as const

/** The broad interaction/read/assertion and screenshot-evidence surface for automated tests. */
export const TESTING_CORE_TOOL_NAMES = [
  ...ESSENTIAL_CORE_TOOL_NAMES,
  'electron_attach',
  'electron_windows_list',
  'electron_switch_window',
  'electron_surfaces_list',
  'electron_switch_surface',
  'electron_detach',
  'electron_hover',
  'electron_drag',
  'electron_drop_file',
  'electron_keyboard_type',
  'electron_type_into_editor',
  'electron_press_sequence',
  'electron_set_files',
  'electron_get_attribute',
  'electron_get_bbox',
  'electron_get_computed_style',
  'electron_focused_element',
  'electron_elements_list',
  'electron_screenshot',
  'electron_wait',
  'electron_wait_for_event',
  'electron_assert_pattern',
] as const

/** The inspect/attach/diagnostic surface for understanding a running application. */
export const DEBUG_CORE_TOOL_NAMES = [
  ...ESSENTIAL_CORE_TOOL_NAMES,
  'electron_doctor',
  'electron_attach',
  'electron_inject',
  'electron_windows_list',
  'electron_switch_window',
  'electron_surfaces_list',
  'electron_switch_surface',
  'electron_discover_running',
  'electron_detach',
  'electron_force_kill',
  'electron_get_attribute',
  'electron_get_bbox',
  'electron_get_computed_style',
  'electron_focused_element',
  'electron_elements_list',
  'electron_wait',
  'electron_wait_for_event',
  'electron_screenshot',
  'electron_console_logs',
  'electron_dialog_handler',
] as const

const NAMED_PROFILE_TOOLS: Readonly<Record<Exclude<ToolProfile, 'full'>, readonly string[]>> = {
  essential: ESSENTIAL_CORE_TOOL_NAMES,
  testing: TESTING_CORE_TOOL_NAMES,
  debug: DEBUG_CORE_TOOL_NAMES,
}

/** Return true when a raw string is a supported {@link ToolProfile}. */
export function isToolProfile(value: string): value is ToolProfile {
  return (TOOL_PROFILES as readonly string[]).includes(value)
}

/**
 * Resolve a profile into concrete definitions. Eval-gated definitions intentionally remain in
 * every profile: the dispatcher continues to own their existing target-specific visibility gate.
 */
export function resolveCoreToolProfile(
  definitions: Iterable<AnyToolDefinition>,
  profile: ToolProfile = 'full',
): readonly AnyToolDefinition[] {
  if (!isToolProfile(profile)) {
    throw new Error(`Unknown core tool profile: ${String(profile)}`)
  }
  const all = [...definitions]
  const safe = all.filter((definition) => definition.requiresEvalFlag !== true)
  const selectedNames = selectedSafeNames(profile, safe)
  const selected = all.filter(
    (definition) => definition.requiresEvalFlag === true || selectedNames.has(definition.name),
  )
  return selected.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Map each safe core tool excluded by `profile` to the first alternative profile that contains it.
 * The dispatcher uses this only to turn an otherwise opaque unknown-tool error into an actionable
 * restart hint; eval-gated tools remain governed by the more specific eval-policy hint.
 */
export function excludedCoreToolProfileHints(
  definitions: Iterable<AnyToolDefinition>,
  profile: ToolProfile,
): ReadonlyMap<string, ToolProfile> {
  const safe = [...definitions].filter((definition) => definition.requiresEvalFlag !== true)
  const selectedNames = selectedSafeNames(profile, safe)
  const alternatives = TOOL_PROFILES.filter((candidate) => candidate !== profile)
  const hints = new Map<string, ToolProfile>()
  for (const definition of safe) {
    if (selectedNames.has(definition.name)) continue
    const alternative = alternatives.find((candidate) =>
      selectedSafeNames(candidate, safe).has(definition.name),
    )
    if (alternative !== undefined) hints.set(definition.name, alternative)
  }
  return hints
}

function selectedSafeNames(
  profile: ToolProfile,
  safeDefinitions: readonly AnyToolDefinition[],
): ReadonlySet<string> {
  if (profile === 'full') return new Set(safeDefinitions.map((definition) => definition.name))

  const names = NAMED_PROFILE_TOOLS[profile]
  const available = new Set(safeDefinitions.map((definition) => definition.name))
  const missing = names.filter((name) => !available.has(name))
  if (missing.length > 0) {
    throw new Error(
      `Tool profile "${profile}" references missing core tool(s): ${missing.join(', ')}.`,
    )
  }
  return new Set(names)
}
