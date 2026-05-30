/**
 * Lightweight single-element read tools that need no accessibility machinery, so
 * they run a tiny inline renderer body rather than injecting the walker bundle:
 * `electron_get_text`, `electron_get_value`, `electron_get_attribute`,
 * `electron_get_bbox`, `electron_get_computed_style`, `electron_exists`.
 *
 * @module
 */

import { z } from 'zod'

import { refField, selectorField, sessionIdField } from '../schema.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { type ReadRaw, runTargetedRead } from './probe.js'

/** Hard cap on computed-style property count to keep responses token-bounded. */
const MAX_STYLE_PROPERTIES = 50

/** Wrap a `return …` body with the standard "resolve selector or report a miss" preamble. */
function inlineRead(returnExpr: string): string {
  return `let el;\ntry {\n  el = document.querySelector(arg.selector);\n} catch (err) {\n  return { found: false, invalid_selector: true, error: err instanceof Error ? err.message : String(err) };\n}\nif (el === null) return { found: false };\n${returnExpr}`
}

/** `electron_get_text` — the element's trimmed text content. */
export const getTextTool: AnyToolDefinition = defineTool({
  name: 'electron_get_text',
  title: 'Get an element’s text',
  description: [
    'Return the trimmed textContent of the element identified by ref or selector.',
    'Returns: { ok, session_id, text }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (no such element;',
    'carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector or',
    'ref+selector both/neither).',
  ].join(' '),
  inputSchema: z.object({ ref: refField, selector: selectorField, sessionId: sessionIdField }),
  operationType: 'query',
  handler: (args, ctx) =>
    runTargetedRead(
      ctx,
      args,
      (selector) => ({
        body: inlineRead("return { found: true, text: (el.textContent || '').trim() };"),
        arg: { selector },
      }),
      (raw: ReadRaw) => ({ text: raw['text'] }),
    ),
})

/** `electron_get_value` — the `.value` of a form control (null for non-controls). */
export const getValueTool: AnyToolDefinition = defineTool({
  name: 'electron_get_value',
  title: 'Get a form control’s value',
  description: [
    'Return the .value of the input/textarea/select identified by ref or selector (null if the element',
    'has no value). Returns: { ok, session_id, value }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH',
    '(carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({ ref: refField, selector: selectorField, sessionId: sessionIdField }),
  operationType: 'query',
  handler: (args, ctx) =>
    runTargetedRead(
      ctx,
      args,
      (selector) => ({
        body: inlineRead(
          "return { found: true, value: (typeof el.value === 'string' ? el.value : null) };",
        ),
        arg: { selector },
      }),
      (raw: ReadRaw) => ({ value: raw['value'] ?? null }),
    ),
})

/** `electron_get_attribute` — an HTML attribute value (null when the attribute is absent). */
export const getAttributeTool: AnyToolDefinition = defineTool({
  name: 'electron_get_attribute',
  title: 'Get an element attribute',
  description: [
    'Return the value of attribute `name` on the element identified by ref or selector',
    '(null when the attribute is absent — that is not an error). Returns: { ok, session_id, value }.',
    'Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), TRANSPORT_UNSUPPORTED,',
    'NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    name: z.string().min(1).describe('Attribute name, e.g. "href" or "aria-label".'),
    sessionId: sessionIdField,
  }),
  operationType: 'query',
  handler: (args, ctx) =>
    runTargetedRead(
      ctx,
      args,
      (selector) => ({
        body: inlineRead('return { found: true, value: el.getAttribute(arg.name) };'),
        arg: { selector, name: args.name },
      }),
      (raw: ReadRaw) => ({ value: raw['value'] ?? null }),
    ),
})

/** `electron_get_bbox` — the element's bounding box in CSS pixels. */
export const getBboxTool: AnyToolDefinition = defineTool({
  name: 'electron_get_bbox',
  title: 'Get an element’s bounding box',
  description: [
    'Return the bounding box (CSS pixels) of the element identified by ref or selector.',
    'Returns: { ok, session_id, bbox: { x, y, w, h } }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH',
    '(carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({ ref: refField, selector: selectorField, sessionId: sessionIdField }),
  operationType: 'query',
  handler: (args, ctx) =>
    runTargetedRead(
      ctx,
      args,
      (selector) => ({
        body: inlineRead(
          "if (typeof el.getBoundingClientRect !== 'function') return { found: true, bbox: { x: 0, y: 0, w: 0, h: 0 } };\nconst r = el.getBoundingClientRect();\nreturn { found: true, bbox: { x: r.x, y: r.y, w: r.width, h: r.height } };",
        ),
        arg: { selector },
      }),
      (raw: ReadRaw) => ({ bbox: raw['bbox'] }),
    ),
})

/** `electron_get_computed_style` — the requested computed CSS properties only. */
export const getComputedStyleTool: AnyToolDefinition = defineTool({
  name: 'electron_get_computed_style',
  title: 'Get computed CSS properties',
  description: [
    'Return the computed value of each requested CSS property (kebab-case, e.g. "background-color")',
    `for the element identified by ref or selector (max ${MAX_STYLE_PROPERTIES} properties).`,
    'Only the requested properties are returned, never the full declaration.',
    'Returns: { ok, session_id, style: { <prop>: <value> } }.',
    'Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), TRANSPORT_UNSUPPORTED,',
    'NOT_RUNNING, BAD_ARGUMENT.',
  ].join(' '),
  inputSchema: z.object({
    ref: refField,
    selector: selectorField,
    properties: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_STYLE_PROPERTIES)
      .describe(
        `CSS properties to read, kebab-case (e.g. ["display", "background-color"]). Max ${MAX_STYLE_PROPERTIES}.`,
      ),
    sessionId: sessionIdField,
  }),
  operationType: 'query',
  handler: (args, ctx) =>
    runTargetedRead(
      ctx,
      args,
      (selector) => ({
        body: inlineRead(
          'const cs = getComputedStyle(el);\nconst style = {};\nfor (const p of arg.properties) { style[p] = cs.getPropertyValue(p); }\nreturn { found: true, style };',
        ),
        arg: { selector, properties: args.properties },
      }),
      (raw: ReadRaw) => ({ style: raw['style'] ?? {} }),
    ),
})

/** `electron_exists` — whether the element is present (never errors on no-match). */
export const existsTool: AnyToolDefinition = defineTool({
  name: 'electron_exists',
  title: 'Check whether an element exists',
  description: [
    'Return whether the element identified by ref or selector is present in the DOM. A no-match is a',
    'normal result (exists: false), NOT an error — so an agent can poll for appearance/disappearance.',
    'Returns: { ok, session_id, exists }. Errors: TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT',
    '(invalid selector or ref+selector both/neither).',
  ].join(' '),
  inputSchema: z.object({ ref: refField, selector: selectorField, sessionId: sessionIdField }),
  operationType: 'query',
  handler: (args, ctx) =>
    runTargetedRead(
      ctx,
      args,
      (selector) => ({
        // Emit `exists` explicitly (not via the `found` sentinel) so this tool
        // follows the same body shape as the others and a no-match stays a
        // success (treatMissAsError: false), never a SELECTOR_NO_MATCH.
        body: 'try {\n  return { found: true, exists: document.querySelector(arg.selector) !== null };\n} catch (err) {\n  return { found: false, invalid_selector: true, error: err instanceof Error ? err.message : String(err) };\n}',
        arg: { selector },
      }),
      (raw: ReadRaw) => ({ exists: raw['exists'] === true }),
      { treatMissAsError: false },
    ),
})
