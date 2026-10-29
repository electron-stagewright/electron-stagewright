/**
 * Which tools of the verify-desktop-change recipe the running server lacks, so the instructions and
 * the recipe resource name the restart flags instead of pointing an agent at steps it cannot run.
 *
 * @module
 */

import { GENERATED_AGENT_RESOURCE_DOCUMENTS, VERIFY_RECIPE_URI } from '../resources/index.js'
import { coveringToolProfile, type ToolProfile } from '../tools/profiles.js'
import type { AnyToolDefinition } from '../tools/types.js'

/** `--plugin` short name for each first-party tool prefix the recipe uses. */
export const RECIPE_PLUGIN_PREFIXES: Readonly<Record<string, string>> = {
  native: 'native-ui',
  storage: 'storage',
}

const RECIPE_TEXT =
  GENERATED_AGENT_RESOURCE_DOCUMENTS.find((doc) => doc.uri === VERIFY_RECIPE_URI)?.text ?? ''

/** Every concrete tool name the recipe mentions, in order of first mention. */
export function recipeToolNames(text: string = RECIPE_TEXT): readonly string[] {
  const names = text.match(/\b[a-z]+_[a-z_]*[a-z]\b/g) ?? []
  return [...new Set(names)].filter(
    (name) => isCoreTool(name) || Object.hasOwn(RECIPE_PLUGIN_PREFIXES, toolPrefix(name)),
  )
}

function isCoreTool(name: string): boolean {
  return name.startsWith('electron_')
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
  const recipeTools = recipeToolNames()
  const missing = recipeTools.filter((name) => !has(name))
  if (missing.length === 0) return undefined

  const flags: string[] = []
  if (missing.some(isCoreTool) && profile !== 'custom') {
    const covering = coveringToolProfile(coreDefinitions, profile, recipeTools.filter(isCoreTool))
    if (covering !== undefined) flags.push(`--tool-profile ${covering}`)
  }
  const plugins = new Set(
    missing
      .filter((name) => !isCoreTool(name))
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
