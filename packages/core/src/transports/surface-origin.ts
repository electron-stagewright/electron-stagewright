/**
 * Origin relation between a renderer frame and its parent surface (ADR-022), shared by every
 * transport that reports frame surfaces.
 *
 * @module
 */

import type { SurfaceDescriptor } from './types.js'

/** Compare the origins of a parent and child surface URL; unparseable or opaque URLs are `opaque`. */
export function originRelation(
  parentUrl: string | undefined,
  childUrl: string,
): NonNullable<SurfaceDescriptor['originRelation']> {
  if (parentUrl === undefined) return 'opaque'
  try {
    const parent = new URL(parentUrl)
    const child = new URL(childUrl)
    if (parent.origin === 'null' || child.origin === 'null') return 'opaque'
    return parent.origin === child.origin ? 'same-origin' : 'cross-origin'
  } catch {
    return 'opaque'
  }
}
