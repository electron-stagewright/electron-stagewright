/**
 * Credential-store switches shared by every transport that spawns Electron.
 *
 * @module
 */

import type { LaunchOptions } from './types.js'

/** True when `args` already carries `--name` or `--name=value`. */
export function hasSwitch(args: readonly string[], name: string): boolean {
  const prefix = `--${name}`
  return args.some((arg) => arg === prefix || arg.startsWith(`${prefix}=`))
}

/**
 * Switches that keep `safeStorage` off the OS credential store under `testing`: an unanswered
 * Keychain or secret-service prompt blocks the main process before the first window exists.
 */
export function credentialStoreArgs(
  callerArgs: readonly string[],
  mode: NonNullable<LaunchOptions['credentialStore']>,
  platform: NodeJS.Platform,
): readonly string[] {
  if (mode === 'system') return []
  if (platform === 'darwin' && !hasSwitch(callerArgs, 'use-mock-keychain')) {
    return ['--use-mock-keychain']
  }
  if (platform === 'linux' && !hasSwitch(callerArgs, 'password-store')) {
    return ['--password-store=basic']
  }
  return []
}
