import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { z } from 'zod'

import { makeError } from '../errors/envelope.js'
import type { ArtifactStore } from '../resources/artifacts.js'
import {
  describeResponseIssues,
  toolResponseJsonSchema,
  toolResponseSchema,
} from '../tools/output-schema.js'
import type { ToolResult } from '../tools/types.js'
import type { Logger } from './logger.js'

const EMPTY_PAYLOAD_SCHEMA = z.object({})
const MAX_STRUCTURED_CONTENT_CHARS = 50_000

/** Validate the actual JSON envelope before recording completion, and reuse its wire snapshot. */
export class ToolResultCodec {
  readonly #texts = new WeakMap<ToolResult, string>()
  readonly #validators = new WeakMap<z.ZodObject, ValidateFunction>()
  #ajv: Ajv2020 | undefined
  readonly #logger: Logger
  readonly #now: () => number

  constructor(logger: Logger, now: () => number) {
    this.#logger = logger
    this.#now = now
  }

  prepare(
    tool: string,
    raw: ToolResult,
    schema: z.ZodObject | undefined,
    startedAt: number,
  ): ToolResult {
    let result: ToolResult
    let text: string
    try {
      text = JSON.stringify(raw)
      result = JSON.parse(text) as ToolResult
    } catch {
      this.#logger.warn('Tool result was not JSON-serialisable', { tool })
      return this.#failure('Tool result was not JSON-serialisable.', startedAt)
    }
    try {
      const parsed = toolResponseSchema(schema ?? EMPTY_PAYLOAD_SCHEMA).safeParse(result)
      if (!parsed.success) {
        const message =
          schema === undefined
            ? 'Tool result did not match the response envelope'
            : 'Tool result did not match its declared output schema'
        this.#logger.warn(message, {
          tool,
          issues: describeResponseIssues(parsed.error, result?.ok === true),
        })
        return this.#failure(`${message}.`, startedAt)
      }
      if (schema !== undefined) {
        let validate = this.#validators.get(schema)
        if (validate === undefined) {
          // The advertised schema is draft 2020-12. Keep defaults, coercion and removal disabled;
          // format constraints have already been checked by Zod on the JSON snapshot above.
          this.#ajv ??= new Ajv2020({ strict: false, validateFormats: false })
          validate = this.#ajv.compile(toolResponseJsonSchema(schema))
          this.#validators.set(schema, validate)
        }
        if (!validate(result)) {
          this.#logger.warn('Tool result did not match its advertised JSON output schema', { tool })
          return this.#failure('Tool result did not match its declared output schema.', startedAt)
        }
      }
    } catch {
      this.#logger.warn('Tool output contract could not be validated', { tool })
      return this.#failure('Tool output contract could not be validated.', startedAt)
    }
    // Return the JSON snapshot rather than a handler object with getters or a toJSON hook.
    // Preserve all additive fields, not Zod's parsed/transformed projection.
    this.#texts.set(result, text)
    return result
  }

  #failure(message: string, startedAt: number): ToolResult {
    const result = makeError('INTERNAL_ERROR', { message, startedAt, now: this.#now })
    this.#texts.set(result, JSON.stringify(result))
    return result
  }

  /** Keep legacy JSON text first; declared schemas always retain structuredContent. */
  toMcp(
    envelope: ToolResult,
    hasOutputSchema: boolean,
    artifacts?: ArtifactStore,
    supportsResourceLinks = false,
  ): CallToolResult {
    const text = this.#texts.get(envelope)
    if (text === undefined) throw new Error('Tool result was not prepared before MCP encoding.')
    // Observers receive the completion snapshot. Encode from the retained text so a faulty
    // observer cannot change the response or reintroduce a serialization failure.
    const wire = JSON.parse(text) as ToolResult
    const candidate = wire.ok ? wire['artifact'] : undefined
    const descriptor =
      supportsResourceLinks &&
      typeof candidate === 'object' &&
      candidate !== null &&
      'uri' in candidate &&
      typeof candidate.uri === 'string'
        ? artifacts?.describe(candidate.uri)
        : undefined
    return {
      content: [
        { type: 'text', text },
        ...(descriptor === undefined
          ? []
          : [
              {
                type: 'resource_link' as const,
                uri: descriptor.uri,
                name: descriptor.name,
                mimeType: descriptor.mimeType,
                size: descriptor.size,
              },
            ]),
      ],
      ...(hasOutputSchema || text.length <= MAX_STRUCTURED_CONTENT_CHARS
        ? { structuredContent: wire as Record<string, unknown> }
        : {}),
      isError: !wire.ok,
    }
  }
}
