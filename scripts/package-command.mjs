import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

/**
 * Resolve an npm-installed command for direct child-process execution.
 *
 * Package binaries are native executables or shell scripts on POSIX, but npm creates `.cmd` shims
 * on Windows. Node cannot execute those shims with `execFile()` directly, so Windows shims must go
 * through the command processor while native `.exe` / `.com` files stay direct. Keeping that
 * policy here prevents a native runtime such as `process.execPath` from becoming `node.exe.cmd`.
 */
export function packageCommandInvocation(
  command,
  args,
  platform = process.platform,
  commandProcessor = process.env.ComSpec ?? 'cmd.exe',
) {
  if (platform !== 'win32') return { file: command, args }

  const lowerCommand = command.toLowerCase()
  if (lowerCommand.endsWith('.exe') || lowerCommand.endsWith('.com')) {
    return { file: command, args }
  }
  const shim =
    lowerCommand.endsWith('.cmd') || lowerCommand.endsWith('.bat') ? command : `${command}.cmd`
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
