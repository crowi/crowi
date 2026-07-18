import type { CrowiPlugin, EmbedRenderer, RenderError, RenderResult } from '@crowi/plugin-api';
import { type FetchOgResult, fetchOg } from './fetch-og';
import { renderCard, renderErrorCard } from './render-card';

/**
 * @crowi/plugin-renderer-link-card
 *
 * Renders `@[card](url)` embeds (the `addEmbedTag('card', …)` registry
 * seam — RFC-0002 §"Phase 4" — this is its first user) as an OGP
 * title/description/domain/image preview card. Fetches the target
 * page's OGP `<meta>` tags through an SSRF-guarded GET (see
 * `ssrf-guard.ts` / `fetch-og.ts`) and renders sanitised HTML built
 * only from the web editor's known-tag allow-list (`render-card.ts`).
 *
 * No configurable settings — timeout / body-size cap / redirect cap /
 * concurrency cap are internal constants (spec §"登録・運用": "config
 * 節は timeout 等の内部定数のみ"), so this plugin ships with no
 * `configSchema` at all (mirrors `@crowi/plugin-renderer-katex` /
 * `@crowi/plugin-renderer-emoji`, which are also config-free).
 *
 * Failure rendering: every failure path (SSRF block, timeout, non-2xx,
 * bad scheme, oversized body, non-HTML content-type, network error)
 * sets `RenderResult.error` + `errorHtml: renderErrorCard(url)` — a
 * working `<a href>` to the original URL. `errorHtml` is a first-class
 * part of the core's render contract (`@crowi/plugin-api`'s
 * `RenderResult.errorHtml`): the core shows it in place of the generic
 * link-less `errorPlaceholder()` whenever `error` is set alongside it,
 * so AC-1 ("エラー時はリンクとして機能するエラーカード") holds without
 * this plugin having to pretend a failure was a successful render. TTL
 * cadence for each failure category comes straight from the core's
 * `RENDER_ERROR_TTL` table (`packages/api/src/renderer/cache/index.ts`)
 * via `RenderError.code` — see `toRenderError` for the code mapping.
 */

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-renderer-link-card',
  version: '0.1.0-dev',
  adminPlacement: {
    section: 'renderer',
    label: 'Link cards',
    icon: 'link',
  },
  registerRenderer: (registry, ctx) => {
    registry.addEmbedTag('card', createLinkCardRenderer());
    ctx.log.debug('registered @[card](url) link-card embed renderer');
  },
};

export default plugin;

/** Bump whenever the rendered HTML shape changes (`renderCard` / `renderErrorCard`). */
export const LINK_CARD_CACHE_VERSION = 1;

/** Fresh TTL for a successful card — OGP metadata rarely changes. */
const SUCCESS_TTL_SEC = 60 * 60; // 1h

export function createLinkCardRenderer(): EmbedRenderer {
  return {
    cacheVersion: LINK_CARD_CACHE_VERSION,
    reservation: { variant: 'card', size: 'medium' },
    async render(input): Promise<RenderResult> {
      const result = await fetchOg(input.url);
      return toRenderResult(input.url, result);
    },
  };
}

function toRenderResult(url: string, result: FetchOgResult): RenderResult {
  switch (result.kind) {
    case 'ok':
      return { html: renderCard(url, result.meta), ttlSec: SUCCESS_TTL_SEC };
    case 'error':
      return { html: '', errorHtml: renderErrorCard(url), error: toRenderError(result) };
    default: {
      // Exhaustiveness guard — a new `FetchOgResult` kind must be handled above.
      const _unreachable: never = result;
      return _unreachable;
    }
  }
}

/**
 * Map a `fetch-og.ts` failure onto the core's `RenderError.code` table
 * (spec §"link-card の正規経路移行"). Pre-migration, `pickErrorTtlSec`
 * only treated a `400 <= httpStatus < 500` `http-error` as persistent
 * (1h) — every other case (3xx, 5xx, no `httpStatus`, and every
 * non-`http-error` code) got the transient 5min TTL. The mapping below
 * preserves that split exactly (AC3: "TTL が移行前と同値") while adding
 * `rate_limit`/`blocked` as new, more specific codes:
 *
 *   - `blocked` / `bad-scheme` / `unsupported-content-type` → `blocked`
 *     (policy-level permanent rejection — new persistent-class code,
 *     did not exist pre-migration).
 *   - `http-error` 429 with a parsed `Retry-After` → `rate_limit` +
 *     `retryAfterSec` (honours the server's own cadence instead of the
 *     core's 5min default).
 *   - `http-error` 4xx (incl. a 429 with no `Retry-After`) → `not_found`
 *     (persistent, matches the old `400 <= httpStatus < 500` branch).
 *   - `http-error` anything else — 3xx (redirect-exhausted), 5xx, or no
 *     `httpStatus` at all (the unreachable-in-practice loop-exhaustion
 *     fallback) → `network` (transient, matches the old fallthrough).
 *   - `timeout` → `timeout`, `network` → `network` (pass through as-is,
 *     both already transient pre-migration).
 *   - `too-large` / `unknown` → `unknown` (transient pre-migration).
 *
 * The original `fetch-og.ts` code + httpStatus are preserved in
 * `message` for observability even though they collapse onto a
 * narrower `RenderError.code` set.
 */
function toRenderError(result: Extract<FetchOgResult, { kind: 'error' }>): RenderError {
  const { code, httpStatus, retryAfterSec } = result;
  const message = httpStatus !== undefined ? `${code} (HTTP ${httpStatus})` : code;

  if (code === 'blocked' || code === 'bad-scheme' || code === 'unsupported-content-type') {
    return { code: 'blocked', message };
  }
  if (code === 'http-error') {
    if (httpStatus === 429 && retryAfterSec !== undefined) {
      return { code: 'rate_limit', message, retryAfterSec };
    }
    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
      return { code: 'not_found', message };
    }
    // 3xx (redirect-exhausted), 5xx, or no httpStatus — transient.
    return { code: 'network', message };
  }
  if (code === 'timeout' || code === 'network') return { code, message };
  // 'too-large' | 'unknown'
  return { code: 'unknown', message };
}
