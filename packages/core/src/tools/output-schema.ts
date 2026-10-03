import { z } from 'zod'

const metaSchema = z.looseObject({
  estimated_tokens: z.number().nonnegative(),
  elapsed_ms: z.number().nonnegative(),
  session_id: z.string().optional(),
})

const errorSchema = z.looseObject({
  ok: z.literal(false),
  error: z.string(),
  code: z.string(),
  hint: z.string(),
  retryable: z.boolean(),
  http: z.number(),
  _meta: metaSchema,
})

/** Add the stable success/error envelopes around a tool's declared success payload. */
export function toolResponseSchema(payload: z.ZodObject) {
  return z.union([payload.loose().extend({ ok: z.literal(true), _meta: metaSchema }), errorSchema])
}

/** Optional portable evidence fields; local-path-only embedders remain compatible. */
export const artifactOutputFields = {
  artifact: z
    .object({
      uri: z.string(),
      name: z.string(),
      mimeType: z.enum([
        'image/png',
        'image/jpeg',
        'application/x-ndjson',
        'application/json',
        'text/html',
      ]),
      size: z.number().int().nonnegative(),
      expires_at: z.string(),
    })
    .optional(),
  artifact_unavailable: z.enum(['too_large', 'capacity', 'closed', 'unsupported_type']).optional(),
}
