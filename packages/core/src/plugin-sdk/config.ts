/**
 * Immutable configuration helpers for in-process plugins.
 *
 * Plugin configuration is operator-supplied data (CLI JSON or `pluginConfigs`), not a
 * communication channel back into the host application. Parsing it once and keeping a
 * frozen copy prevents a caller from changing a running plugin by retaining the input object.
 *
 * @module
 */

import type { z } from 'zod'

/** Recursively readonly view of JSON-like plugin configuration data. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer Key, infer Value>
    ? ReadonlyMap<DeepReadonly<Key>, DeepReadonly<Value>>
    : T extends ReadonlySet<infer Value>
      ? ReadonlySet<DeepReadonly<Value>>
      : T extends readonly (infer Value)[]
        ? readonly DeepReadonly<Value>[]
        : T extends object
          ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
          : T

/** Raised when a plugin configuration does not satisfy its declared Zod schema. */
export class PluginConfigValidationError extends Error {
  override readonly name = 'PluginConfigValidationError'

  constructor(message: string) {
    super(message)
  }
}

/** Mutable holder with an immutable current configuration value. */
export interface PluginConfigState<T> {
  /** The current deeply frozen config snapshot. */
  readonly current: DeepReadonly<T>
  /** Replace the current value with an isolated, deeply frozen snapshot. */
  set(value: T): void
  /** Restore the isolated, deeply frozen defaults supplied at construction. */
  reset(): void
}

/**
 * Parse a plugin config and return an isolated immutable snapshot.
 *
 * Plugin configs are data supplied through JSON-compatible inputs. The helper uses a structured
 * clone before freezing so later mutations to the caller's object cannot affect a running server.
 */
export function parsePluginConfig<T>(schema: z.ZodType<T>, raw: unknown): DeepReadonly<T> {
  const result = schema.safeParse(raw)
  if (!result.success) throw new PluginConfigValidationError(result.error.message)
  return immutableConfig(result.data)
}

/** Create per-plugin-instance config state with isolated immutable defaults. */
export function createPluginConfigState<T>(defaults: T): PluginConfigState<T> {
  const initial = immutableConfig(defaults)
  let current = initial

  return {
    get current(): DeepReadonly<T> {
      return current
    },
    set(value: T): void {
      current = immutableConfig(value)
    },
    reset(): void {
      current = initial
    },
  }
}

/** Clone configuration data before recursively freezing its object and array graph. */
function immutableConfig<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value)) as DeepReadonly<T>
}

/** Deep-freeze the ordinary object graph returned by plugin config schemas. */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)

  for (const key of Reflect.ownKeys(value)) {
    const child = Reflect.get(value, key) as unknown
    deepFreeze(child, seen)
  }
  return Object.freeze(value)
}
