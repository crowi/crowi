/**
 * HTML-emitting helper for renderer plugins.
 *
 * A renderer plugin that builds HTML from author-controlled or external
 * strings (an OGP title, a math error message, …) must escape them, and
 * that escape is a security primitive — a hardening change has to reach
 * every plugin at once, not whichever local copies someone remembers.
 * This is the SDK's single copy (`@crowi/plugin-renderer-katex` and
 * `@crowi/plugin-renderer-link-card` each carried an identical local one
 * before it was hoisted here).
 */

/** Escape `&` `<` `>` `"` `'` for interpolation into HTML text or double/single-quoted attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}
