/**
 * Web Storage through the CDP `DOMStorage` domain, shared by the Playwright and CDP transports. It
 * reads and writes a frame's localStorage / sessionStorage in the browser without running page
 * JavaScript, the same way the storage seam reads cookies.
 *
 * @module
 */

import type { WebStorageRequest, WebStorageResponse } from './types.js'

/** Sends one CDP command on the connection that owns the frame. */
export type CdpSend = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

interface FrameInfo {
  readonly id: string
  readonly url?: string
  readonly securityOrigin?: string
}

interface FrameTreeNode {
  readonly frame: FrameInfo
  readonly childFrames?: readonly FrameTreeNode[]
}

function flatten(node: FrameTreeNode): FrameInfo[] {
  return [node.frame, ...(node.childFrames ?? []).flatMap(flatten)]
}

/** Which frame to use: by CDP frame id, by URL, or the main frame when neither matches. */
export interface FrameSelector {
  readonly frameId?: string | undefined
  readonly url?: string | undefined
}

/** Run one {@link WebStorageRequest} against the selected frame's storage area. */
export async function runDomStorage(
  send: CdpSend,
  selector: FrameSelector,
  request: WebStorageRequest,
): Promise<WebStorageResponse> {
  const { frameTree } = await send<{ frameTree: FrameTreeNode }>('Page.getFrameTree')
  const frames = flatten(frameTree)
  const matched =
    frames.find((candidate) => candidate.id === selector.frameId) ??
    frames.find((candidate) => selector.url !== undefined && candidate.url === selector.url)
  const isLocalStorage = request.area === 'local'
  let origin: string
  let storageId: Record<string, unknown>
  if (matched === undefined && selector.url !== undefined) {
    // A cross-origin frame in its own process is not in this page's tree; address it by origin.
    origin = new URL(selector.url).origin
    storageId = { securityOrigin: origin, isLocalStorage }
  } else {
    const frame = matched ?? frameTree.frame
    origin =
      frame.securityOrigin !== undefined && frame.securityOrigin !== ''
        ? frame.securityOrigin
        : new URL(frame.url ?? 'about:blank').origin
    // Current Chromium keys storage by storage key; older builds only accept the security origin.
    const storageKey = await send<{ storageKey?: string }>('Storage.getStorageKeyForFrame', {
      frameId: frame.id,
    }).then(
      (result) => result.storageKey,
      () => undefined,
    )
    storageId =
      storageKey !== undefined
        ? { storageKey, isLocalStorage }
        : { securityOrigin: origin, isLocalStorage }
  }
  await send('DOMStorage.enable').catch(() => undefined)
  try {
    switch (request.op) {
      case 'items': {
        const result = await send<{ entries?: readonly (readonly [string, string])[] }>(
          'DOMStorage.getDOMStorageItems',
          { storageId },
        )
        return { origin, entries: result.entries ?? [] }
      }
      case 'set':
        await send('DOMStorage.setDOMStorageItem', {
          storageId,
          key: request.key ?? '',
          value: request.value ?? '',
        })
        return { origin }
      case 'remove':
        await send('DOMStorage.removeDOMStorageItem', { storageId, key: request.key ?? '' })
        return { origin }
      case 'clear':
        await send('DOMStorage.clear', { storageId })
        return { origin }
    }
  } finally {
    // Left on, the domain streams an event for every storage write the app makes on this socket.
    await send('DOMStorage.disable').catch(() => undefined)
  }
}
