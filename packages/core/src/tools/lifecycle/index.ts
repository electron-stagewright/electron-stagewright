/**
 * Lifecycle tools — manage the Electron app's life: launch, attach/inject,
 * stop/force-kill/detach, inspect, enumerate/switch windows, and discover
 * already-running apps.
 *
 * @module
 */

import type { AnyToolDefinition } from '../types.js'
import { attachTool, injectTool } from './attach.js'
import { discoverTool } from './discover.js'
import { infoTool } from './info.js'
import { launchTool } from './launch.js'
import { detachTool, forceKillTool, stopTool } from './session-control.js'
import { switchWindowTool, windowsListTool } from './windows.js'

export { infoTool, makeInfoTool, type InfoToolDeps } from './info.js'
export { launchTool, makeLaunchTool, type LaunchToolDeps } from './launch.js'
export { stopTool, forceKillTool, detachTool } from './session-control.js'
export { attachTool, injectTool } from './attach.js'
export { windowsListTool, switchWindowTool } from './windows.js'
export { resolveWindow, type WindowSelector } from './window-ref.js'
export { diagnoseLaunchError } from './diagnose.js'
export {
  discoverTool,
  makeDiscoverTool,
  discoverRunning,
  DEFAULT_DISCOVERY_PORTS,
  type DiscoveredTarget,
  type DiscoverOptions,
  type DiscoverResult,
  type DiscoverToolDeps,
  type PortProbe,
} from './discover.js'
export {
  inspectSignature,
  type SignatureInfo,
  type SignatureStatus,
  type SignatureVerifier,
  type InspectSignatureOptions,
} from './signature.js'

/**
 * The lifecycle tools registered with the dispatcher by default, in a stable
 * order (lifecycle creation → inspection → teardown → discovery).
 */
export const LIFECYCLE_TOOLS: readonly AnyToolDefinition[] = [
  launchTool,
  attachTool,
  injectTool,
  infoTool,
  windowsListTool,
  switchWindowTool,
  discoverTool,
  detachTool,
  stopTool,
  forceKillTool,
]
