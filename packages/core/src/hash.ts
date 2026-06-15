/**
 * FNV-1a 32-bit string hash — the project's one canonical content hash.
 *
 * Pure JS over UTF-8 bytes; runs in any context (renderer, Node, jsdom, Workers)
 * with no `crypto.subtle` dependency. It backs two unrelated callers, which is why
 * it lives in a neutral leaf module rather than under `snapshot/`:
 *
 * - snapshot fingerprint identity (`computeFingerprint`), and
 * - the eval `code_hash` audit/correlation breadcrumb (ADR-014) — a stable,
 *   non-reversible label for an eval payload that lets a stderr audit line and a
 *   blocked-eval error envelope be correlated WITHOUT ever recording the payload.
 *
 * @module
 */

const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193
const UTF8_ENCODER = new TextEncoder()

/**
 * FNV-1a 32-bit hash of a UTF-8 string, returned as a zero-padded 8-character hex
 * string. Pure function; the same input always yields the same output across
 * runtimes. Encodes UTF-8 bytes (not UTF-16 code units, which would mis-hash
 * astral-plane characters) and multiplies with `Math.imul` so the required 32-bit
 * overflow semantics stay exact past JS's safe-integer range.
 */
export function fnv1a32(input: string): string {
  let hash = FNV_OFFSET_BASIS_32
  for (const byte of UTF8_ENCODER.encode(input)) {
    hash ^= byte
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
