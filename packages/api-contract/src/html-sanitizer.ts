/**
 * Browser-safe HTML sanitizer for the Web renderer (the `./html-sanitizer`
 * subpath). Pure HAST in / HAST out: no DOM, React or Node-only API, and no
 * dependency on the HTTP contract modules, so bundling it pulls in only the
 * HTML parser. See the spec's R-2..R-8 for the model: author HTML is parsed
 * and restricted, generated HTML (marked at render time) is composed as-is.
 */
import type { Root } from 'hast';
import { escapeUnknownRawHtml as escapeUnknownRawHtmlImpl } from './html-sanitizer/raw-classify';
import type { LNode } from './html-sanitizer/model';

export { CLOBBERING_NAMES, filterAuthorAnchorAttributes } from './html-sanitizer/anchors';
export type { AnchorProvenance } from './html-sanitizer/anchors';
export type { SanitizeFailure } from './html-sanitizer/model';
export { sanitizeDisplayUrl, sanitizeIframeSrc, safeDecodeFragment, validateImageDisplayProps } from './html-sanitizer/url';
export { sanitizeRelaxedStyle } from './relaxed-html-style';
export type { ImageDisplayProps } from './html-sanitizer/url';
export { validateWebRenderInput } from './html-sanitizer/validate';
export {
  RELAXED_HTML_SCHEMA,
  STRICT_HTML_SCHEMA,
  sanitizeRelaxedClassName,
  composeGeneratedFragments,
  parseAuthoredHast,
  prepareAuthoredTree,
  sanitizeAuthoredTree,
  sanitizeWebHast,
} from './html-sanitizer/sanitize';
export type { HtmlIframeOrigins, HtmlSanitizationPolicy, PreparedParse, SanitizeContext, SanitizeWebHastResult } from './html-sanitizer/sanitize';

/** Demotes raw chunks whose leading tag is unknown to text, in place. */
export function escapeUnknownRawHtml(tree: Root): void {
  escapeUnknownRawHtmlImpl(tree as unknown as LNode);
}
