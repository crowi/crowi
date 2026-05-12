/**
 * Minimal regex-based SVG sanitizer.
 *
 * The PlantUML server is operator-trusted (they ran the docker-compose
 * container). The sanitizer is defence-in-depth for the case where the
 * operator's PlantUML server is compromised or returns user-controlled
 * content. It is NOT a substitute for DOMPurify — Phase 6.1+ may switch
 * to `isomorphic-dompurify` when the JSDOM cost is justified.
 *
 * What we strip (in order):
 *   1. `<script>...</script>` blocks (case-insensitive, multiline,
 *      tolerates whitespace + attributes on the open tag).
 *   2. `<foreignObject>...</foreignObject>` (can carry HTML, easy to
 *      smuggle script via). PlantUML diagrams never legitimately use
 *      foreignObject.
 *   3. `on*=` event-handler attributes from any element (onclick,
 *      onload, onerror, …). Strips both single and double-quoted
 *      values, plus unquoted bareword values.
 *   4. `javascript:` URL values from `href` / `xlink:href`. The full
 *      attribute pair is removed so the resulting element doesn't carry
 *      a dangling broken attribute.
 *
 * The implementation is pure-regex; no DOM, no jsdom, suitable for any
 * Node.js process. The expected input is server SVG output (well-
 * formed-ish XML), not arbitrary HTML — so the regex passes are
 * acceptably safe within that constrained shape.
 *
 * If the operator's threat model demands stricter sanitization, they
 * can wrap the output with a reverse proxy that runs DOMPurify, or wait
 * for the Phase 6.1+ DOMPurify integration.
 */

/** Strip `<script ...>...</script>` blocks. */
const SCRIPT_TAG_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
/** Strip `<foreignObject ...>...</foreignObject>` blocks. */
const FOREIGN_OBJECT_RE = /<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi;
/**
 * Strip `on<word>="..."` / `on<word>='...'` / `on<word>=<value>` event
 * handler attributes. The leading `\s` requirement prevents stripping
 * a substring like `son="..."` that happens to contain `on=`.
 */
const ON_EVENT_ATTR_RE = /\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
/**
 * Strip `href="javascript:..."` / `xlink:href="javascript:..."`
 * (case-insensitive, tolerates whitespace + quoting). Drops the entire
 * key-value pair so no dangling `href=` remains.
 */
const JAVASCRIPT_URL_ATTR_RE = /\s(?:xlink:)?href\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi;

/**
 * Sanitize an SVG string. Returns a copy with the disallowed
 * constructs removed. Idempotent: running twice produces the same
 * output as running once.
 */
export function sanitizeSvg(input: string): string {
  let out = input;
  out = out.replace(SCRIPT_TAG_RE, '');
  out = out.replace(FOREIGN_OBJECT_RE, '');
  out = out.replace(ON_EVENT_ATTR_RE, '');
  out = out.replace(JAVASCRIPT_URL_ATTR_RE, '');
  return out;
}
