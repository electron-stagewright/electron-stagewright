/**
 * The budget file: one JSON document naming the limits a build must stay under.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'

import { z } from 'zod'

/** OS memory metrics. They are not interchangeable, so a budget names exactly one per platform. */
export const MEMORY_METRICS = ['footprint', 'pss', 'privateBytes', 'workingSet'] as const
export type MemoryMetric = (typeof MEMORY_METRICS)[number]

/** Process buckets, normalised from Electron's `app.getAppMetrics()` types. */
export const PROCESS_TYPES = ['main', 'renderer', 'gpu', 'utility', 'other'] as const
export type ProcessType = (typeof PROCESS_TYPES)[number]

/** `cold` is a first launch on an empty profile, `warm` a relaunch on it, `live` an agent session. */
export const PHASES = ['cold', 'warm', 'live'] as const
export type Phase = (typeof PHASES)[number]

export const BUDGET_PLATFORMS = ['darwin', 'win32', 'linux'] as const
export type BudgetPlatform = (typeof BUDGET_PLATFORMS)[number]

const comment = { $comment: z.string().optional() }
const limit = z.number().positive()
const thresholdPercent = z.number().min(0).max(1000).optional()

const memoryPlatformSchema = z.strictObject({
  ...comment,
  metric: z.enum(MEMORY_METRICS),
  phase: z.enum(PHASES).optional(),
  thresholdPercent,
  // Summed per type. A type that is not named (GPU, typically) is reported but never gates.
  perTypeMb: z.partialRecord(z.enum(PROCESS_TYPES), limit).optional(),
  totalWithoutGpuMb: limit.optional(),
  totalMb: limit.optional(),
})

const bundleEntrySchema = z.strictObject({
  ...comment,
  name: z.string().min(1).optional(),
  // A file or a directory (summed recursively), relative to the budget file unless absolute.
  path: z.string().min(1),
  extensions: z.array(z.string().regex(/^\./, 'extensions start with a dot')).min(1).optional(),
  gzip: z.boolean().optional(),
  maxKb: limit,
})

export const budgetSchema = z.strictObject({
  ...comment,
  $schema: z.string().optional(),
  thresholdPercent,
  startup: z
    .strictObject({
      ...comment,
      phase: z.enum(PHASES).optional(),
      thresholdPercent,
      maxFirstWindowMs: limit,
    })
    .optional(),
  memory: z.partialRecord(z.enum(BUDGET_PLATFORMS), memoryPlatformSchema).optional(),
  mainThread: z
    .strictObject({
      ...comment,
      thresholdPercent,
      windowMs: z.number().int().min(250).max(120_000).optional(),
      maxBlockedPercent: z.number().min(0).max(100).optional(),
      maxStallMs: limit.optional(),
    })
    .optional(),
  ipc: z
    .strictObject({
      ...comment,
      thresholdPercent,
      // Renderer expression that performs one round trip, e.g. `window.api.getVersion()`.
      probe: z.string().min(1),
      intervalMs: z.number().int().min(1).max(1000).optional(),
      maxP99Ms: limit.optional(),
      maxP95Ms: limit.optional(),
    })
    .optional(),
  bundle: z
    .strictObject({ ...comment, thresholdPercent, entries: z.array(bundleEntrySchema).min(1) })
    .optional(),
})

export type Budget = z.infer<typeof budgetSchema>
export type MemoryPlatformBudget = z.infer<typeof memoryPlatformSchema>
export type BundleEntryBudget = z.infer<typeof bundleEntrySchema>

/** A budget file that is missing, not JSON, or does not match {@link budgetSchema}. */
export class BudgetFileError extends Error {
  constructor(
    readonly code: 'BUDGET_NOT_FOUND' | 'BUDGET_INVALID',
    message: string,
    readonly budgetPath?: string,
  ) {
    super(message)
    this.name = 'BudgetFileError'
  }
}

/** Validate an already-parsed budget document. */
export function parseBudget(raw: unknown, budgetPath?: string): Budget {
  const parsed = budgetSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  throw new BudgetFileError('BUDGET_INVALID', `Invalid budget: ${issues}`, budgetPath)
}

/** Read and validate a budget file. */
export async function loadBudget(budgetPath: string): Promise<Budget> {
  let text: string
  try {
    text = await readFile(budgetPath, 'utf8')
  } catch (error) {
    throw new BudgetFileError(
      'BUDGET_NOT_FOUND',
      `Cannot read budget file ${budgetPath}: ${error instanceof Error ? error.message : String(error)}`,
      budgetPath,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new BudgetFileError(
      'BUDGET_INVALID',
      `Budget file ${budgetPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      budgetPath,
    )
  }
  return parseBudget(raw, budgetPath)
}
