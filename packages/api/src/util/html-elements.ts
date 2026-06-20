/**
 * Canonical HTML5 element name set + helpers for detecting / stripping HTML
 * tags from arbitrary text.
 *
 * This lives in a neutral util module (not under `migration/` or `renderer/`)
 * because BOTH the renderer (heading TOC label extraction) and the migration
 * layer (the `toc-html-strip` staleness predicate, the `wikilink-format`
 * detection gate) need the same authoritative element set. Renderer code must
 * not import from `migration/`, so the set lives here and is imported back by
 * the migrations.
 *
 * Source: https://developer.mozilla.org/en-US/docs/Web/HTML/Element — the full
 * standard element list as of the HTML Living Standard.
 *
 * `h1`..`h6` are listed explicitly. The deprecated/obsolete presentational
 * elements `font` / `center` / `marquee` / `blink` / `applet` are included on
 * purpose: they no longer appear in the MDN current element list but still
 * occur in real legacy wiki content (e.g. `### <font color="1a73e8">…</font>`
 * headings), so `</font>` etc. MUST be treated as close tags rather than
 * rewritten to `[[/font]]` by `wikilink-format`.
 */
export const KNOWN_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'address',
  'applet',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blink',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'font',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'marquee',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

/**
 * Single module-level regex matching an open / close / self-closing tag for
 * ANY name in `KNOWN_HTML_ELEMENTS`, case-insensitively. Built once from the
 * set so `stripKnownHtmlTags` never walks the set per call.
 *
 * The `\b` after the element name is load-bearing: it anchors the match to a
 * word boundary so `<font color=x>` / `<font>` / `</font>` match but `<fontain>`
 * (not an element) does NOT. `<int>` (not a known element) is left intact.
 *
 * `[^>]*` consumes any attributes (and a trailing `/` for `<br/>`) up to the
 * closing `>`.
 */
const KNOWN_HTML_TAG_REGEX = new RegExp(`</?(?:${[...KNOWN_HTML_ELEMENTS].join('|')})\\b[^>]*>`, 'gi');

/**
 * Remove every `<elem …>` / `</elem>` / `<elem/>` substring whose name is a
 * known HTML element, case-insensitively. Text that merely contains a `<`
 * (`price < 100`) or an unknown tag-like token (`Using List<int> in C#`) is
 * returned unchanged.
 */
export function stripKnownHtmlTags(text: string): string {
  KNOWN_HTML_TAG_REGEX.lastIndex = 0;
  return text.replace(KNOWN_HTML_TAG_REGEX, '');
}

/**
 * True iff `text` contains at least one known HTML tag. Defined in terms of
 * `stripKnownHtmlTags` so the predicate and the strip can never diverge (a
 * string contains a known tag iff stripping changes it).
 */
export function containsKnownHtmlTag(text: string): boolean {
  return stripKnownHtmlTags(text) !== text;
}
