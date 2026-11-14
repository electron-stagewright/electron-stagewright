const PASSED_THROUGH = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SystemRoot',
  'windir',
] as const

/**
 * Only what a runtime needs to start. Secrets go in the start payload, never in env or argv.
 * `home` replaces HOME and USERPROFILE, so a library's `~/.config` defaults stay in the app's folder.
 */
export function minimalEnvironment(
  env: NodeJS.ProcessEnv,
  options: { readonly home?: string; readonly passThrough?: readonly string[] } = {},
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of [...PASSED_THROUGH, ...(options.passThrough ?? [])]) {
    const value = env[name]
    if (value !== undefined) out[name] = value
  }
  if (options.home !== undefined) {
    out['HOME'] = options.home
    out['USERPROFILE'] = options.home
  }
  return out
}
