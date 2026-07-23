import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

/**
 * Resolve an npm-installed command for direct child-process execution.
 *
 * Package binaries are native executables or shell scripts on POSIX, but npm creates `.cmd` shims
 * on Windows. Node cannot execute those shims with `execFile()` directly, so Windows calls must go
 * through the command processor. Keeping that policy here prevents each release smoke from fixing
 * only the first package-manager command it happens to reach.
 */
export function packageCommandInvocation(
  command,
  args,
  platform = process.platform,
  commandProcessor = process.env.ComSpec ?? 'cmd.exe',
) {
  if (platform !== 'win32') return { file: command, args }

  const shim = command.toLowerCase().endsWith('.cmd') ? command : `${command}.cmd`
  return {
    file: commandProcessor,
    args: ['/d', '/c', shim, ...args],
  }
}

/** Execute an npm-installed command without opting every platform into shell parsing. */
export function execPackageCommand(command, args, options) {
  const invocation = packageCommandInvocation(command, args)
  return execFile(invocation.file, invocation.args, options)
}
