/**
 * `@electron-stagewright/plugin-production` — validate a packaged macOS app for production
 * readiness (ADR-012, built on the ADR-004 plugin contract). Where the rest of Stagewright drives
 * a running app, this plugin inspects the BUILD ARTIFACT on disk: is the `.app` a well-formed
 * bundle, does its Info.plist declare valid identity fields and well-formed URL schemes, is its
 * auto-update feed configuration coherent, does the crash-capture machinery ship intact, is it
 * code-signed, is it notarized, will Gatekeeper accept it.
 *
 * The single tool `production_validate` runs a set of checks against an `appPath` and returns
 * STRUCTURED results — each a `pass` / `fail` / `unknown` — where the load-bearing distinction is
 * `unknown` (missing evidence: a CLI absent, a command timeout, a non-macOS host) versus `fail`
 * (verified bad). The tool envelope is `ok: true` whenever validation RAN; the app's own verdict
 * is the `passed` field (no failed checks). Only a bad input (no app at `appPath`) is a tool error.
 *
 * It shells out to the macOS toolchain (`codesign`, `xcrun stapler`, `spctl`, `plutil`) rather than
 * evaluating app code, so it needs no `--allow-eval` and no running session — but every spawn is
 * timeout-bounded. On a non-macOS host those tools are absent, so their checks report `unknown`, not
 * `fail`. macOS is the first-class target; other OSes are reported as unverifiable.
 *
 * @module
 */

import { stat } from 'node:fs/promises'
import path from 'node:path'

import {
  defineTool,
  makeError,
  makePluginError,
  makeSuccess,
  type AnyToolDefinition,
  type StagewrightPlugin,
} from '@electron-stagewright/core'
import { z } from 'zod'

import { CHECK_IDS, runChecks, type CheckStatus } from './checks.js'
import { makeRunCommand } from './command.js'

/** Plugin namespace — must match {@link productionPlugin.name}; the loader prefixes its tools. */
const PRODUCTION_NAMESPACE = 'production'
/** Plugin package version advertised by `electron_plugins`; keep in sync with package.json. */
const PRODUCTION_PLUGIN_VERSION = '0.1.0'

const configSchema = z.object({
  commandTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(10_000)
    .describe(
      'Timeout (ms) for each external validation command (codesign, xcrun stapler, spctl, plutil).',
    ),
})

/** Resolved plugin configuration — the validated output of {@link configSchema}. */
type ProductionConfig = z.infer<typeof configSchema>

/** Defaults used until `setup` runs (mirror the schema defaults). */
const DEFAULT_CONFIG: ProductionConfig = { commandTimeoutMs: 10_000 }

// Module-level config, set by `setup` (one plugin instance per process, as with the other
// first-party plugins).
let config: ProductionConfig = DEFAULT_CONFIG

const validateTool: AnyToolDefinition = defineTool({
  name: 'validate',
  title: 'Validate a packaged macOS app',
  description: [
    'Validate a packaged macOS .app for production readiness and return structured results. Runs,',
    'by default, eight checks — bundle-structure (a well-formed Contents/Info.plist + Contents/MacOS',
    'executable), info-plist (Info.plist declares CFBundleIdentifier / CFBundleShortVersionString /',
    'CFBundleExecutable, via plutil), protocol-schemes (CFBundleURLTypes deep-link declarations are',
    'well-formed, unique, and shadow no system scheme), updater-feed (the packaged electron-updater',
    'app-update.yml declares a provider with its required fields and https URLs; absent = unknown,',
    'runtime feeds are not statically visible), crash-reporter (the crashpad handler ships intact and',
    'executable inside Electron Framework.framework), code-signing (codesign --verify --deep',
    '--strict), notarization (a notarization ticket stapled to the bundle, via xcrun stapler',
    'validate), and gatekeeper (spctl --assess) — or the subset named in checks. Each result is pass',
    '(verified good), fail (verified bad, with next_actions), or unknown (could not verify — a macOS',
    'tool is absent, e.g. on a non-macOS host).',
    'Returns: { ok, app_path, passed, summary: { pass, fail, unknown }, checks }, where passed is',
    'true when no check failed (unknown checks do not fail it but are reported). Errors:',
    'ABSOLUTE_PATH_REQUIRED (relative appPath), production.APP_NOT_FOUND (no file/dir at appPath),',
    'production.NOT_A_BUNDLE (appPath is not a directory). Needs no app session and no --allow-eval;',
    'it inspects the build artifact on disk.',
  ].join(' '),
  inputSchema: z.object({
    appPath: z
      .string()
      .min(1)
      .describe('Absolute path to the packaged macOS .app bundle to validate.'),
    checks: z
      .array(z.enum(CHECK_IDS))
      .min(1)
      .optional()
      .describe(
        'Subset of checks to run by id; omit to run all (bundle-structure, info-plist, protocol-schemes, updater-feed, crash-reporter, code-signing, notarization, gatekeeper).',
      ),
  }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    if (!path.isAbsolute(args.appPath)) {
      return makeError('ABSOLUTE_PATH_REQUIRED', {
        ...meta,
        message: 'appPath must be an absolute path to a packaged .app bundle.',
        details: { app_path: args.appPath },
      })
    }
    const appPath = path.resolve(args.appPath)

    let info
    try {
      info = await stat(appPath)
    } catch {
      return makePluginError('production.APP_NOT_FOUND', {
        ...meta,
        message: `No file or directory at ${appPath}; pass the path to the packaged .app.`,
        details: { app_path: appPath },
      })
    }
    if (!info.isDirectory()) {
      return makePluginError('production.NOT_A_BUNDLE', {
        ...meta,
        message: `${appPath} is not a directory; a macOS .app is a bundle directory.`,
        details: { app_path: appPath },
      })
    }

    const run = makeRunCommand(config.commandTimeoutMs)
    const checks = await runChecks(appPath, run, args.checks ?? CHECK_IDS)
    const tally = (status: CheckStatus): number =>
      checks.filter((check) => check.status === status).length
    const summary = { pass: tally('pass'), fail: tally('fail'), unknown: tally('unknown') }
    // passed = nothing FAILED. unknown checks (missing evidence) do not flip it, but the summary
    // discloses them so a green result with skipped checks is never mistaken for full verification.
    const passed = summary.fail === 0

    return makeSuccess({ app_path: appPath, passed, summary, checks }, meta)
  },
})

/**
 * The production validation plugin. Load with `--plugin @electron-stagewright/plugin-production` or
 * `createServer({ plugins: [productionPlugin] })`. Configure via `pluginConfigs.production`
 * (`{ commandTimeoutMs? }`).
 */
export const productionPlugin: StagewrightPlugin = {
  name: PRODUCTION_NAMESPACE,
  version: PRODUCTION_PLUGIN_VERSION,
  coreVersionRange: '*',
  configSchema,
  errorCodes: {
    APP_NOT_FOUND: {
      http: 404,
      retryable: false,
      hint: 'No file or directory at the given appPath; pass the absolute path to the packaged .app.',
    },
    NOT_A_BUNDLE: {
      http: 400,
      retryable: false,
      hint: 'A macOS .app is a bundle directory; appPath pointed at a non-directory.',
    },
  },
  tools: [validateTool],
  setup: (raw) => {
    config = raw as ProductionConfig
  },
  teardown: async () => {
    // Reset config so a later load in the same process never inherits a prior run's config.
    config = DEFAULT_CONFIG
  },
}

export default productionPlugin

export { CHECK_IDS } from './checks.js'
export type { CheckResult, CheckStatus, CheckId } from './checks.js'
export type { CommandResult, RunCommand } from './command.js'
