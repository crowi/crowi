import type { OgMeta } from './fetch-og';

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

/** `&`/`<`/`>`/`"`/`'` escape — same convention as `@crowi/plugin-renderer-katex`'s local `escapeHtml` (no shared util package exists for this). */
function escapeHtml(s: string): string {
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

/** `url`'s hostname, or the raw string if it doesn't parse as a URL at all (defensive fallback — should not happen for anything that reached this module). */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Whether `value` parses as an absolute `http:`/`https:` URL — the shared safety check behind both `safeHref` and `safeImageSrc` below. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The href value to emit for `url` — the url itself when it's a safe http(s) absolute URL, otherwise an inert `#` so a non-http(s) scheme (`javascript:`, `data:`, …) never becomes a clickable navigation target. */
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

/** Render the failure-path card — a working link (domain + "preview unavailable" label) so the author's URL never loses its link function on fetch/SSRF/timeout/HTTP-error failure (spec §"失敗の扱い", AC-1). */
export function renderErrorCard(url: string): string {
  const domain = extractDomain(url);
  const parts: string[] = [];
  parts.push('<figure class="crowi-link-card crowi-link-card-error">');
  parts.push(`<a class="crowi-link-card-link" href="${escapeHtml(safeHref(url))}" target="_blank" rel="noopener noreferrer">`);
  parts.push('<div class="crowi-link-card-body">');
  parts.push(`<div class="crowi-link-card-title">${escapeHtml(domain)}</div>`);
  parts.push('<span class="crowi-link-card-error-label">Preview unavailable</span>');
  parts.push('</div>');
  parts.push('</a>');
  parts.push('</figure>');
  return parts.join('');
}
