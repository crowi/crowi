/**
 * Sanitise a search-result snippet that may contain `<mark>` highlight tokens
 * from the search driver (e.g. Elasticsearch's `highlight` field).
 *
 * Allow-list policy:
 *   - `<mark>` / `</mark>` survive as bare tags (no attributes).
 *   - `<mark class="...">` (or any other attribute) is accepted as a tag-name
 *     match, but attributes are stripped — emitted as plain `<mark>`. This is
 *     a pragmatic UX call: drivers occasionally emit attributes (`class`,
 *     `data-*`) and showing them escaped to the user (`<mark class="x">x</mark>`
 *     literally) is worse than silently dropping the attributes.
 *   - Tag names are matched case-insensitively (`<MARK>` is accepted).
 *   - Self-closing `<mark/>` is escaped (uncommon and ambiguous; we'd rather
 *     surface it as visible text than silently emit an empty mark).
 *   - Any other tag (`<script>`, `<img>`, …) is HTML-escaped so it surfaces
 *     as visible text rather than executing.
 *   - Orphan opens (`<mark>hi`) are auto-closed at the end.
 *   - Orphan closes (`</mark>foo`) are dropped.
 *
 * We deliberately avoid pulling in DOMPurify (~30KB gzipped) — the allow-list
 * is a single tag so a small regex-based pass is enough and keeps the bundle
 * lean. The render itself uses `dangerouslySetInnerHTML` confined to the
 * `SearchHitSnippet` component (and only after this sanitiser has run), so
 * callers never have to touch raw HTML.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const HTML_ESCAPE_RE = /[&<>"']/g;

/**
 * Escape HTML-special characters via a single regex pass + lookup table.
 * `&` is only escaped once: callers pass raw text, never previously-escaped
 * markup.
 */
export function escapeHtml(s: string): string {
  return s.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPES[ch] ?? ch);
}

// Match any HTML-ish tag (`<...>` or `</...>`). We bound the inner span to
// 200 chars to mitigate pathological regex DoS on adversarial input — real
// snippets never come close to that.
const TAG_RE = /<\/?[a-zA-Z][^>]{0,200}>/g;

// `<mark>` open with optional attributes and optional whitespace, e.g.
// `<mark>`, `<mark class="x">`, `<MARK  data-y="z" >`. The trailing `/?` is
// rejected by an explicit check below so `<mark/>` falls through to escape.
const MARK_OPEN_RE = /^<mark(?:\s[^>]{0,200})?>$/i;
const MARK_CLOSE_RE = /^<\/mark\s*>$/i;
const SELF_CLOSING_TAIL_RE = /\/\s*>$/;

/**
 * Sanitise `raw` to a string where only `<mark>` / `</mark>` survive as
 * tags; everything else (text and other tags) is HTML-escaped. Attribute
 * payloads on `<mark>` are stripped. Unbalanced tags are repaired (orphan
 * opens auto-closed at end, orphan closes dropped).
 */
export function sanitiseSnippet(raw: string): string {
  let out = '';
  let lastIndex = 0;
  let openDepth = 0;

  // Reset before first use because TAG_RE is `/g` (stateful via lastIndex).
  TAG_RE.lastIndex = 0;
  for (let match = TAG_RE.exec(raw); match !== null; match = TAG_RE.exec(raw)) {
    const tok = match[0];
    if (match.index > lastIndex) {
      out += escapeHtml(raw.slice(lastIndex, match.index));
    }
    lastIndex = match.index + tok.length;

    if (MARK_OPEN_RE.test(tok) && !SELF_CLOSING_TAIL_RE.test(tok)) {
      out += '<mark>';
      openDepth += 1;
    } else if (MARK_CLOSE_RE.test(tok)) {
      if (openDepth > 0) {
        out += '</mark>';
        openDepth -= 1;
      }
      // else: orphan close — drop silently.
    } else {
      out += escapeHtml(tok);
    }
  }

  if (lastIndex < raw.length) {
    out += escapeHtml(raw.slice(lastIndex));
  }

  // Auto-close any still-open `<mark>` tags so we never emit unbalanced
  // markup into the DOM.
  while (openDepth > 0) {
    out += '</mark>';
    openDepth -= 1;
  }

  return out;
}
