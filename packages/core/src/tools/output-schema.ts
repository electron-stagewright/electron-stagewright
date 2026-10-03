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

const responseSchemas = new WeakMap<z.ZodObject, ReturnType<typeof buildResponseSchema>>()

function buildResponseSchema(payload: z.ZodObject) {
  return z.union([payload.loose().extend({ ok: z.literal(true), _meta: metaSchema }), errorSchema])
}

/** Add the stable success/error envelopes around a tool's declared success payload. */
export function toolResponseSchema(payload: z.ZodObject) {
  let schema = responseSchemas.get(payload)
  if (schema === undefined) {
    schema = buildResponseSchema(payload)
    responseSchemas.set(payload, schema)
  }
  return schema
}

/** Readable issues from the envelope branch that matches the result's `ok` flag. */
export function describeResponseIssues(error: z.ZodError, ok: boolean): string[] {
  return error.issues
    .flatMap((issue) =>
      issue.code === 'invalid_union' ? (issue.errors[ok ? 0 : 1] ?? [issue]) : [issue],
    )
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
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
