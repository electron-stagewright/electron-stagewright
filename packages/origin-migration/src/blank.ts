/** An empty document with no script, style or network access. */
export const BLANK_DOCUMENT_HTML =
  '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title></title>'

/** The blank document as a `protocol.handle` response for the migration's target URL. */
export function blankDocumentResponse(): Response {
  return new Response(BLANK_DOCUMENT_HTML, { headers: { 'content-type': 'text/html' } })
}
