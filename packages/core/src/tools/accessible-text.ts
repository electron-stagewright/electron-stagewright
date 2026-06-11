/**
 * Shared renderer-side text extraction for `electron_get_text` and the `expect_text` /
 * `assert_pattern` text source, so the two ALWAYS agree on what an element's text is.
 *
 * It returns the element's trimmed text content — skipping text inside
 * `style`/`script`/`noscript`/`template` nodes, which is markup plumbing rather
 * than copy (a Monaco editor injects ~3 KB of CSS rules as a `<style>` child,
 * which would otherwise bloat every text payload and bury the real content) —
 * falling back, when there is no text content, to the accessible label that
 * `electron_find` matches on (aria-labelledby, aria-label, native labels, alt,
 * title, placeholder). Without this fallback a
 * `find`-by-accessible-name → assert chain breaks on icon-only / labelled controls: `find`
 * matches an element whose name comes from an accessible label, but its `textContent` is
 * empty, so `expect_text({ contains })` and `get_text` would report `""`.
 *
 * This is a deliberately lighter mirror of the full W3C accname algorithm in
 * `snapshot/accname.ts` (which runs inside the injected snapshot bundle): it covers the
 * high-value label sources rather than the complete precedence. textContent stays the
 * PRIMARY source — the fallback only applies when textContent is empty — so an element
 * whose `aria-label` deliberately differs from its visible text still reads as its visible
 * text (callers asserting on an accessible-name override should target that string, which
 * the tool descriptions call out).
 *
 * @module
 */

/**
 * A renderer-evaluable function declaration string defining `__swAccessibleText(el)`.
 * Prepend it to an inline body, then call `__swAccessibleText(el)` to read text. Exposed as
 * a string (not a function) because it is serialised into the renderer by the transport's
 * `evaluate`, never executed in the Node process.
 */
export const ACCESSIBLE_TEXT_FN = `function __swAccessibleText(el) {
  if (el === null || el === undefined) return '';
  function isNonContentTag(node) {
    var tag = (node.tagName || '').toLowerCase();
    return tag === 'style' || tag === 'script' || tag === 'noscript' || tag === 'template';
  }
  function contentText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    if (node.nodeType === 1 && isNonContentTag(node)) return '';
    var out = '';
    for (var i = 0; i < node.childNodes.length; i += 1) {
      out += contentText(node.childNodes.item(i));
    }
    return out;
  }
  var text = contentText(el).trim();
  if (text) return text;
  if (typeof el.getAttribute !== 'function') return '';
  function textOf(node, exclude) {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    if (isNonContentTag(node)) return '';
    if (exclude && node === exclude) return '';
    var parts = [];
    for (var i = 0; i < node.childNodes.length; i += 1) {
      var part = textOf(node.childNodes.item(i), exclude);
      if (part) parts.push(part);
    }
    return parts.join(' ').trim();
  }
  function rootOf(node) {
    if (node && typeof node.getRootNode === 'function') return node.getRootNode();
    return node.ownerDocument || document;
  }
  function byId(node, id) {
    var root = rootOf(node);
    if (root && typeof root.getElementById === 'function') return root.getElementById(id);
    var doc = node.ownerDocument || document;
    return doc.getElementById(id);
  }
  function labelsInScope(node) {
    var root = rootOf(node);
    if (root && typeof root.querySelectorAll === 'function') return root.querySelectorAll('label');
    var doc = node.ownerDocument || document;
    return doc.getElementsByTagName('label');
  }
  function isFormControl(node) {
    var tagName = (node.tagName || '').toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || tagName === 'button';
  }
  var ids = el.getAttribute('aria-labelledby');
  if (ids) {
    var parts = ids.split(/\\s+/).map(function (id) {
      var ref = id ? byId(el, id) : null;
      return ref ? textOf(ref) : '';
    });
    var joined = parts.filter(Boolean).join(' ').trim();
    if (joined) return joined;
  }
  var label = el.getAttribute('aria-label');
  if (label && label.trim()) return label.trim();
  var tagName = (el.tagName || '').toLowerCase();
  if (isFormControl(el)) {
    var elementId = el.getAttribute('id');
    if (elementId) {
      var labels = labelsInScope(el);
      var labelParts = [];
      for (var i = 0; i < labels.length; i += 1) {
        var candidate = labels.item ? labels.item(i) : labels[i];
        if (candidate && candidate.getAttribute('for') === elementId) {
          var labelText = textOf(candidate);
          if (labelText) labelParts.push(labelText);
        }
      }
      var explicitLabel = labelParts.join(' ').trim();
      if (explicitLabel) return explicitLabel;
    }
    var parent = el.parentElement;
    while (parent) {
      if ((parent.tagName || '').toLowerCase() === 'label') {
        var wrappingLabel = textOf(parent, el);
        if (wrappingLabel) return wrappingLabel;
        break;
      }
      parent = parent.parentElement;
    }
  }
  if (tagName === 'img' || tagName === 'area' || (tagName === 'input' && el.getAttribute('type') === 'image')) {
    var alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
  }
  var title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();
  if (isFormControl(el)) {
    var placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
  }
  return '';
}`
