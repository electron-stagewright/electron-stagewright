/**
 * `@electron-stagewright/plugin-native-ui` — read, assert, and invoke an Electron app's **native chrome**:
 * the application menu (the macOS menu bar / app menu), for agent-driven testing (ADR-019, built on the
 * ADR-004 plugin contract). Ask "is the *Save* item enabled?", "did *Dark Mode* get checked under
 * *View*?", "does the *Edit* menu have a *Paste* item?", then trigger the action — state and actions that
 * live in the Electron main process, outside the DOM the agent already reads, without agent-supplied
 * JavaScript.
 *
 * Like the network, clock, and storage plugins, the tools ride a dedicated TRANSPORT SEAM (a fixed
 * main-process serializer/walker over `Menu.getApplicationMenu()`), not eval, so this plugin is NOT
 * `--allow-eval` gated. It IS gated on the transport's `canAccessNativeUI` capability
 * (`native.UNSUPPORTED` otherwise). Tools (namespaced by the loader): `native_menu`, `native_menu_item`,
 * `native_menu_invoke`.
 *
 * Reading the menu is observation of app chrome — not a secret surface (menu labels are no more sensitive
 * than the DOM text the agent already sees). Invoking a menu item modifies app behaviour by firing the
 * app's own handler, bounded by the same capability and plugin opt-in. The application menu is
 * cross-platform (Electron's `Menu` API); the macOS menu bar is its most prominent surface.
 *
 * @module
 */

import {
  defineTool,
  makePluginError,
  makeSuccess,
  type AnyToolDefinition,
  type NativeMenu,
  type NativeMenuItem,
  type StagewrightPlugin,
  type ToolContext,
  type ToolResult,
  type TransportSession,
} from '@electron-stagewright/core'
import { z } from 'zod'

/** Plugin namespace — must match {@link nativeUiPlugin.name}; the loader prefixes its tools with it. */
const NATIVE_NAMESPACE = 'native'
/** Plugin package version advertised by `electron_plugins`; keep in sync with package.json. */
const NATIVE_PLUGIN_VERSION = '0.2.0'

/** The envelope meta a plugin tool threads into `makeSuccess` / `makePluginError`. */
interface PluginMeta {
  readonly startedAt: number
  readonly now: () => number
}

/**
 * Resolve the session + assert its transport can access the native UI (`canAccessNativeUI`). Returns the
 * session, or the plugin-error envelope to return instead. Not eval-gated — this is a transport seam.
 */
function requireNativeUI(
  ctx: ToolContext,
  sessionId: string | undefined,
  meta: PluginMeta,
): { session: TransportSession } | { error: ToolResult } {
  const managed = ctx.sessions.resolve(sessionId)
  if (!managed.transport.capabilities.canAccessNativeUI) {
    return {
      error: makePluginError('native.UNSUPPORTED', {
        ...meta,
        message:
          'This session’s transport cannot access the native UI; use the default Playwright launch transport.',
      }),
    }
  }
  return { session: managed.session }
}

/** A path segment matches an item by its visible label OR its built-in role (so role-only items resolve). */
function itemMatches(item: NativeMenuItem, segment: string): boolean {
  return item.label === segment || item.role === segment
}

/** Walk a label/role path through the menu tree; return the matched item, or null when it does not resolve. */
function findByPath(menu: NativeMenu | null, path: readonly string[]): NativeMenuItem | null {
  if (menu === null || path.length === 0) return null
  let items: readonly NativeMenuItem[] = menu.items
  let match: NativeMenuItem | null = null
  for (const segment of path) {
    match = items.find((i) => itemMatches(i, segment)) ?? null
    if (match === null) return null
    items = match.submenu ?? []
  }
  return match
}

const sessionField = {
  sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
}

/** A non-empty label/role path from the top of the menu down to the target item (shared by find + invoke). */
const pathSchema = z
  .array(z.string().min(1))
  .min(1)
  .describe('Labels or roles from the top of the menu down to the target item.')

const menuTool: AnyToolDefinition = defineTool({
  name: 'menu',
  title: 'Read the application menu',
  description: [
    'Return the app’s application menu (the macOS menu bar / app menu) as a tree — each item’s label,',
    'role, type, accelerator, and enabled/visible/checked state, with nested submenus. The no-eval way',
    'to ASSERT native-menu state. Returns: { ok, menu } (menu is null when the app has none set).',
    'Errors: native.UNSUPPORTED (transport cannot read the native UI), NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ ...sessionField }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireNativeUI(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const menu = await guard.session.getApplicationMenu()
    return makeSuccess({ menu }, meta)
  },
})

const menuItemTool: AnyToolDefinition = defineTool({
  name: 'menu_item',
  title: 'Find one application-menu item',
  description: [
    'Resolve one menu item by its `path` — an array of labels or roles from the top of the menu, e.g.',
    '["View","Appearance","Dark Mode"] or ["Help","quit"]. The direct way to ask "is Dark Mode checked?"',
    'or "is Save enabled?" without walking the whole tree. Returns: { ok, found, item? } (found is false',
    'when the path does not resolve or the app has no menu). Errors: native.UNSUPPORTED, NOT_RUNNING,',
    'BAD_ARGUMENT (empty path).',
  ].join(' '),
  inputSchema: z.object({ path: pathSchema, ...sessionField }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireNativeUI(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const menu = await guard.session.getApplicationMenu()
    const item = findByPath(menu, args.path)
    return makeSuccess(item !== null ? { found: true, item } : { found: false }, meta)
  },
})

const menuInvokeTool: AnyToolDefinition = defineTool({
  name: 'menu_invoke',
  title: 'Invoke an application-menu item',
  description: [
    'Trigger an application-menu item by its `path` (labels or roles from the top of the menu, e.g.',
    '["File","Save"] or ["View","Dark Mode"]) — fires the app’s own menu handler, the deterministic way',
    'to run a menu action without simulating a keyboard accelerator. Read the item first with',
    'native_menu_item to confirm it is enabled and is not a role/submenu item. Returns:',
    '{ ok, invoked, label?, role?, reason? }. On success invoked is true and the resolved label/role are',
    'echoed; otherwise invoked is false and reason is one of not_found, disabled, role (a built-in role',
    'item — press its accelerator instead), submenu (descend into it), separator, or no_handler. Errors:',
    'native.UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (empty path).',
  ].join(' '),
  inputSchema: z.object({ path: pathSchema, ...sessionField }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireNativeUI(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const result = await guard.session.invokeApplicationMenuItem(args.path)
    return makeSuccess(result, meta)
  },
})

/**
 * The native-UI plugin. Load with `--plugin @electron-stagewright/plugin-native-ui` (NO eval flag — it
 * does not run agent-supplied JS) or `createServer({ plugins: [nativeUiPlugin] })`. No configuration.
 */
export const nativeUiPlugin: StagewrightPlugin = {
  name: NATIVE_NAMESPACE,
  version: NATIVE_PLUGIN_VERSION,
  coreVersionRange: '*',
  errorCodes: {
    UNSUPPORTED: {
      http: 409,
      retryable: false,
      hint: 'This transport cannot access the native UI; use the default Playwright launch transport.',
    },
  },
  tools: [menuTool, menuItemTool, menuInvokeTool],
}

export default nativeUiPlugin
