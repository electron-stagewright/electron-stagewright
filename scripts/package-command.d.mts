import type { ExecFileOptionsWithStringEncoding } from 'node:child_process'

export interface PackageCommandInvocation {
  readonly file: string
  readonly args: readonly string[]
}

export function packageCommandInvocation(
  command: string,
  args: readonly string[],
  platform?: NodeJS.Platform,
  commandProcessor?: string,
): PackageCommandInvocation

export function execPackageCommand(
  command: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<{ readonly stdout: string; readonly stderr: string }>
