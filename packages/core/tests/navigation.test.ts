/**
 * Unit tests for `isRendererNavigation`: the transport messages for a renderer that navigated
 * mid-call match, and an error the evaluated code throws with the same words does not.
 */

import { describe, expect, it } from 'vitest'

import { StagewrightError } from '../src/errors/registry.js'
import { isRendererNavigation } from '../src/transports/navigation.js'

describe('isRendererNavigation', () => {
  it.each([
    'page.evaluate: Execution context was destroyed, most likely because of a navigation.',
    'frame.evaluate: Execution context was destroyed, most likely because of a navigation',
    'locator.click: Execution context was destroyed, most likely because of a navigation',
    'CDP Runtime.evaluate failed: Inspected target navigated or closed',
    'CDP Runtime.callFunctionOn failed: Inspected target navigated or closed',
    'CDP Page.captureScreenshot failed: Not attached to an active page',
  ])('matches %s', (message) => {
    expect(isRendererNavigation(new Error(message))).toBe(true)
    expect(isRendererNavigation(new StagewrightError('INTERNAL_ERROR', message))).toBe(true)
  })

  it.each([
    'page.evaluate: Error: Execution context was destroyed',
    'CDP evaluation threw: Error: Inspected target navigated or closed',
    'Execution context was destroyed',
    'renderer bridge closed',
  ])('does not match %s', (message) => {
    expect(isRendererNavigation(new Error(message))).toBe(false)
  })
})
