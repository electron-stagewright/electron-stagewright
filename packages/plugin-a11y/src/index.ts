/**
 * `@electron-stagewright/plugin-a11y` — bounded axe-core accessibility audits
 * for the currently selected Electron renderer surface.
 *
 * The plugin is optional and runs a fixed bundled engine, not agent-provided
 * JavaScript, so it does not need the arbitrary `--allow-eval` permission. It
 * deliberately audits one selected surface at a time: list and select each
 * iframe, webview, or WebContentsView explicitly rather than claiming an
 * ambiguous aggregate across cross-origin renderers.
 *
 * @module
 */

import {
  defineTool,
  makePluginError,
  makeSuccess,
  readPackageVersion,
  withProgressPhases,
  type AnyToolDefinition,
  type StagewrightPlugin,
  type ToolContext,
  type ToolResult,
  type TransportSession,
} from '@electron-stagewright/core'
import {
  createSessionCleanup,
  requireTransportCapability,
  sessionIdField,
} from '@electron-stagewright/core/plugin-sdk'
import { z } from 'zod'

import { buildAxeAuditBody, buildAxeInstallBody, type AuditRequest, type Impact } from './axe.js'

const A11Y_NAMESPACE = 'a11y'
const A11Y_PLUGIN_VERSION = readPackageVersion(import.meta.url)
const A11Y_INTROSPECTION = {
  requirements: { transportCapabilities: ['supportsRendererEval', 'supportsSurfaceTargeting'] },
} as const

const IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const
const selectorSchema = z.string().trim().min(1).max(512)
const listOfSelectors = z.array(selectorSchema).max(20)
const listOfNames = z.array(z.string().trim().min(1).max(128)).min(1).max(50)

const auditSchema = z
  .object({
    scope: selectorSchema
      .optional()
      .describe('One CSS selector to audit. Cannot be combined with include.'),
    include: listOfSelectors
      .optional()
      .describe('CSS selectors to include as audit roots. Cannot be combined with scope.'),
    exclude: listOfSelectors.optional().describe('CSS selectors to exclude from the audit.'),
    tags: listOfNames
      .optional()
      .describe(
        'Axe tags to run, for example ["wcag2a", "wcag2aa"]. Mutually exclusive with rules.',
      ),
    rules: listOfNames
      .optional()
      .describe('Exact axe rule ids to run. Mutually exclusive with tags.'),
    impactMin: z
      .enum(IMPACTS)
      .optional()
      .describe('Only return findings at or above this impact. Omit to return every impact.'),
    maxViolations: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Maximum violations and incomplete findings returned per category. Default 50.'),
    maxNodesPerViolation: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('Maximum affected-node selector paths returned per finding. Default 5.'),
    ...sessionIdField,
  })
  .refine((value) => !(value.scope !== undefined && value.include !== undefined), {
    message: 'scope and include are alternatives; provide only one.',
  })
  .refine((value) => !(value.tags !== undefined && value.rules !== undefined), {
    message: 'tags and rules are alternatives; provide only one.',
  })

interface AuditSuccess {
  readonly kind: 'ok'
  readonly version: string
  readonly violations: {
    readonly issues: readonly unknown[]
    readonly total: number
    readonly truncated: boolean
  }
  readonly incomplete: {
    readonly issues: readonly unknown[]
    readonly total: number
    readonly truncated: boolean
  }
}

type AuditFailure =
  | {
      readonly kind: 'invalid_selector'
      readonly field: string
      readonly selector: string
      readonly message: string
    }
  | { readonly kind: 'scope_not_found'; readonly field: string; readonly selector: string }
  | { readonly kind: 'engine_error'; readonly message: string }

type EngineInstallResult =
  { readonly kind: 'installed' } | { readonly kind: 'engine_error'; readonly message: string }

type EngineInstallFailure = Extract<EngineInstallResult, { readonly kind: 'engine_error' }>

type AuditResult = AuditSuccess | AuditFailure | { readonly kind: 'engine_missing' }

/** Create an isolated accessibility plugin instance for one Stagewright server. */
export function createA11yPlugin(): StagewrightPlugin {
  const installedSurfaces = new Map<string, Set<string>>()
  const sessionCleanup = createSessionCleanup(
    (sessionId) => installedSurfaces.delete(sessionId),
    () => installedSurfaces.clear(),
  )

  function requireAuditSurface(
    ctx: ToolContext,
    sessionId: string | undefined,
    meta: { readonly startedAt: number; readonly now: () => number },
  ):
    | { readonly session: TransportSession; readonly sessionId: string }
    | { readonly error: ToolResult } {
    const managed = ctx.sessions.resolve(sessionId)
    for (const capabilityName of ['supportsRendererEval', 'supportsSurfaceTargeting'] as const) {
      const capability = requireTransportCapability(
        managed.transport.capabilities,
        capabilityName,
        () =>
          makePluginError('a11y.UNSUPPORTED', {
            ...meta,
            message:
              'This session cannot audit a selected renderer surface; use a Playwright launch session with surface targeting.',
          }),
      )
      if (!capability.supported) return { error: capability.fallback }
    }
    return { session: managed.session, sessionId: managed.id }
  }

  const auditTool: AnyToolDefinition = defineTool({
    name: 'audit',
    title: 'Audit the selected renderer surface for accessibility issues',
    description: [
      'Run axe-core against the selected renderer surface and return bounded violations plus incomplete',
      'checks, never a conformance claim. Select frames, webviews, and WebContentsViews explicitly with',
      'electron_surfaces_list/electron_switch_surface; cross-origin renderers are audited one surface at a',
      'time. Supports CSS scope/include/exclude, axe tags or rules, an impact floor, and bounded node',
      'selector paths. Open shadow DOM is covered by axe; closed shadow roots and hidden/inactive content',
      'need explicit app/test setup. Returns cache/injection measurements; zero violations only means this',
      'automated audit found none. Errors: a11y.UNSUPPORTED, a11y.INVALID_SELECTOR,',
      'a11y.SCOPE_NOT_FOUND, a11y.ENGINE_FAILED, NOT_RUNNING, BAD_ARGUMENT.',
    ].join(' '),
    inputSchema: auditSchema,
    operationType: 'query',
    handler: async (args, ctx) =>
      withProgressPhases({ reporter: ctx.progress }, async (phase) => {
        const meta = { startedAt: ctx.startedAt, now: ctx.now }
        const guard = requireAuditSurface(ctx, args.sessionId, meta)
        if ('error' in guard) return guard.error
        const session = guard.session
        const sessionId = guard.sessionId
        phase('Selecting accessibility audit surface')
        const surface = await session.activeSurface()
        const request: AuditRequest = {
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.include !== undefined ? { include: args.include } : {}),
          ...(args.exclude !== undefined ? { exclude: args.exclude } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.rules !== undefined ? { rules: args.rules } : {}),
          ...(args.impactMin !== undefined ? { impactMin: args.impactMin as Impact } : {}),
          maxViolations: args.maxViolations,
          maxNodesPerViolation: args.maxNodesPerViolation,
        }
        const installedForSession = installedSurfaces.get(sessionId) ?? new Set<string>()
        installedSurfaces.set(sessionId, installedForSession)
        let cacheHit = installedForSession.has(surface.id)
        let transferredBytes = 0

        async function installEngine(): Promise<EngineInstallFailure | undefined> {
          phase('Installing accessibility audit engine')
          const install = buildAxeInstallBody()
          const installed = await session.evaluate<EngineInstallResult>('renderer', install.body)
          if (installed.kind === 'engine_error') return installed
          installedForSession.add(surface.id)
          cacheHit = false
          transferredBytes = install.transferredBytes
          return undefined
        }

        if (!cacheHit) {
          const failure = await installEngine()
          if (failure !== undefined) {
            return makePluginError('a11y.ENGINE_FAILED', {
              ...meta,
              message: `axe-core could not install for this renderer: ${failure.message}`,
            })
          }
        }

        phase('Running accessibility audit')
        let result = await session.evaluate<AuditResult>('renderer', buildAxeAuditBody(), request)
        if (result.kind === 'engine_missing') {
          const failure = await installEngine()
          if (failure !== undefined) {
            return makePluginError('a11y.ENGINE_FAILED', {
              ...meta,
              message: `axe-core could not install for this renderer: ${failure.message}`,
            })
          }
          phase('Retrying accessibility audit')
          result = await session.evaluate<AuditResult>('renderer', buildAxeAuditBody(), request)
        }
        if (result.kind === 'invalid_selector') {
          return makePluginError('a11y.INVALID_SELECTOR', {
            ...meta,
            message: `Invalid ${result.field} selector ${JSON.stringify(result.selector)}: ${result.message}`,
            details: { field: result.field, selector: result.selector },
          })
        }
        if (result.kind === 'scope_not_found') {
          return makePluginError('a11y.SCOPE_NOT_FOUND', {
            ...meta,
            message: `No element matched the ${result.field} selector ${JSON.stringify(result.selector)}.`,
            details: { field: result.field, selector: result.selector },
          })
        }
        if (result.kind === 'engine_error') {
          return makePluginError('a11y.ENGINE_FAILED', {
            ...meta,
            message: `axe-core could not complete the audit: ${result.message}`,
          })
        }
        if (result.kind === 'engine_missing') {
          return makePluginError('a11y.ENGINE_FAILED', {
            ...meta,
            message: 'axe-core was unavailable immediately after the fixed engine installation.',
          })
        }
        return makeSuccess(
          {
            session_id: sessionId,
            surface_id: surface.id,
            engine: {
              version: result.version,
              cache_hit: cacheHit,
              transferred_bytes: transferredBytes,
            },
            summary: {
              violations: result.violations.total,
              incomplete: result.incomplete.total,
              violations_truncated: result.violations.truncated,
              incomplete_truncated: result.incomplete.truncated,
            },
            violations: result.violations.issues,
            incomplete: result.incomplete.issues,
            limitation:
              'Automated checks cover only part of accessibility. Zero violations is not full WCAG conformance; review incomplete results and test relevant hidden or closed-shadow content separately.',
          },
          { ...meta, session_id: sessionId },
        )
      }),
  })

  return {
    name: A11Y_NAMESPACE,
    version: A11Y_PLUGIN_VERSION,
    coreVersionRange: '*',
    introspection: A11Y_INTROSPECTION,
    errorCodes: {
      UNSUPPORTED: {
        http: 409,
        retryable: false,
        hint: 'Use a Playwright launch session that supports renderer evaluation and surface targeting.',
      },
      INVALID_SELECTOR: {
        http: 400,
        retryable: false,
        hint: 'Correct the CSS selector and retry the audit.',
      },
      SCOPE_NOT_FOUND: {
        http: 404,
        retryable: false,
        hint: 'Re-snapshot the selected surface or choose a selector that exists there.',
      },
      ENGINE_FAILED: {
        http: 500,
        retryable: true,
        hint: 'Wait for the renderer to settle, then retry or audit a narrower surface.',
      },
    },
    tools: [auditTool],
    setup: (_config, context) => sessionCleanup.setup(context),
    teardown: () => sessionCleanup.teardown(),
  }
}

/** API 1.2 descriptor; the loader creates a fresh plugin instance for every server. */
export const a11yPlugin: StagewrightPlugin = {
  name: A11Y_NAMESPACE,
  version: A11Y_PLUGIN_VERSION,
  coreVersionRange: '*',
  get tools() {
    return createA11yPlugin().tools ?? []
  },
  get errorCodes() {
    return createA11yPlugin().errorCodes ?? {}
  },
  introspection: A11Y_INTROSPECTION,
  createInstance: createA11yPlugin,
}

export default a11yPlugin
