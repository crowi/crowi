import { escapeHtml } from '@crowi/plugin-api';
import { isHttpUrl, type OgMeta } from './fetch-og';

/**
 * Card HTML builders. Output is restricted to the elements the web
 * editor's sanitize allow-list already recognises (`figure` / `a` /
 * `div` / `img` / `span` — `packages/web/src/components/editor/known-tags.ts`),
 * so `stripUnknownElements` passes the structure through unchanged.
 *
 * `figure.crowi-link-card > a > (div.crowi-link-card-body[> div.title,
 * div.description?, div.meta[> span.site-name?, span.domain]] + img?)`
 * — see spec §"カード HTML(sanitize 経路との整合)". Every author/external
 * string (title / description / site name / domain / og:image) is
 * HTML-escaped; the anchor's `href` is only ever emitted for a
 * validated http(s) URL (falls back to `#` otherwise) so a
 * non-http(s)-scheme card URL (e.g. `javascript:`) can never reach a
 * clickable `href`, even defensively (the caller is expected to have
 * already scheme-gated via `fetch-og.ts`, but this module doesn't
 * trust that at its own boundary).
 */

/** `url`'s hostname, or the raw string if it doesn't parse as a URL at all (defensive fallback — should not happen for anything that reached this module). */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The href value to emit for `url` — the url itself when it's a safe http(s) absolute URL (per `fetch-og.ts`'s shared `isHttpUrl`, the single scheme gate for both defence layers), otherwise an inert `#` so a non-http(s) scheme (`javascript:`, `data:`, …) never becomes a clickable navigation target. */
function safeHref(url: string): string {
  return isHttpUrl(url) ? url : '#';
}

/** An http(s)-only image src, or `undefined` to drop the `<img>` entirely (defence-in-depth — `fetch-og.ts` already filters this at extraction time). */
function safeImageSrc(image: string | undefined): string | undefined {
  return image !== undefined && isHttpUrl(image) ? image : undefined;
}

/**
 * Render a successful card. `meta = {}` (an HTML page with no
 * recognised OGP tags at all) produces the domain-only text card — the
 * title falls back to the domain and the meta row shows only the
 * domain.
 *
 * The domain is ALWAYS shown in `.crowi-link-card-domain` — it is
 * derived from the target `url` itself, never from author/OGP-supplied
 * data, so it's the one piece of provenance a reader can always trust.
 * `og:site_name` (when present and different from the domain) is
 * rendered as an ADDITIONAL `.crowi-link-card-site-name` element
 * alongside it, never as a replacement for it.
 */
export function renderCard(url: string, meta: OgMeta = {}): string {
  const domain = extractDomain(url);
  const title = meta.title || domain;
  const image = safeImageSrc(meta.image);
  const siteName = meta.siteName && meta.siteName.trim().toLowerCase() !== domain.toLowerCase() ? meta.siteName : undefined;

  const parts: string[] = [];
  parts.push('<figure class="crowi-link-card">');
  parts.push(`<a class="crowi-link-card-link" href="${escapeHtml(safeHref(url))}" target="_blank" rel="noopener noreferrer">`);
  parts.push('<div class="crowi-link-card-body">');
  parts.push(`<div class="crowi-link-card-title">${escapeHtml(title)}</div>`);
  if (meta.description) {
    parts.push(`<div class="crowi-link-card-description">${escapeHtml(meta.description)}</div>`);
  }
  parts.push('<div class="crowi-link-card-meta">');
  if (siteName) {
    parts.push(`<span class="crowi-link-card-site-name">${escapeHtml(siteName)}</span>`);
  }
  parts.push(`<span class="crowi-link-card-domain">${escapeHtml(domain)}</span>`);
  parts.push('</div>');
  parts.push('</div>');
  if (image) {
    parts.push(`<img class="crowi-link-card-image" alt="" loading="lazy" src="${escapeHtml(image)}">`);
  }
  parts.push('</a>');
  parts.push('</figure>');
  return parts.join('');
}

/**
 * Render the UNIFIED fallback card (feature-renderer-plugin-boundary
 * spec §6.1/§6.2) — the ONE piece of link-card's implementation that is
 * NOT a verbatim move from the previous standalone link-card renderer
 * plugin. Replaces the old `renderErrorCard()`: every path that cannot
 * show a real OGP card now renders this SAME html for the SAME `url` —
 *   (a) an OGP fetch failure (SSRF block, timeout, non-2xx, bad scheme,
 *       oversized body, non-HTML content-type, network error), and
 *   (b) the `security:linkCardEnabled` admin toggle reading `false` at
 *       dispatch time (`core/link-card/index.ts`) —
 * so "fetch failed" and "toggle off" are byte-identical for the same
 * URL, never distinguishable to the reader.
 *
 * Deliberately matches the editor's live-preview placeholder's visual
 * contract (`packages/web/src/components/editor/link-card-preview-
 * placeholder.ts`'s `renderPlaceholder()`, untouched by this move): the
 * `crowi-link-card` / `crowi-link-card-title` class vocabulary, the URL
 * itself (NOT the domain — unlike `renderCard()`'s domain-only
 * fallback) shown verbatim as the card's title, no OGP fields
 * (title/description/image/site-name), and no error-specific styling
 * or "Preview unavailable" label. The two are necessarily different DOM
 * shapes (the editor placeholder is `<span>`-only phrasing content —
 * see that file's own doc comment on why; this is
 * `<figure>`/`<a>`/`<div>` block content) because editor preview never
 * dispatches a renderer at all and therefore has no link semantics —
 * this server-side card keeps the ORIGINAL error card's link semantics
 * so a reader can always still reach the URL even when Crowi couldn't
 * (or was told not to) preview it: `target="_blank"` +
 * `rel="noopener noreferrer"`, `href` gated through the same
 * `safeHref()` non-http(s)-scheme defence as `renderCard()`.
 */
export function renderFallbackCard(url: string): string {
  const parts: string[] = [];
  parts.push('<figure class="crowi-link-card">');
  parts.push(`<a class="crowi-link-card-link" href="${escapeHtml(safeHref(url))}" target="_blank" rel="noopener noreferrer">`);
  parts.push('<div class="crowi-link-card-body">');
  parts.push(`<div class="crowi-link-card-title">${escapeHtml(url)}</div>`);
  parts.push('</div>');
  parts.push('</a>');
  parts.push('</figure>');
  return parts.join('');
}
