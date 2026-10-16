import type { Root } from 'hast';

/**
 * Loose structural view over mdast-derived HAST (which also carries the
 * non-standard `raw` node) so the passes can walk and rebuild trees without
 * `any`. Output is always cast back to the real `Root` at the boundary.
 */
export interface LNode {
  type: string;
  value?: unknown;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: LNode[];
  content?: LNode;
  data?: Record<string, unknown>;
  position?: unknown;
}

export type SanitizeFailure = 'invalid-input' | 'resource-limit' | 'parse-failed';

export class SanitizeFailureError extends Error {
  constructor(readonly code: SanitizeFailure) {
    super(code);
    this.name = 'SanitizeFailureError';
  }
}

export function emptyRoot(): Root {
  return { type: 'root', children: [] };
}

/** UTF-8 byte length of a JS string without allocating. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tags that carry code-like content; a closed pair is removed with its content. */
export const CODE_CONTENT_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'xmp',
  'textarea',
  'title',
  'plaintext',
]);

export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p',
  'div',
  'span',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'main',
  'nav',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'br',
  'hr',
  'em',
  'strong',
  'b',
  'i',
  's',
  'del',
  'ins',
  'u',
  'small',
  'sub',
  'sup',
  'mark',
  'abbr',
  'q',
  'cite',
  'dfn',
  'kbd',
  'samp',
  'var',
  'code',
  'pre',
  'ruby',
  'rt',
  'rp',
  'wbr',
  'bdi',
  'bdo',
  'time',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'a',
  'img',
  'figure',
  'figcaption',
  'details',
  'summary',
  'input',
]);

export type HtmlSanitizationPolicy = 'strict' | 'relaxed';

/** Origins an embedded iframe must not point at (the app itself and artifact delivery). */
export type HtmlIframeOrigins = Readonly<{ webOrigin: string; apiOrigin: string; artifactOrigin: string | null }>;

/** Passive layout tags the relaxed policy adds; a closed set, no custom elements. */
export const RELAXED_EXTRA_TAGS: ReadonlySet<string> = new Set([
  'address',
  'hgroup',
  'search',
  'menu',
  'center',
  'font',
  'big',
  'tt',
  'strike',
  'acronym',
  'nobr',
  'rb',
  'rtc',
  'data',
  'listing',
]);

export const RELAXED_ALLOWED_TAGS: ReadonlySet<string> = new Set([...ALLOWED_TAGS, ...RELAXED_EXTRA_TAGS]);

/** Allowed tags that may contain flow content (valid targets for a hoisted block). */
export const FLOW_CONTAINERS: ReadonlySet<string> = new Set([
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'main',
  'nav',
  'li',
  'dd',
  'blockquote',
  'caption',
  'th',
  'td',
  'figure',
  'figcaption',
  'details',
]);

/** Elements whose content model is phrasing-only; their id/source anchors are kept on the first surviving clone. */
export const ANCHOR_CARRIER_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary', 'dt']);

export const PHRASING_TAGS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'dfn',
  'em',
  'i',
  'img',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
  'del',
  'ins',
  'input',
]);

export const HEADING_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export const SLOT_PROPERTY = 'dataCrowiGeneratedSlot';
export const NONCE_RE = /^[0-9a-f]{32}$/;
export const MAX_INPUT_UTF8_BYTES = 64 * 1024 * 1024;
