/**
 * Contract tests for the default MCP tool surface. These pin the agent-facing
 * invariants that make the server predictable to hosts and LLM callers: granular
 * `electron_*` names, inline error-code documentation, valid operation metadata,
 * and JSON-schema-renderable inputs.
 */

import { describe, expect, it } from 'vitest'

import { OperationTypeSchema } from '../src/errors/index.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { DEFAULT_TOOLS } from '../src/tools/index.js'

describe('default tool surface contract', () => {
  it('uses unique granular electron_* names', () => {
    const names = DEFAULT_TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBeGreaterThan(30)
    for (const name of names) {
      expect(name).toMatch(/^electron_[a-z0-9_]+$/)
    }
  })

  it('documents errors inline in agent-facing descriptions', () => {
    for (const tool of DEFAULT_TOOLS) {
      expect(tool.description, tool.name).toContain('Errors:')
    }
  })

  it('declares a valid operation type for every default tool', () => {
    for (const tool of DEFAULT_TOOLS) {
      expect(OperationTypeSchema.safeParse(tool.operationType).success, tool.name).toBe(true)
    }
  })

  it('uses specific operation types for observe tools', () => {
    const byName = new Map(DEFAULT_TOOLS.map((tool) => [tool.name, tool.operationType]))
    expect(byName.get('electron_screenshot')).toBe('screenshot')
    expect(byName.get('electron_console_logs')).toBe('logs')
    expect(byName.get('electron_dialog_handler')).toBe('dialog')
  })

  it('exposes the expect_* assertion family as query tools', () => {
    const byName = new Map(DEFAULT_TOOLS.map((tool) => [tool.name, tool.operationType]))
    const expectNames = [
      'electron_expect_text',
      'electron_expect_value',
      'electron_expect_visible',
      'electron_expect_state',
      'electron_expect_count',
      'electron_expect_url',
      'electron_assert_pattern',
    ]
    for (const name of expectNames) {
      expect(byName.get(name), name).toBe('query')
    }
  })

  it('registers into the dispatcher with JSON-schema-renderable input manifests', () => {
    // allowEval: true so the eval-gated tools register too — otherwise the
    // dispatcher hides them and the manifest is short of DEFAULT_TOOLS. (The
    // default-deny gate is exercised in eval-tools.test.ts.)
    const dispatcher = new Dispatcher({ sessions: new SessionManager(), allowEval: true })
    dispatcher.registerAll(DEFAULT_TOOLS)
    const manifest = dispatcher.listManifest()
    expect(manifest).toHaveLength(DEFAULT_TOOLS.length)
    for (const entry of manifest) {
      expect(entry.inputJsonSchema.type, entry.name).toBe('object')
    }
  })
})
