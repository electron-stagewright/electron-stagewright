/**
 * Host-visible MCP manifest measurement. The collector drives a real in-memory
 * MCP client/server pair and counts the exact `{ tools }` value returned to the
 * host — never the dispatcher's richer documentation projection.
 *
 * @module
 */

import { Buffer } from 'node:buffer'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer, type StagewrightPlugin, type ToolProfile } from '@electron-stagewright/core'
import a11yPlugin from '@electron-stagewright/plugin-a11y'
import clockPlugin from '@electron-stagewright/plugin-clock'
import ipcPlugin from '@electron-stagewright/plugin-ipc'
import nativeUiPlugin from '@electron-stagewright/plugin-native-ui'
import networkPlugin from '@electron-stagewright/plugin-network'
import productionPlugin from '@electron-stagewright/plugin-production'
import storagePlugin from '@electron-stagewright/plugin-storage'
import tracePlugin from '@electron-stagewright/plugin-trace'

import { countRealTokens } from './tokenizer.js'

/** The first-party plugins, ordered by their public package name. */
export const FIRST_PARTY_PLUGINS: readonly StagewrightPlugin[] = [
  a11yPlugin,
  clockPlugin,
  ipcPlugin,
  nativeUiPlugin,
  networkPlugin,
  productionPlugin,
  storagePlugin,
  tracePlugin,
]

/** A minimal structural view of an MCP tool result sufficient for serialization and ranking. */
export interface HostTool {
  readonly name: string
}

/** One tool's serialized contribution to a manifest. */
export interface ToolCost {
  readonly name: string
  readonly characters: number
  readonly utf8Bytes: number
  readonly bpe: number
}

/** Deterministic measurements of one host-visible `{ tools }` payload. */
export interface ManifestMeasurement {
  readonly toolCount: number
  /** Unicode code points in the serialized `{ tools }` payload. */
  readonly characters: number
  readonly utf8Bytes: number
  readonly bpe: number
  /** Canonical order supplied to the host, pinned to detect order/cache regressions. */
  readonly toolNames: readonly string[]
  /** The ten largest individual tool entries by BPE (then name). */
  readonly topTools: readonly ToolCost[]
}

/** One named manifest configuration captured in the committed budget baseline. */
export interface ManifestVariant {
  readonly id: string
  readonly toolProfile: ToolProfile
  readonly allowEval: boolean
  readonly plugins: readonly StagewrightPlugin[]
}

/** A committed collection of measurements, intentionally free of timestamps for deterministic diffs. */
export interface ManifestBaseline {
  readonly schemaVersion: 1
  /** Mandatory human explanation whenever the baseline is written or re-written. */
  readonly reason: string
  readonly variants: Readonly<Record<string, ManifestMeasurement>>
}

/** A human-readable mismatch reported by {@link checkManifestBaseline}. */
export interface ManifestBudgetViolation {
  readonly variant: string
  readonly message: string
}

const CORE_PROFILES: readonly ToolProfile[] = ['essential', 'testing', 'debug', 'full']

/** All deterministic core, per-plugin, and aggregate manifest configurations. */
export const MANIFEST_VARIANTS: readonly ManifestVariant[] = [
  { id: 'core-safe', toolProfile: 'full', allowEval: false, plugins: [] },
  { id: 'core-eval', toolProfile: 'full', allowEval: true, plugins: [] },
  ...CORE_PROFILES.filter((profile) => profile !== 'full').flatMap((toolProfile) => [
    { id: `${toolProfile}-safe`, toolProfile, allowEval: false, plugins: [] },
    { id: `${toolProfile}-eval`, toolProfile, allowEval: true, plugins: [] },
  ]),
  ...FIRST_PARTY_PLUGINS.flatMap((plugin) => [
    {
      id: `plugin-${plugin.name}-safe`,
      toolProfile: 'full' as const,
      allowEval: false,
      plugins: [plugin],
    },
    {
      id: `plugin-${plugin.name}-eval`,
      toolProfile: 'full' as const,
      allowEval: true,
      plugins: [plugin],
    },
  ]),
  { id: 'all-safe', toolProfile: 'full', allowEval: false, plugins: FIRST_PARTY_PLUGINS },
  { id: 'all-eval', toolProfile: 'full', allowEval: true, plugins: FIRST_PARTY_PLUGINS },
]

/** Measure a parsed MCP `tools/list` value exactly as the host receives its `tools` member. */
export function measureHostManifest(tools: readonly HostTool[]): ManifestMeasurement {
  const toolNames = tools.map((tool) => tool.name)
  const expectedOrder = [...toolNames].sort((a, b) => a.localeCompare(b))
  if (toolNames.some((name, index) => name !== expectedOrder[index])) {
    throw new Error('MCP tools/list is not in canonical name order.')
  }
  const payload = JSON.stringify({ tools })
  const topTools = tools
    .map((tool) => {
      const serialized = JSON.stringify(tool)
      return {
        name: tool.name,
        characters: Array.from(serialized).length,
        utf8Bytes: Buffer.byteLength(serialized, 'utf8'),
        bpe: countRealTokens(serialized),
      }
    })
    .sort((a, b) => b.bpe - a.bpe || a.name.localeCompare(b.name))
    .slice(0, 10)
  return {
    toolCount: tools.length,
    characters: Array.from(payload).length,
    utf8Bytes: Buffer.byteLength(payload, 'utf8'),
    bpe: countRealTokens(payload),
    toolNames,
    topTools,
  }
}

/** Start a real in-memory MCP client/server pair and collect one host-visible manifest variant. */
export async function collectManifestVariant(
  variant: ManifestVariant,
): Promise<ManifestMeasurement> {
  const server = await createServer({
    toolProfile: variant.toolProfile,
    allowEval: variant.allowEval,
    ...(variant.plugins.length > 0 ? { plugins: variant.plugins } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: `manifest-${variant.id}`, version: '0.0.0' })
  try {
    await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)])
    const { tools } = await client.listTools()
    return measureHostManifest(tools)
  } finally {
    await client.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}

/** Collect every defined variant sequentially so stateful plugins never overlap in one process. */
export async function collectManifestMeasurements(): Promise<
  Readonly<Record<string, ManifestMeasurement>>
> {
  const measurements: Record<string, ManifestMeasurement> = {}
  for (const variant of MANIFEST_VARIANTS) {
    measurements[variant.id] = await collectManifestVariant(variant)
  }
  return measurements
}

/** Construct a valid baseline only when its operator-supplied reason is non-empty. */
export function createManifestBaseline(
  reason: string,
  variants: Readonly<Record<string, ManifestMeasurement>>,
): ManifestBaseline {
  if (reason.trim().length === 0) {
    throw new Error('A non-empty --reason is required when updating the manifest baseline.')
  }
  return { schemaVersion: 1, reason: reason.trim(), variants }
}

/**
 * Return every baseline violation. Growth is budgeted on BPE because it models context cost; all
 * other fields remain in the baseline for review and deterministic ordering checks.
 */
export function checkManifestBaseline(
  current: Readonly<Record<string, ManifestMeasurement>>,
  baseline: ManifestBaseline,
  maxGrowth = 0.03,
): ManifestBudgetViolation[] {
  const violations: ManifestBudgetViolation[] = []
  if (baseline.reason.trim().length === 0) {
    violations.push({ variant: 'baseline', message: 'baseline reason must not be empty' })
  }
  for (const [id, measurement] of Object.entries(current)) {
    const previous = baseline.variants[id]
    if (previous === undefined) {
      violations.push({
        variant: id,
        message: `missing baseline; re-run with --update-manifest-baseline --reason <why>`,
      })
      continue
    }
    const limit = Math.floor(previous.bpe * (1 + maxGrowth))
    if (measurement.bpe > limit) {
      const growth = ((measurement.bpe - previous.bpe) / previous.bpe) * 100
      violations.push({
        variant: id,
        message: `BPE grew ${growth.toFixed(1)}% (${previous.bpe} → ${measurement.bpe}; limit ${limit}); re-baseline explicitly with --reason`,
      })
    }
    if (measurement.toolNames.join('\u0000') !== previous.toolNames.join('\u0000')) {
      violations.push({
        variant: id,
        message: 'canonical tool names/order changed; review the manifest baseline explicitly',
      })
    }
  }
  for (const id of Object.keys(baseline.variants)) {
    if (current[id] === undefined) {
      violations.push({ variant: id, message: 'baseline variant is no longer collected' })
    }
  }
  return violations
}
