/**
 * `@electron-stagewright/plugin-production` — validate packaged macOS, Windows, and Linux release
 * artifacts (ADR-012, built on the ADR-004 plugin contract). Where the rest of Stagewright drives
 * a running app, this plugin inspects the BUILD ARTIFACT on disk: macOS bundle integrity and trust
 * gates, Windows Authenticode, or an AppImage embedded signature.
 *
 * The single tool `production_validate` runs a set of checks against an `appPath` and returns
 * STRUCTURED results — each a `pass` / `fail` / `unknown` — where the load-bearing distinction is
 * `unknown` (missing evidence: a CLI/key absent, a command timeout, or the wrong host) versus
 * `fail` (verified bad). The tool envelope is `ok: true` whenever validation RAN; the artifact's
 * own verdict is the `passed` field (no failed checks). Only bad input is a tool error.
 *
 * It shells out to bounded platform validators rather than evaluating app code, so it needs no
 * `--allow-eval` and no running session. Missing tools report `unknown`, not `fail`, and the
 * inspected artifact is never executed.
 *
 * @module
 */

import {
  defineTool,
  makeError,
  makePluginError,
  makeSuccess,
  readPackageVersion,
  withProgressPhases,
  type AnyToolDefinition,
  type StagewrightPlugin,
} from '@electron-stagewright/core'
import { createPluginConfigState } from '@electron-stagewright/core/plugin-sdk'
import { z } from 'zod'

import { CHECK_IDS } from './checks.js'
import {
  ProductionValidationError,
  validateProductionApp,
  type ProductionValidationReport,
} from './validate.js'

/** Plugin namespace — must match {@link productionPlugin.name}; the loader prefixes its tools. */
const PRODUCTION_NAMESPACE = 'production'
/** Plugin package version advertised by `electron_plugins`; read from package.json so it cannot drift. */
const PRODUCTION_PLUGIN_VERSION = readPackageVersion(import.meta.url)
const PRODUCTION_INTROSPECTION = {
  config: { safeFields: ['commandTimeoutMs'] },
} as const

const configSchema = z.object({
  commandTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(10_000)
    .describe(
      'Timeout (ms) for each external validation command (macOS tools, Windows PowerShell, or the AppImage validator).',
    ),
})

/** Resolved plugin configuration — the validated output of {@link configSchema}. */
type ProductionConfig = z.infer<typeof configSchema>

/** Defaults used until `setup` runs (mirror the schema defaults). */
const DEFAULT_CONFIG: ProductionConfig = { commandTimeoutMs: 10_000 }

// The factory owns this parsed configuration, so each server receives an independent value.
export function createProductionPlugin(): StagewrightPlugin {
  const config = createPluginConfigState(DEFAULT_CONFIG)

  const validateTool: AnyToolDefinition = defineTool({
    name: 'validate',
    title: 'Validate a packaged Electron artifact',
    description: [
      'Validate a packaged Electron release artifact and return structured results. Artifact-aware',
      'defaults run the existing eight bundle/signing checks for a macOS .app,',
      'windows-authenticode for a Windows .exe/.msi, or appimage-signature for a Linux .AppImage.',
      'A checks subset may select any check explicitly. Each result is pass (verified good), fail',
      '(verified bad, with next_actions), or unknown (missing tool, key, platform, or evidence).',
      'Returns: { ok, app_path, artifact_type, passed, summary: { pass, fail, unknown }, checks },',
      'where passed is true when no check failed (unknown checks do not fail it but are reported).',
      'Errors:',
      'ABSOLUTE_PATH_REQUIRED (relative appPath), production.APP_NOT_FOUND (no file/dir at appPath),',
      'production.NOT_A_BUNDLE (a .app path is not a directory), or',
      'production.UNSUPPORTED_ARTIFACT (unsupported file type). Needs no app session and no',
      '--allow-eval; it inspects the build artifact on disk and never executes the artifact.',
    ].join(' '),
    inputSchema: z.object({
      appPath: z
        .string()
        .min(1)
        .describe('Absolute path to a packaged macOS .app, Windows .exe/.msi, or Linux .AppImage.'),
      checks: z
        .array(z.enum(CHECK_IDS))
        .min(1)
        .optional()
        .describe('Subset of checks to run by id; omit to run the artifact-aware defaults.'),
    }),
    operationType: 'query',
    handler: async (args, ctx) =>
      withProgressPhases({ reporter: ctx.progress }, async (phase) => {
        const meta = { startedAt: ctx.startedAt, now: ctx.now }
        let report: ProductionValidationReport
        try {
          phase('Inspecting production artifact')
          report = await validateProductionApp(args.appPath, {
            ...(args.checks === undefined ? {} : { checks: args.checks }),
            commandTimeoutMs: config.current.commandTimeoutMs,
            onCheckStart: ({ index, total }) => {
              phase(`Running production check ${index + 1} of ${total}`)
            },
          })
        } catch (error) {
          if (!(error instanceof ProductionValidationError)) throw error
          const details = error.appPath === undefined ? {} : { app_path: error.appPath }
          if (error.code === 'ABSOLUTE_PATH_REQUIRED') {
            return makeError('ABSOLUTE_PATH_REQUIRED', {
              ...meta,
              message: error.message,
              details,
            })
          }
          if (error.code === 'APP_NOT_FOUND') {
            return makePluginError('production.APP_NOT_FOUND', {
              ...meta,
              message: error.message,
              details,
            })
          }
          if (error.code === 'NOT_A_BUNDLE') {
            return makePluginError('production.NOT_A_BUNDLE', {
              ...meta,
              message: error.message,
              details,
            })
          }
          if (error.code === 'UNSUPPORTED_ARTIFACT') {
            return makePluginError('production.UNSUPPORTED_ARTIFACT', {
              ...meta,
              message: error.message,
              details,
            })
          }
          return makeError('BAD_ARGUMENT', {
            ...meta,
            message: error.message,
            details,
          })
        }

        return makeSuccess(
          {
            app_path: report.app_path,
            artifact_type: report.artifact_type,
            passed: report.passed,
            summary: report.summary,
            checks: report.checks,
          },
          meta,
        )
      }),
  })

  /**
   * The production validation plugin. Load with `--plugin @electron-stagewright/plugin-production` or
   * `createServer({ plugins: [productionPlugin] })`. Configure via `pluginConfigs.production`
   * (`{ commandTimeoutMs? }`).
   */
  return {
    name: PRODUCTION_NAMESPACE,
    version: PRODUCTION_PLUGIN_VERSION,
    coreVersionRange: '*',
    configSchema,
    introspection: PRODUCTION_INTROSPECTION,
    errorCodes: {
      APP_NOT_FOUND: {
        http: 404,
        retryable: false,
        hint: 'No file or directory at appPath; pass the absolute path to the packaged release artifact.',
      },
      NOT_A_BUNDLE: {
        http: 400,
        retryable: false,
        hint: 'A macOS .app is a bundle directory; appPath pointed at a non-directory.',
      },
      UNSUPPORTED_ARTIFACT: {
        http: 400,
        retryable: false,
        hint: 'Pass a macOS .app directory, Windows .exe/.msi file, or Linux .AppImage file.',
      },
    },
    tools: [validateTool],
    setup: (raw) => {
      config.set(raw as ProductionConfig)
    },
    teardown: async () => {
      // Reset config so a later load in the same process never inherits a prior run's config.
      config.reset()
    },
  }
}

/** API 1.1 descriptor; the loader creates a fresh plugin instance for every server. */
export const productionPlugin: StagewrightPlugin = {
  name: PRODUCTION_NAMESPACE,
  version: PRODUCTION_PLUGIN_VERSION,
  coreVersionRange: '*',
  get tools() {
    return createProductionPlugin().tools ?? []
  },
  get errorCodes() {
    return createProductionPlugin().errorCodes ?? {}
  },
  get configSchema() {
    return configSchema
  },
  introspection: PRODUCTION_INTROSPECTION,
  createInstance: createProductionPlugin,
}

export default productionPlugin

export { CHECK_IDS } from './checks.js'
export type { CheckResult, CheckStartObserver, CheckStatus, CheckId } from './checks.js'
export type { CommandResult, RunCommand } from './command.js'
export {
  DEFAULT_CHECK_IDS_BY_ARTIFACT,
  DEFAULT_COMMAND_TIMEOUT_MS,
  ProductionValidationError,
  validateProductionApp,
} from './validate.js'
export type {
  ProductionArtifactType,
  ProductionValidationErrorCode,
  ProductionValidationOptions,
  ProductionValidationReport,
  ProductionValidationSummary,
} from './validate.js'
