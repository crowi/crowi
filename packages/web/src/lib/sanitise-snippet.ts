/**
 * Allow-list snippet sanitiser. Only bare `<mark>` / `</mark>` tags survive
 * (attributes stripped, self-closing rejected); everything else is HTML-escaped
 * and unbalanced opens are auto-closed. Avoids pulling in DOMPurify for a
 * single allow-listed tag.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const HTML_ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(s: string): string {
  return s.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPES[ch] ?? ch);
}

// Inner span bounded to 200 chars as a regex-DoS guard.
const TAG_RE = /<\/?[a-zA-Z][^>]{0,200}>/g;
const MARK_OPEN_RE = /^<mark(?:\s[^>]{0,200})?>$/i;
const MARK_CLOSE_RE = /^<\/mark\s*>$/i;
const SELF_CLOSING_TAIL_RE = /\/\s*>$/;

export function sanitiseSnippet(raw: string): string {
  let out = '';
  let lastIndex = 0;
  let openDepth = 0;

  // TAG_RE is `/g` (stateful via lastIndex) — reset before first use.
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

  while (openDepth > 0) {
    out += '</mark>';
    openDepth -= 1;
  }

  return out;
}
