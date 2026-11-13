/**
 * `@electron-stagewright/plugin-budget`: performance budgets for Electron apps.
 *
 * @module
 */

import { budgetPlugin } from './plugin.js'

export default budgetPlugin
export { budgetPlugin, createBudgetPlugin } from './plugin.js'
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
export { measureBundle } from './bundle.js'
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
export { classifyProcess, measureMemory, platformMetric } from './memory.js'
export type { AppProcessMetric, OsMemoryReader } from './memory.js'
export { measureSession, startWindow } from './session.js'
export type { EvaluatingSession, IpcProbe, MeasureOptions, SessionMeasurement } from './session.js'
export { measureApp } from './measure.js'
export type { LaunchPhase, MeasureAppOptions, Workload, WorkloadContext } from './measure.js'
