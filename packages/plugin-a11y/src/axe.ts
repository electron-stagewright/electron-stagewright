/**
 * Fixed renderer-side axe-core installation and bounded result compaction.
 *
 * The plugin resolves the engine from its declared dependency. It sends the
 * sizeable source only for a renderer cache miss; ordinary audits send a small
 * fixed body plus structured arguments. Agent input is data only, never code.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical'

export interface AuditRequest {
  readonly scope?: string | undefined
  readonly include?: readonly string[] | undefined
  readonly exclude?: readonly string[] | undefined
  readonly tags?: readonly string[] | undefined
  readonly rules?: readonly string[] | undefined
  readonly impactMin?: Impact | undefined
  readonly maxViolations: number
  readonly maxNodesPerViolation: number
}

interface AxeBundle {
  readonly source: string
  readonly marker: string
}

export interface AxeInstallBody {
  readonly body: string
  /** Exact UTF-8 payload sent to the renderer for this fixed installation body. */
  readonly transferredBytes: number
}

let cachedBundle: AxeBundle | undefined
let cachedInstallBody: AxeInstallBody | undefined

/** Read and fingerprint the exact axe minified asset Node resolves beside this plugin. */
function loadBundle(): AxeBundle {
  if (cachedBundle !== undefined) return cachedBundle
  const require = createRequire(import.meta.url)
  const source = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
  cachedBundle = {
    source,
    marker: `axe-core-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`,
  }
  return cachedBundle
}

/**
 * Build the fixed, sizeable cache-fill body. It never interpolates agent input.
 * The host retains a per-session/surface cache marker, but the body is also
 * idempotent so a reload race cannot install a second engine in one document.
 */
export function buildAxeInstallBody(): AxeInstallBody {
  if (cachedInstallBody !== undefined) return cachedInstallBody
  const bundle = loadBundle()
  const body = `
const engineKey = Symbol.for('electron-stagewright.a11y.axe-engine');
const markerKey = Symbol.for('electron-stagewright.a11y.axe-marker');
if (globalThis[markerKey] !== ${JSON.stringify(bundle.marker)} || typeof globalThis[engineKey]?.run !== 'function') {
  const priorAxe = Object.getOwnPropertyDescriptor(globalThis, 'axe');
  let installedAxe;
  try {
${bundle.source}
    installedAxe = globalThis.axe;
  } finally {
    if (priorAxe === undefined) delete globalThis.axe;
    else Object.defineProperty(globalThis, 'axe', priorAxe);
  }
  globalThis[engineKey] = installedAxe;
  globalThis[markerKey] = ${JSON.stringify(bundle.marker)};
}
if (!globalThis[engineKey] || typeof globalThis[engineKey].run !== 'function') {
  return { kind: 'engine_error', message: 'axe-core did not expose a run function after installation.' };
}
return { kind: 'installed' };
`
  cachedInstallBody = { body, transferredBytes: Buffer.byteLength(body) }
  return cachedInstallBody
}

/**
 * Build the compact audit body. It deliberately never contains axe source: if
 * a renderer was reloaded after the host cache marker, it reports an explicit
 * cache miss and the plugin retries once with {@link buildAxeInstallBody}.
 */
export function buildAxeAuditBody(): string {
  return `
const input = arg;
const axe = globalThis[Symbol.for('electron-stagewright.a11y.axe-engine')];
if (!axe || typeof axe.run !== 'function') return { kind: 'engine_missing' };
const labelError = (kind, field, selector, error) => ({
  kind,
  field,
  selector,
  message: String(error instanceof Error ? error.message : error).slice(0, 240),
});
const validateSelector = (selector, field, requireMatch) => {
  try {
    const match = document.querySelector(selector);
    if (requireMatch && match === null) return { kind: 'scope_not_found', field, selector };
    return undefined;
  } catch (error) {
    return labelError('invalid_selector', field, selector, error);
  }
};
if (input.scope !== undefined) {
  const error = validateSelector(input.scope, 'scope', true);
  if (error !== undefined) return error;
}
for (const selector of input.include ?? []) {
  const error = validateSelector(selector, 'include', true);
  if (error !== undefined) return error;
}
for (const selector of input.exclude ?? []) {
  const error = validateSelector(selector, 'exclude', false);
  if (error !== undefined) return error;
}
const include = input.scope !== undefined ? [input.scope] : input.include;
const context =
  include !== undefined || input.exclude !== undefined
    ? {
        ...(include !== undefined ? { include } : {}),
        ...(input.exclude !== undefined ? { exclude: input.exclude } : {}),
      }
    : document;
const options =
  input.tags !== undefined
    ? { runOnly: { type: 'tag', values: input.tags } }
    : input.rules !== undefined
      ? { runOnly: { type: 'rule', values: input.rules } }
      : {};
const impactRank = { minor: 1, moderate: 2, serious: 3, critical: 4 };
const minimumRank = input.impactMin === undefined ? 0 : impactRank[input.impactMin];
const maxTargetPaths = 8;
const maxTargetComponents = 8;
const maxTargetComponentChars = 512;
const compactNodes = (nodes) => {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const kept = safeNodes.slice(0, input.maxNodesPerViolation).map((node) => {
    const rawTargets = Array.isArray(node?.target) ? node.target : [];
    let targetsTruncated = rawTargets.length > maxTargetPaths;
    const targets = rawTargets.slice(0, maxTargetPaths).map((target) => {
      const rawParts = Array.isArray(target) ? target : [target];
      if (rawParts.length > maxTargetComponents) targetsTruncated = true;
      return rawParts.slice(0, maxTargetComponents).map((part) => {
        const value = String(part);
        if (value.length <= maxTargetComponentChars) return value;
        targetsTruncated = true;
        return value.slice(0, maxTargetComponentChars - 1) + '…';
      });
    });
    return { targets, targetsTruncated };
  });
  return { nodes: kept, nodeCount: safeNodes.length, nodesTruncated: safeNodes.length > kept.length };
};
const compactIssues = (issues) => {
  const candidates = (Array.isArray(issues) ? issues : []).filter((issue) => {
    const impact = issue?.impact;
    return typeof impact === 'string' && impactRank[impact] >= minimumRank;
  });
  const kept = candidates.slice(0, input.maxViolations).map((issue) => ({
    id: String(issue?.id ?? ''),
    impact: typeof issue?.impact === 'string' ? issue.impact : undefined,
    help: String(issue?.help ?? ''),
    helpUrl: String(issue?.helpUrl ?? ''),
    ...compactNodes(issue?.nodes),
  }));
  return { issues: kept, total: candidates.length, truncated: candidates.length > kept.length };
};
try {
  const results = await axe.run(context, options);
  return {
    kind: 'ok',
    version: typeof axe.version === 'string' ? axe.version : 'unknown',
    violations: compactIssues(results?.violations),
    incomplete: compactIssues(results?.incomplete),
  };
} catch (error) {
  return {
    kind: 'engine_error',
    message: String(error instanceof Error ? error.message : error).slice(0, 240),
  };
}
`
}
