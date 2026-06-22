/**
 * Canonical HTML5 element name set + a helper for stripping HTML tags from
 * arbitrary text.
 *
 * This lives in the shared `@crowi/api-contract` package because BOTH sides of
 * the wall need the SAME strip logic:
 *
 *   - the api renderer (`renderer/core/headings.ts`) slugs a heading's anchor
 *     id from the HTML-stripped heading text, and
 *   - the web TOC (`components/page-view/page-toc.tsx`) strips the same tags
 *     out of the displayed label at render time.
 *
 * Keeping the set + the `stripKnownHtmlTags` regex here means anchor-id
 * generation (server) and label display (client) can never diverge. The api
 * migration layer (`wikilink-format`'s detection gate) also imports the set
 * from here.
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
 *
 * The set is kept a SUPERSET of the web body renderer's inline-kept HTML tag
 * allow-list (`packages/web/src/components/editor/known-tags.ts`'s
 * `HTML_TAGS`): a tag the body renders inline (e.g. `<strike>` / `<tt>` /
 * `<big>` / `<acronym>` / `<nobr>` / `<search>` …) must also be stripped from a
 * TOC label so the displayed label matches the rendered body text. The
 * cross-guard test in `html-elements.test.ts` fails if the body adds an inline
 * tag this set misses. (SVG tags are camelCase and never appear as inline
 * heading markup, so they are intentionally NOT mirrored here.)
 */
export const KNOWN_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'acronym',
  'address',
  'applet',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'basefont',
  'bdi',
  'bdo',
  'big',
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
  'dir',
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
  'frame',
  'frameset',
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
  'listing',
  'main',
  'map',
  'mark',
  'marquee',
  'menu',
  'menuitem',
  'meta',
  'meter',
  'nav',
  'nobr',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'param',
  'picture',
  'pre',
  'progress',
  'q',
  'rb',
  'rp',
  'rt',
  'rtc',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strike',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'svg',
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
  'tt',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
  'xmp',
]);

/**
 * Single module-level regex matching an open / close / self-closing tag for
 * ANY name in `KNOWN_HTML_ELEMENTS`, case-insensitively. Built once from the
 * set so `stripKnownHtmlTags` never walks the set per call.
 *
 * The `(?![\w-])` after the element name is load-bearing: it asserts the name
 * is NOT followed by another name char or a hyphen, so `<font>` / `<font color=x>`
 * / `</font>` match but `<fontain>` (a longer word) and `<code-sample>` /
 * `<data-foo>` (hyphenated CUSTOM elements whose prefix is a known tag) do NOT —
 * matching the web body renderer, which keeps every hyphenated custom element
 * (`known-tags.ts`: `tagName.includes('-')`). `<int>` (not a known element) is
 * left intact.
 *
 * The attribute run `(?:[^>"']|"[^"]*"|'[^']*')*` consumes attributes (and a
 * trailing `/` for `<br/>`) up to the closing `>`, but tolerates a `>` inside a
 * quoted attribute value: `<a title="a > b">` strips fully instead of stopping
 * at the first `>`. The three alternatives are disjoint on their first char
 * (a bare non-`>`/non-quote char vs. a `"`/`'`-opened run), so the quantifier
 * cannot backtrack ambiguously — the match stays linear.
 */
const KNOWN_HTML_TAG_REGEX = new RegExp(`</?(?:${[...KNOWN_HTML_ELEMENTS].join('|')})(?![\\w-])(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');

/**
 * Upper bound on the input `stripKnownHtmlTags` will actually scan. A TOC label
 * / heading text is never legitimately longer than this; anything above it is
 * pathological input (e.g. a malformed `<i<i<i…` run designed to make the
 * attribute scan backtrack). Returning such input unchanged keeps the helper
 * O(1) on adversarial input and protects the synchronous SAVE path (run per
 * heading, on the event loop) and the per-TOC-entry client render path.
 */
export const STRIP_KNOWN_HTML_TAGS_MAX_LENGTH = 4096;

/**
 * Remove every `<elem …>` / `</elem>` / `<elem/>` substring whose name is a
 * known HTML element, case-insensitively. Text that merely contains a `<`
 * (`price < 100`) or an unknown tag-like token (`Using List<int> in C#`) is
 * returned unchanged.
 *
 * Inputs longer than `STRIP_KNOWN_HTML_TAGS_MAX_LENGTH` are returned unchanged
 * WITHOUT running the regex — a heading / TOC label is never that long, and the
 * cap is the cheap defence against a crafted long run blocking the event loop.
 */
export function stripKnownHtmlTags(text: string): string {
  if (text.length > STRIP_KNOWN_HTML_TAGS_MAX_LENGTH) return text;
  KNOWN_HTML_TAG_REGEX.lastIndex = 0;
  return text.replace(KNOWN_HTML_TAG_REGEX, '');
}
