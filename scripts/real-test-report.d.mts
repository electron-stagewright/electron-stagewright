export interface RealInventoryRow {
  path: string
  tests: number
  excludedPlatforms: string[]
}
export interface RealTestReport {
  success: boolean
  testResults: { name: string; assertionResults: { status: string }[] }[]
}
export function assertRealExecution(
  report: RealTestReport,
  inventory: RealInventoryRow[],
  root: string,
  platform: string,
): void
