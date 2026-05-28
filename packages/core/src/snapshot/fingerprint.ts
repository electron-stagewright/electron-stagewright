/**
 * Fingerprint hash for snapshot entries. Uses FNV-1a 32-bit over UTF-8 bytes —
 * pure JS, runs in any context (renderer, Node, jsdom, Workers), no
 * `crypto.subtle` dependency.
 *
 * Collision probability for our use case (~200 entries per snapshot, distinct
 * strings concatenating role + name + last-3-ancestor-roles) is negligible: at
 * 2^32 ≈ 4.3 billion hash space and 200 inputs, expected collisions are around
 * 4.6e-6 per snapshot. Acceptable for ref-stability identity.
 *
 * @module
 */

const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193
const UTF8_ENCODER = new TextEncoder()

/**
 * FNV-1a 32-bit hash of a UTF-8 string, returned as a zero-padded 8-character
 * hex string. Pure function; same input always yields same output across
 * runtimes.
 */
export function fnv1a32(input: string): string {
  let hash = FNV_OFFSET_BASIS_32
  for (const byte of UTF8_ENCODER.encode(input)) {
    hash ^= byte
    // Math.imul preserves the required 32-bit overflow semantics. Plain
    // number multiplication loses precision once the intermediate value grows
    // past JS's safe integer range.
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

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
