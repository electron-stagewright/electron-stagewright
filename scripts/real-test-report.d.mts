export interface RealInventoryRow {
  path: string
  tests: number
}
export interface RealTestReport {
  success: boolean
  testResults: { name: string; assertionResults: { status: string }[] }[]
}
export function assertRealExecution(
  report: RealTestReport,
  inventory: RealInventoryRow[],
  root: string,
): void
