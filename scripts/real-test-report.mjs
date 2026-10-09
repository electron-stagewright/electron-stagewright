import path from 'node:path'

export function assertRealExecution(report, inventory, root, platform) {
  if (!report.success || !Array.isArray(report.testResults) || inventory.length === 0) {
    throw new Error('Real-runtime report has no successful executable inventory')
  }
  const files = new Map(
    report.testResults.map((row) => [path.relative(root, row.name).split(path.sep).join('/'), row]),
  )
  if (files.size !== inventory.length)
    throw new Error('Real-runtime discovered file count differs from reviewed inventory')
  for (const expected of inventory) {
    const row = files.get(expected.path)
    if (
      !row ||
      !Array.isArray(row.assertionResults) ||
      row.assertionResults.length !== expected.tests
    ) {
      throw new Error(`Missing real-runtime scenarios: ${expected.path}`)
    }
    const excluded = expected.excludedPlatforms.includes(platform)
    for (const assertion of row.assertionResults) {
      if (
        excluded
          ? !['pending', 'skipped'].includes(assertion.status)
          : assertion.status !== 'passed'
      ) {
        throw new Error(
          `Real-runtime scenario did not execute successfully: ${expected.path} (${assertion.status})`,
        )
      }
    }
  }
}
