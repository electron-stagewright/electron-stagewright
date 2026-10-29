/**
 * Which tools of the verify-desktop-change recipe the running server lacks, so the instructions and
 * the recipe resource name the restart flags instead of pointing an agent at steps it cannot run.
 *
 * @module
 */

import { GENERATED_AGENT_RESOURCE_DOCUMENTS } from '../resources/generated-documents.js'
import { resolveCoreToolProfile, TOOL_PROFILES, type ToolProfile } from '../tools/profiles.js'
import type { AnyToolDefinition } from '../tools/types.js'

export const VERIFY_RECIPE_URI = 'stagewright://docs/verify-desktop-change'

/** `--plugin` short name for each first-party tool prefix the recipe uses. */
export const RECIPE_PLUGIN_PREFIXES: Readonly<Record<string, string>> = {
  native: 'native-ui',
  storage: 'storage',
}

/** Every concrete tool name the generated recipe mentions, in order of first mention. */
export function recipeToolNames(): readonly string[] {
  const recipe = GENERATED_AGENT_RESOURCE_DOCUMENTS.find((doc) => doc.uri === VERIFY_RECIPE_URI)
  const names = recipe?.text.match(/\b[a-z]+_[a-z_]*[a-z]\b/g) ?? []
  return [...new Set(names)].filter(
    (name) => name.startsWith('electron_') || toolPrefix(name) in RECIPE_PLUGIN_PREFIXES,
  )
}

function toolPrefix(name: string): string {
  return name.slice(0, name.indexOf('_'))
}

/**
 * One sentence naming the recipe tools this server lacks and the restart flags that add them, or
 * undefined when every recipe tool is registered.
 */
export function recipeCoverageNote(
  has: (name: string) => boolean,
  profile: ToolProfile | 'custom',
  coreDefinitions: readonly AnyToolDefinition[],
): string | undefined {
  const missing = recipeToolNames().filter((name) => !has(name))
  if (missing.length === 0) return undefined

  const missingCore = missing.filter((name) => name.startsWith('electron_'))
  const flags: string[] = []
  if (missingCore.length > 0 && profile !== 'custom') {
    const covering = TOOL_PROFILES.find((candidate) => {
      const names = new Set(resolveCoreToolProfile(coreDefinitions, candidate).map((d) => d.name))
      return missingCore.every((name) => names.has(name))
    })
    if (covering !== undefined) flags.push(`--tool-profile ${covering}`)
  }
  const plugins = new Set(
    missing
      .filter((name) => !name.startsWith('electron_'))
      .map((name) => RECIPE_PLUGIN_PREFIXES[toolPrefix(name)]),
  )
  for (const plugin of plugins) flags.push(`--plugin ${plugin}`)

  return [
    `This server lacks tools the verify-desktop-change recipe uses (${missing.join(', ')}).`,
    flags.length > 0
      ? `Ask the operator to restart it with ${flags.join(' ')}; until then, skip those steps.`
      : 'Skip those steps.',
  ].join(' ')
}
