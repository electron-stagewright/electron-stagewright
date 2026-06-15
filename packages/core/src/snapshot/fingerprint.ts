/**
 * Fingerprint composition for snapshot entries. The underlying hash is the shared
 * FNV-1a 32-bit (`fnv1a32` from `../hash.js`), re-exported here so the snapshot
 * module's public surface is unchanged.
 *
 * Collision probability for our use case (~200 entries per snapshot, distinct
 * strings concatenating role + name + last-3-ancestor-roles) is negligible: at
 * 2^32 ≈ 4.3 billion hash space and 200 inputs, expected collisions are around
 * 4.6e-6 per snapshot. Acceptable for ref-stability identity.
 *
 * @module
 */

import { fnv1a32 } from '../hash.js'

export { fnv1a32 }

/**
 * Compose the fingerprint payload from an entry's role, accessible name, and
 * the chain of ancestor roles. Slicing to the last 3 ancestors keeps the
 * fingerprint stable when a parent is wrapped in a new generic `<div>` while
 * a deep ancestor change still drifts the fingerprint (signals the agent
 * the structure mutated).
 */
export function computeFingerprint(
  role: string,
  name: string,
  ancestorRoles: readonly string[],
): string {
  const lastThree = ancestorRoles.slice(-3).join('>')
  return fnv1a32(`${role}|${name}|${lastThree}`)
}
