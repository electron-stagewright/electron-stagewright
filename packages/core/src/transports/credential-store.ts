/**
 * Credential-store switches shared by every transport that spawns Electron.
 *
 * @module
 */

import type { LaunchOptions } from './types.js'

/** True when `args` carries `--name` or `--name=value` anywhere. */
export function hasSwitch(args: readonly string[], name: string): boolean {
  const prefix = `--${name}`
  return args.some((arg) => arg === prefix || arg.startsWith(`${prefix}=`))
}

/**
 * Switches that keep `safeStorage` off the OS credential store under `testing`: an unanswered
 * Keychain or secret-service prompt blocks the main process before the first window exists.
 * Chromium stops parsing switches at `--`, so a caller switch after it does not count.
 */
export function credentialStoreArgs(
  callerArgs: readonly string[],
  mode: NonNullable<LaunchOptions['credentialStore']>,
  platform: NodeJS.Platform,
): readonly string[] {
  if (mode === 'system') return []
  const end = callerArgs.indexOf('--')
  const parsed = end === -1 ? callerArgs : callerArgs.slice(0, end)
  if (platform === 'darwin' && !hasSwitch(parsed, 'use-mock-keychain')) {
    return ['--use-mock-keychain']
  }
  if (platform === 'linux' && !hasSwitch(parsed, 'password-store')) {
    return ['--password-store=basic']
  }
  return []
}
