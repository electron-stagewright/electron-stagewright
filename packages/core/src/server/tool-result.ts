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

/** The retained wire text plus the fields MCP encoding reads, captured before observers run. */
interface PreparedWire {
  readonly text: string
  readonly ok: boolean
  readonly artifactUri: string | undefined
}

function preparedWire(result: ToolResult, text: string): PreparedWire {
  const candidate = result.ok ? result['artifact'] : undefined
  const artifactUri =
    typeof candidate === 'object' &&
    candidate !== null &&
    'uri' in candidate &&
    typeof candidate.uri === 'string'
      ? candidate.uri
      : undefined
  return { text, ok: result.ok, artifactUri }
}

/** Validate the actual JSON envelope before recording completion, and reuse its wire snapshot. */
export class ToolResultCodec {
  readonly #texts = new WeakMap<ToolResult, PreparedWire>()
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
      // The error branch of the advertised schema is the same loose envelope Zod just checked, so
      // only successes need the exact JSON check; a tool's genuine error is never masked by it.
      if (schema !== undefined && result.ok) {
        let validate = this.#validators.get(schema)
        if (validate === undefined) {
          this.#ajv ??= ToolResultCodec.#createAjv()
          validate = this.#ajv.compile(toolResponseJsonSchema(schema))
          this.#validators.set(schema, validate)
        }
        if (!validate(result)) {
          this.#logger.warn('Tool result did not match its advertised JSON output schema', {
            tool,
            issues: (validate.errors ?? []).map(
              (issue) => `${issue.instancePath || '(root)'}: ${issue.message ?? issue.keyword}`,
            ),
          })
          return this.#failure('Tool result did not match its declared output schema.', startedAt)
        }
      }
    } catch {
      this.#logger.warn('Tool output contract could not be validated', { tool })
      return this.#failure('Tool output contract could not be validated.', startedAt)
    }
    // Return the JSON snapshot rather than a handler object with getters or a toJSON hook.
    // Preserve all additive fields, not Zod's parsed/transformed projection.
    this.#texts.set(result, preparedWire(result, text))
    return result
  }

  /**
   * The advertised schema is draft 2020-12. Keep defaults, coercion and removal disabled. Format
   * and pattern constraints have already been checked by Zod on the same JSON snapshot: Zod's
   * JSON Schema drops regex flags, and Ajv compiles patterns in Unicode mode, so re-checking them
   * here would reject values Zod accepts or fail to compile an ordinary non-Unicode regex.
   */
  static #createAjv(): Ajv2020 {
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    ajv.removeKeyword('pattern')
    return ajv
  }

  #failure(message: string, startedAt: number): ToolResult {
    const result = makeError('INTERNAL_ERROR', { message, startedAt, now: this.#now })
    this.#texts.set(result, preparedWire(result, JSON.stringify(result)))
    return result
  }

  /** Keep legacy JSON text first; declared schemas always retain structuredContent. */
  toMcp(
    envelope: ToolResult,
    hasOutputSchema: boolean,
    artifacts?: ArtifactStore,
    supportsResourceLinks = false,
  ): CallToolResult {
    const prepared = this.#texts.get(envelope)
    if (prepared === undefined) throw new Error('Tool result was not prepared before MCP encoding.')
    // Observers receive the completion snapshot. Encode from the retained text so a faulty
    // observer cannot change the response or reintroduce a serialization failure.
    const { text, ok, artifactUri } = prepared
    const descriptor =
      supportsResourceLinks && artifactUri !== undefined
        ? artifacts?.describe(artifactUri)
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
      // Parse only when the structured copy ships; a huge schema-less payload is not re-parsed.
      ...(hasOutputSchema || text.length <= MAX_STRUCTURED_CONTENT_CHARS
        ? { structuredContent: JSON.parse(text) as Record<string, unknown> }
        : {}),
      isError: !ok,
    }
  }
}
