/**
 * Tool reference generator.
 *
 * Renders the dispatcher's machine-readable manifest ({@link ToolManifestEntry}[]) to a Markdown
 * catalog of every registered tool. The manifest is the single source of truth — the dispatcher
 * already exposes it for `tools/list` — so this is a pure projection of it, not a hand-maintained
 * doc that could drift. A committed `TOOL-REFERENCE.md` is generated from this and guarded by a
 * sync test, so a tool change that is not reflected in the catalog fails CI.
 *
 * The output is DETERMINISTIC (tools sorted by name, grouped by operation type, no timestamp) so
 * the sync check can compare it byte-for-byte against the committed file.
 *
 * The descriptions and titles rendered here are first-party content (authored on each tool), not
 * untrusted captured data, so they are emitted as prose; only table CELLS escape the Markdown
 * pipe so a parameter description containing `|` cannot break the column layout.
 *
 * @module
 */

import type { ToolManifestEntry } from '../server/dispatcher.js'

/** Escape a value for a Markdown table cell: collapse newlines and escape the column separator. */
function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

/**
 * Derive a short, human-readable type label for one JSON Schema property (the rendered shape of a
 * Zod field). Falls back progressively: a named `type`, an `enum` union, an `anyOf`/`oneOf` union,
 * a `$ref` (nested object), else `any`.
 */
function jsonSchemaType(prop: Record<string, unknown>): string {
  const type = prop['type']
  if (typeof type === 'string') {
    if (type === 'array') {
      const items = prop['items']
      if (items !== null && typeof items === 'object') {
        const itemType = (items as Record<string, unknown>)['type']
        if (typeof itemType === 'string') return `${itemType}[]`
      }
      return 'array'
    }
    return type
  }
  if (Array.isArray(prop['enum']))
    return (prop['enum'] as unknown[]).map((v) => String(v)).join(' | ')
  if (Array.isArray(prop['anyOf']) || Array.isArray(prop['oneOf'])) return 'union'
  if (typeof prop['$ref'] === 'string') return 'object'
  return 'any'
}

/** Render a tool's input schema as a parameter table, or a "no parameters" note when it has none. */
function paramTable(schema: Record<string, unknown>): string {
  const props = schema['properties']
  if (props === null || typeof props !== 'object' || Object.keys(props as object).length === 0) {
    return '_No parameters._'
  }
  const required = new Set(
    Array.isArray(schema['required'])
      ? (schema['required'] as unknown[]).map((v) => String(v))
      : [],
  )
  const rows = Object.entries(props as Record<string, unknown>)
    .map(([name, raw]) => {
      const prop = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const type = escapeCell(jsonSchemaType(prop))
      const req = required.has(name) ? 'yes' : 'no'
      const description = typeof prop['description'] === 'string' ? prop['description'] : ''
      return `| \`${name}\` | ${type} | ${req} | ${escapeCell(description)} |`
    })
    .join('\n')
  return `| Parameter | Type | Required | Description |\n| --- | --- | --- | --- |\n${rows}`
}

/** Render one tool as a Markdown section: heading, title, description, metadata, parameter table. */
function toolSection(entry: ToolManifestEntry): string {
  const meta = [`Operation: \`${entry.operationType}\``]
  if (entry.requiresEvalFlag === true) {
    const flag =
      entry.evalTarget !== undefined ? `--allow-eval=${entry.evalTarget}` : '--allow-eval'
    meta.push(`Requires \`${flag}\``)
  }
  const lines = [`### \`${entry.name}\``, '']
  if (entry.title !== undefined) lines.push(`**${entry.title}**`, '')
  lines.push(
    entry.description,
    '',
    `- ${meta.join(' · ')}`,
    '',
    paramTable(entry.inputJsonSchema),
    '',
  )
  return lines.join('\n')
}

/** Title-case an operation type into a group heading, e.g. `command` -> `Command tools`. */
function groupHeading(operationType: string): string {
  const titled = operationType.charAt(0).toUpperCase() + operationType.slice(1)
  return `${titled} tools`
}

/**
 * GitHub-style heading anchor: lowercase, drop punctuation EXCEPT hyphen and underscore (GitHub
 * keeps both), then spaces to hyphens. Keeping `_` matters for operation types like `window_info`,
 * whose heading anchors to `window_info-tools` — stripping the underscore would break the ToC link.
 */
function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-')
}

/**
 * Render a tool manifest to a self-describing Markdown reference. Tools are sorted by name and
 * grouped by operation type, with a table of contents; the output is deterministic so a committed
 * copy can be byte-compared by the sync test. Pass the manifest from
 * `dispatcher.listManifest()` (build it with `allowEval: true` to include the eval-gated tools,
 * which are then marked with their required `--allow-eval` target).
 */
export function renderToolReference(manifest: readonly ToolManifestEntry[]): string {
  const sorted = [...manifest].sort((a, b) => a.name.localeCompare(b.name))
  const groups = new Map<string, ToolManifestEntry[]>()
  for (const entry of sorted) {
    const group = groups.get(entry.operationType) ?? []
    group.push(entry)
    groups.set(entry.operationType, group)
  }
  const operationTypes = [...groups.keys()].sort()
  const hasEvalGated = sorted.some((e) => e.requiresEvalFlag === true)

  const out: string[] = ['# Tool reference', '']
  out.push(
    '> Generated from the dispatcher manifest — do not edit by hand. Run `pnpm docs:tools` to regenerate.',
    '',
  )
  out.push(
    `The server exposes ${sorted.length} tools across ${operationTypes.length} operation ${
      operationTypes.length === 1 ? 'type' : 'types'
    }.${
      hasEvalGated
        ? ' Tools marked with a "Requires `--allow-eval…`" label register only when the eval policy permits that target.'
        : ''
    }`,
    '',
  )

  out.push('## Contents', '')
  for (const operationType of operationTypes) {
    const heading = groupHeading(operationType)
    out.push(`- [${heading}](#${anchor(heading)}) (${groups.get(operationType)?.length ?? 0})`)
  }
  out.push('')

  for (const operationType of operationTypes) {
    out.push(`## ${groupHeading(operationType)}`, '')
    for (const entry of groups.get(operationType) ?? []) out.push(toolSection(entry))
  }

  // Collapse any accidental run of blank lines and end with exactly one trailing newline so the
  // committed file is stable under the byte-for-byte sync check.
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}
