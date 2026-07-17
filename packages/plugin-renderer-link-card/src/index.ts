import type { CrowiPlugin, EmbedRenderer, RenderResult } from '@crowi/plugin-api';
import { type FetchOgErrorCode, type FetchOgResult, fetchOg } from './fetch-og';
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
 * Design note on failure rendering: `EmbedRenderer.render()` NEVER sets
 * `RenderResult.error` here. The core's error path
 * (`packages/api/src/renderer/cache/reservation.ts:errorPlaceholder`)
 * unconditionally discards a plugin's returned `html` and substitutes a
 * generic, link-less placeholder — which would violate this feature's
 * AC-1 ("エラー時はリンクとして機能するエラーカード"). Instead every
 * failure path (SSRF block, timeout, non-2xx, bad scheme, oversized
 * body, network error) renders through `renderErrorCard()` — a working
 * `<a href>` to the original URL — as a normal *successful*
 * `RenderResult`, with a shorter `ttlSec` so a transient failure is
 * retried sooner than a successful card (see `pickErrorTtlSec`).
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
/** Fresh TTL for a failure that's likely to resolve itself soon (network blip, timeout, oversized response, 5xx, too-many-redirects). */
const TRANSIENT_ERROR_TTL_SEC = 5 * 60; // 5min
/** Fresh TTL for a failure unlikely to change on the next request (SSRF-blocked host, non-http(s) scheme, non-HTML content-type, 4xx "not found"-class response). */
const PERSISTENT_ERROR_TTL_SEC = 60 * 60; // 1h

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
      return { html: renderErrorCard(url), ttlSec: pickErrorTtlSec(result.code, result.httpStatus) };
    default: {
      // Exhaustiveness guard — a new `FetchOgResult` kind must be handled above.
      const _unreachable: never = result;
      return _unreachable;
    }
  }
}

function pickErrorTtlSec(code: FetchOgErrorCode, httpStatus: number | undefined): number {
  if (code === 'blocked' || code === 'bad-scheme' || code === 'unsupported-content-type') return PERSISTENT_ERROR_TTL_SEC;
  if (code === 'http-error' && httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    return PERSISTENT_ERROR_TTL_SEC;
  }
  return TRANSIENT_ERROR_TTL_SEC;
}
