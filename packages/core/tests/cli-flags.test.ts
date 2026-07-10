/**
 * CLI flag parsing edge cases (security review follow-ups):
 * - a security/confinement flag present with a MISSING value fails closed (throws) instead of
 *   silently disabling the control, e.g. `--app-root --allow-eval` must not parse as "no app-root".
 * - the happy paths still parse.
 */

import { describe, expect, it } from 'vitest'

import { formatCliHelp, parseCliArgs } from '../src/cli.js'

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

  it('defaults to full and strictly parses the core tool profile', () => {
    expect(parseCliArgs([]).toolProfile).toBe('full')
    expect(parseCliArgs(['--tool-profile', 'essential']).toolProfile).toBe('essential')
    expect(parseCliArgs(['--tool-profile', 'testing']).toolProfile).toBe('testing')
    expect(parseCliArgs(['--tool-profile', 'debug']).toolProfile).toBe('debug')
    expect(() => parseCliArgs(['--tool-profile'])).toThrow(/expects a value/)
    expect(() => parseCliArgs(['--tool-profile', 'tiny'])).toThrow(
      /must be essential, testing, debug, or full/,
    )
    expect(() => parseCliArgs(['--tool-profile', 'essential', '--tool-profile', 'full'])).toThrow(
      /may be specified only once/,
    )
  })

  it('rejects unknown flags and positional arguments instead of silently ignoring them', () => {
    expect(() => parseCliArgs(['--plugn', 'trace'])).toThrow('Unknown option: --plugn')
    expect(() => parseCliArgs(['doctor', 'unexpected'])).toThrow('Unexpected argument: unexpected')
  })

  it('rejects an ambiguous repeated singleton flag', () => {
    expect(() => parseCliArgs(['--app-root', '/one', '--app-root', '/two'])).toThrow(
      '--app-root may be specified only once',
    )
  })

  it('recognises help, version, and doctor JSON modes without starting the MCP server', () => {
    expect(parseCliArgs(['--help']).command).toBe('help')
    expect(parseCliArgs(['--version']).command).toBe('version')
    const doctor = parseCliArgs(['doctor', '--json', '--allow-eval=renderer'])
    expect(doctor.command).toBe('doctor')
    expect(doctor.doctorJson).toBe(true)
    expect(doctor.allowEval).toEqual({ main: false, renderer: true })
  })

  it('does not silently ignore server-only options in doctor mode', () => {
    expect(() => parseCliArgs(['doctor', '--plugin', 'trace'])).toThrow(
      '--plugin is only valid when starting the MCP server',
    )
    expect(() => parseCliArgs(['doctor', '--operation-timeout-ms', '5000'])).toThrow(
      '--operation-timeout-ms is only valid when starting the MCP server',
    )
    expect(() => parseCliArgs(['doctor', '--tool-profile', 'essential'])).toThrow(
      '--tool-profile is only valid when starting the MCP server',
    )
  })

  it('documents the profile flag in standalone help', () => {
    expect(formatCliHelp()).toContain('--tool-profile <profile>')
  })
})
