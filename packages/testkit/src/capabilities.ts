import type { TransportCapabilities } from '../../core/src/transports/index.js'

/** Every capability enabled, suitable for a fake that stands in for the default transport. */
export const FULL_CAPABILITIES = Object.freeze({
  canLaunch: true,
  canAttach: true,
  canInject: true,
  canIntercept: true,
  canControlClock: true,
  canAccessStorage: true,
  canAccessNativeUI: true,
  supportsMainEval: true,
  supportsRendererEval: true,
  supportsInteraction: true,
  supportsSurfaceTargeting: true,
} satisfies TransportCapabilities)

/** Return a mutable capability matrix without sharing test state between callers. */
export function fullCapabilities(
  overrides: Partial<TransportCapabilities> = {},
): TransportCapabilities {
  return { ...FULL_CAPABILITIES, ...overrides }
}
