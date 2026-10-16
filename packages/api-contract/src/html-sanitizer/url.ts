import { IMAGE_ALIGN_VALUES, IMAGE_FLOAT_VALUES, validateImageSize } from '../util/image-display';
import type { HtmlIframeOrigins } from './model';
const ASCII_WS_EDGE_RE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;
// eslint-disable-next-line no-control-regex
const SCHEME_NOISE_RE = /[\u0000- \u007f]/g;
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/;
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;
const REJECTED_HREF_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'vbscript', 'data']);
const URL_VALIDATION_BASE = 'https://crowi.invalid/';

function validatesAsHttpUrl(value: string): boolean {
  try {
    return new URL(value).hostname !== '';
  } catch {
    return false;
  }
}

/**
 * The single URL gate for HTML attributes and Markdown links/images. The
 * returned value is the author's trimmed spelling — nothing is decoded or
 * normalised, so an obfuscated dangerous scheme cannot reappear downstream.
 * `undefined` means "drop the attribute" (href) or "show alt text" (src).
 */
export function sanitizeDisplayUrl(value: unknown, kind: 'href' | 'src'): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(ASCII_WS_EDGE_RE, '');
  const folded = trimmed.replace(SCHEME_NOISE_RE, '').toLowerCase();
  const scheme = SCHEME_RE.exec(folded)?.[1];

  if (kind === 'href') {
    if (scheme !== undefined && REJECTED_HREF_SCHEMES.has(scheme)) return undefined;
    return trimmed;
  }

  if (trimmed === '' || trimmed.startsWith('#')) return undefined;
  if (scheme === 'http' || scheme === 'https') return validatesAsHttpUrl(trimmed.replace(SCHEME_NOISE_RE, '')) ? trimmed : undefined;
  if (scheme === 'data') return DATA_IMAGE_RE.test(trimmed.replace(SCHEME_NOISE_RE, '')) ? trimmed : undefined;
  if (scheme !== undefined) return undefined;

  if (trimmed.startsWith('//') || trimmed.startsWith('\\\\')) return validatesAsHttpUrl(`https:${trimmed.replace(/\\/g, '/')}`) ? trimmed : undefined;
  try {
    new URL(trimmed, URL_VALIDATION_BASE);
  } catch {
    return undefined;
  }
  return trimmed;
}

/** Decodes a page hash once; a malformed escape returns the input unchanged. */
export function safeDecodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface ImageDisplayProps {
  width?: string;
  height?: string;
  align?: 'left' | 'center' | 'right';
  float?: 'left' | 'right';
}

function pick(props: Readonly<Record<string, unknown>>, kebab: string, camel: string): unknown {
  return props[kebab] ?? props[camel];
}

/**
 * Re-validates the four `data-crowi-image-*` transport values (kebab or camel
 * spelling, kebab wins). Out-of-range values are dropped, never clamped.
 */
export function validateImageDisplayProps(props: Readonly<Record<string, unknown>>): ImageDisplayProps {
  const out: ImageDisplayProps = {};
  const width = validateImageSize(pick(props, 'data-crowi-image-width', 'dataCrowiImageWidth'));
  if (width) out.width = width;
  const height = validateImageSize(pick(props, 'data-crowi-image-height', 'dataCrowiImageHeight'));
  if (height) out.height = height;
  const align = pick(props, 'data-crowi-image-align', 'dataCrowiImageAlign');
  if (typeof align === 'string' && IMAGE_ALIGN_VALUES.has(align)) out.align = align as ImageDisplayProps['align'];
  const float = pick(props, 'data-crowi-image-float', 'dataCrowiImageFloat');
  if (typeof float === 'string' && IMAGE_FLOAT_VALUES.has(float)) out.float = float as ImageDisplayProps['float'];
  return out;
}

// eslint-disable-next-line no-control-regex
const IFRAME_UNSAFE_CHAR_RE = /[\u0000-\u0020\u007f]/;

function httpOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin === 'null' ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/**
 * The iframe `src` gate (relaxed policy only): an explicit absolute `https:`
 * URL with a host and no credentials, whose origin is not the Web app, the
 * API, or the artifact origin. Missing or malformed origin information denies
 * every iframe. The author's spelling is kept once it passes.
 */
export function sanitizeIframeSrc(value: unknown, origins: HtmlIframeOrigins | undefined): string | undefined {
  if (typeof value !== 'string' || typeof origins !== 'object' || origins === null) return undefined;
  const blocked = new Set<string>();
  for (const candidate of [origins.webOrigin, origins.apiOrigin]) {
    const origin = httpOrigin(candidate);
    if (origin === undefined) return undefined;
    blocked.add(origin);
  }
  if (origins.artifactOrigin !== null) {
    const origin = httpOrigin(origins.artifactOrigin);
    if (origin === undefined) return undefined;
    blocked.add(origin);
  }

  const trimmed = value.replace(ASCII_WS_EDGE_RE, '');
  if (!/^https:/i.test(trimmed) || IFRAME_UNSAFE_CHAR_RE.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return undefined;
    return blocked.has(url.origin) ? undefined : trimmed;
  } catch {
    return undefined;
  }
}
