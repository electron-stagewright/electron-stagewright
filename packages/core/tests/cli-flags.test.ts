/**
 * CLI flag parsing edge cases (security review follow-ups):
 * - a security/confinement flag present with a MISSING value fails closed (throws) instead of
 *   silently disabling the control, e.g. `--app-root --allow-eval` must not parse as "no app-root".
 * - the happy paths still parse.
 */

import { describe, expect, it } from 'vitest'

import { parseCliArgs } from '../src/cli.js'

describe('parseCliArgs — value-bearing flags fail closed on a missing value', () => {
  it('throws when --app-root is followed by another flag (would silently disable confinement)', () => {
    expect(() => parseCliArgs(['--app-root', '--allow-eval'])).toThrow(/--app-root expects a value/)
  })

  it('throws when --app-root is the final token', () => {
    expect(() => parseCliArgs(['--app-root'])).toThrow(/--app-root expects a value/)
  })

  it('throws when --screenshot-dir has no value', () => {
    expect(() => parseCliArgs(['--screenshot-dir', '--plugin', 'x'])).toThrow(
      /--screenshot-dir expects a value/,
    )
  })

  it('throws when --plugin has no value', () => {
    expect(() => parseCliArgs(['--plugin', '--app-root', '/root'])).toThrow(
      /--plugin expects a value/,
    )
  })

  it('parses valid confinement + plugin flags', () => {
    const opts = parseCliArgs([
      '--app-root',
      '/root',
      '--screenshot-dir',
      '/shots',
      '--plugin',
      'a',
    ])
    expect(opts.appRoot).toBe('/root')
    expect(opts.screenshotDir).toBe('/shots')
    expect(opts.pluginSpecs).toEqual(['a'])
  })
})
