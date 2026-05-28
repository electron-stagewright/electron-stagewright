/**
 * Unit tests for the logger: level filtering, field serialisation, base64
 * truncation, and the load-bearing invariant that nothing is ever written to
 * stdout (which is the MCP protocol channel).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { StderrLogger, truncateForLog } from '../src/server/logger.js'

const FIXED_NOW = () => new Date('2026-05-28T00:00:00.000Z')

describe('StderrLogger level filtering', () => {
  it('drops lines below the configured level', () => {
    const lines: string[] = []
    const log = new StderrLogger({ level: 'warn', sink: (l) => lines.push(l), now: FIXED_NOW })
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('WARN w')
    expect(lines[1]).toContain('ERROR e')
  })

  it('formats timestamp, level, message, and JSON fields', () => {
    const lines: string[] = []
    const log = new StderrLogger({ level: 'debug', sink: (l) => lines.push(l), now: FIXED_NOW })
    log.info('hello', { tool: 'electron_info', count: 2 })
    expect(lines[0]).toBe('2026-05-28T00:00:00.000Z INFO hello {"tool":"electron_info","count":2}')
  })

  it('omits the field blob when no fields are passed', () => {
    const lines: string[] = []
    const log = new StderrLogger({ level: 'debug', sink: (l) => lines.push(l), now: FIXED_NOW })
    log.info('bare')
    expect(lines[0]).toBe('2026-05-28T00:00:00.000Z INFO bare')
  })

  it('never throws on non-serialisable fields', () => {
    const lines: string[] = []
    const log = new StderrLogger({ level: 'debug', sink: (l) => lines.push(l), now: FIXED_NOW })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => log.info('loop', circular)).not.toThrow()
    expect(lines[0]).toContain('_log_error')
  })
})

describe('truncateForLog', () => {
  it('truncates a long base64-looking string with a marker', () => {
    const long = 'A'.repeat(500)
    const out = truncateForLog(long)
    expect(typeof out).toBe('string')
    expect((out as string).length).toBeLessThan(long.length)
    expect(out as string).toContain('[base64 truncated]')
  })

  it('truncates a data: URL', () => {
    const out = truncateForLog('data:image/png;base64,AAAA')
    expect(out as string).toContain('[base64 truncated]')
  })

  it('passes short strings through unchanged', () => {
    expect(truncateForLog('short')).toBe('short')
  })

  it('passes non-strings through unchanged', () => {
    expect(truncateForLog(42)).toBe(42)
    expect(truncateForLog(null)).toBe(null)
  })

  it('does not truncate a long string with non-base64 characters', () => {
    const prose = 'the quick brown fox '.repeat(50)
    expect(truncateForLog(prose)).toBe(prose)
  })
})

describe('StderrLogger writes to stderr, never stdout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes to process.stderr and leaves stdout untouched', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const log = new StderrLogger({ level: 'info', now: FIXED_NOW })
    log.info('to stderr only')
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).not.toHaveBeenCalled()
  })
})
