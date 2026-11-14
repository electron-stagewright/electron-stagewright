/**
 * `@electron-stagewright/plugin-budget/check`: the budget and run formats and the check, without
 * core, the plugin, or anything that launches Electron.
 *
 * @module
 */

export {
  BUDGET_PLATFORMS,
  BudgetFileError,
  MEMORY_METRICS,
  PHASES,
  PROCESS_TYPES,
  budgetSchema,
  loadBudget,
  parseBudget,
} from './budget.js'
export type {
  Budget,
  BudgetPlatform,
  BundleEntryBudget,
  MemoryMetric,
  MemoryPlatformBudget,
  Phase,
  ProcessType,
} from './budget.js'
export { checkRun } from './check.js'
export type { CheckOptions, CheckReport, CheckResult, CheckStatus } from './check.js'
export { compareRuns, renderCheckReport, renderComparison } from './render.js'
export type { ComparisonRow } from './render.js'
export {
  RUN_FORMAT,
  RUN_SCHEMA_VERSION,
  RunFileError,
  createRun,
  loadRun,
  memoryByType,
  runSchema,
  summarizeLatencies,
  summarizeRun,
} from './run.js'
export type {
  BudgetRun,
  BundleEntryMeasurement,
  LatencySummary,
  Measurement,
  MemoryMeasurement,
  ProcessMemory,
  StallSummary,
  SummaryRow,
} from './run.js'
