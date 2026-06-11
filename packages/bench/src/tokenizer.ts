/**
 * Real-tokenizer counting for the benchmark — replaces the char/4 heuristic
 * with a genuine BPE count when the suite needs benchmark-grade numbers.
 *
 * Uses `gpt-tokenizer` (pure JS, no native bindings): an openly published
 * GPT-class BPE encoding. Claude-class tokenizers are not public, so this is a
 * documented proxy — the absolute counts are exact for GPT-class models and
 * representative (same order, same relative savings) for other modern BPE
 * tokenizers. The server-side `_meta.estimated_tokens` stays the dependency-free
 * char/4 heuristic; ONLY the bench takes this dependency, so consumers of
 * `@electron-stagewright/core` gain nothing in their install graph.
 *
 * @module
 */

import { countTokens } from 'gpt-tokenizer'

/** Count real BPE tokens for one raw MCP response text. */
export function countRealTokens(text: string): number {
  return countTokens(text)
}
