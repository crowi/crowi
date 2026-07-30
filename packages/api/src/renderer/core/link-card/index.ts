import type { EmbedRenderer, RenderError, RenderResult, StructuredRenderPayload } from '@crowi/plugin-api';
import { type FetchOgResult, fetchOg, isHttpUrl, type OgMeta } from './fetch-og';
import { renderCard, renderFallbackCard } from './render-card';

/**
 * `@[card](url)` embed — core Markdown feature
 * (feature-renderer-plugin-boundary Phase 3). Moved verbatim (SSRF
 * guard / OGP fetch / success rendering / cache semantics unchanged)
 * from the previous standalone link-card renderer plugin's
 * `createLinkCardRenderer()` (that plugin package is deleted from the
 * workspace as of Phase 4 — see spec §4/§5), except for the
 * failure-path builder (see `render-card.ts`'s
 * `renderFallbackCard()` doc comment) and the new
 * `security:linkCardEnabled` live toggle read below.
 *
 * Registered as a CORE-reserved embed tag via
 * `RendererRegistryImpl.addCoreEmbedTag('card', …)` from
 * `renderer/index.ts`'s `createRenderer()` — never through a
 * `CrowiPlugin.registerRenderer` hook, so a third-party plugin can
 * never last-wins-shadow it (`registry.ts`'s `addEmbedTag` throws
 * instead on a collision with a core-reserved tag).
 */

/**
 * Bump whenever the rendered HTML shape changes (`renderCard` /
 * `renderFallbackCard`). RFC-0023 §13 bumps 1 → 2: results now
 * additionally carry `structured` (the `crowiLinkCard` sidecar — html
 * unchanged byte-for-byte); without the bump, pre-RFC-0023 cache hits
 * would keep serving sidecar-less results until natural TTL expiry.
 */
export const LINK_CARD_CACHE_VERSION = 2;

/** Fresh TTL for a successful card — OGP metadata rarely changes. */
const SUCCESS_TTL_SEC = 60 * 60; // 1h

export interface LinkCardRendererDeps {
  /**
   * Live per-dispatch read of the `security:linkCardEnabled` admin
   * Security toggle (spec §6.2) — NEVER boot-captured. Read once per
   * dispatch (both by `shouldBypassCache` below, ahead of any cache
   * access, and by `render()` itself) so a toggle flip takes effect on
   * the very next dispatch (save / on-the-fly render), not just after a
   * restart.
   */
  isLinkCardEnabled: () => boolean;
}

/**
 * Build the `card` `EmbedRenderer`. `deps` defaults to "always
 * enabled" so existing call sites/tests that don't care about the
 * toggle (e.g. isolated `render()` unit tests) don't need to thread it.
 */
export function createLinkCardRenderer(deps: LinkCardRendererDeps = { isLinkCardEnabled: () => true }): EmbedRenderer {
  return {
    cacheVersion: LINK_CARD_CACHE_VERSION,
    reservation: { variant: 'card', size: 'medium' },
    // Toggle off — bypass `CacheStorage` entirely for this dispatch (no
    // `get`, no `set`; spec §6.2's literal "zero ... cache access"
    // contract, not just zero DNS/HTTP). Checking the toggle only
    // inside `render()` below is not enough on its own: a cache HIT
    // from before the toggle flipped would short-circuit `render()`
    // and keep serving the pre-toggle OGP card, and writing the
    // fallback card to the cache would keep serving IT for up to its
    // TTL after a later re-enable. `shouldBypassCache` (checked by the
    // generic dispatcher in `../embed-tags.ts` before it ever calls
    // `cachedRender`) closes both gaps.
    shouldBypassCache: () => !deps.isLinkCardEnabled(),
    async render(input): Promise<RenderResult> {
      if (!deps.isLinkCardEnabled()) {
        // Toggle off — never call fetchOg: zero DNS lookup, zero HTTP
        // fetch for this dispatch (spec §6.2's zero-egress contract).
        // Reachable directly (isolated `render()` unit tests) and via
        // the dispatcher's `shouldBypassCache`-gated direct call above.
        //
        // RFC-0023 — the sidecar is the same `{url}`-only shape the
        // fetch-failure path emits below: toggle-off and fetch-failure
        // stay indistinguishable on the structured side too.
        return { html: renderFallbackCard(input.url), structured: structuredFallbackCard(input.url) };
      }
      const result = await fetchOg(input.url);
      return toRenderResult(input.url, result);
    },
  };
}

function toRenderResult(url: string, result: FetchOgResult): RenderResult {
  switch (result.kind) {
    case 'ok':
      return { html: renderCard(url, result.meta), structured: structuredCard(url, result.meta), ttlSec: SUCCESS_TTL_SEC };
    case 'error':
      // Every OGP-fetch failure path renders the SAME unified fallback
      // card the toggle-off short-circuit above does (spec §6.1/§6.2) —
      // byte-identical output for the same url. The paired `structured`
      // rides with `errorHtml` (RFC-0023): `resolveDisplay` /
      // `structuredForNormalized` surface it whenever the fallback-card
      // html is displayed, so "fetch failed" and "toggle off" are also
      // sidecar-identical (`{url}` only — no `kind: disabled` exists).
      return { html: '', errorHtml: renderFallbackCard(url), structured: structuredFallbackCard(url), error: toRenderError(result) };
    default: {
      // Exhaustiveness guard — a new `FetchOgResult` kind must be handled above.
      const _unreachable: never = result;
      return _unreachable;
    }
  }
}

/** `url`'s hostname for the sidecar `domain` field (mirrors `render-card.ts`'s own defensive fallback). */
function extractCardDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const truncate = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

/**
 * RFC-0023 §10 — the success card's `crowiLinkCard` sidecar. Field caps
 * mirror `CrowiLinkCardSidecarSchema` (over-long OGP strings truncate
 * at the producer rather than invalidating the whole sidecar); the OGP
 * image stays an external URL, dropped when non-http(s) — the same
 * `safeImageSrc` degrade the html side applies.
 */
function structuredCard(url: string, meta: OgMeta = {}): StructuredRenderPayload {
  const image = meta.image !== undefined && isHttpUrl(meta.image) ? { url: meta.image } : undefined;
  return {
    node: {
      type: 'crowiLinkCard',
      url,
      ...(meta.title ? { title: truncate(meta.title, 512) } : {}),
      ...(meta.description ? { description: truncate(meta.description, 2048) } : {}),
      ...(image !== undefined ? { image } : {}),
      ...(meta.siteName ? { siteName: truncate(meta.siteName, 256) } : {}),
      domain: truncate(extractCardDomain(url), 256),
    },
  };
}

/** The unified fallback sidecar — `url` only, shared verbatim by toggle-off and every fetch failure. */
function structuredFallbackCard(url: string): StructuredRenderPayload {
  return { node: { type: 'crowiLinkCard', url } };
}

/**
 * Map a `fetch-og.ts` failure onto the core's `RenderError.code` table
 * (spec §"link-card の正規経路移行"):
 *
 *   - `blocked` / `bad-scheme` / `unsupported-content-type` → `blocked`
 *     (policy-level permanent rejection, persistent 1h TTL).
 *   - `http-error` 429 with a parsed `Retry-After` → `rate_limit` +
 *     `retryAfterSec` (honours the server's own cadence instead of the
 *     core's 5min default).
 *   - `http-error` 4xx (incl. a 429 with no `Retry-After`) → `not_found`
 *     (persistent 1h).
 *   - `http-error` anything else — 3xx (redirect-exhausted), 5xx, or no
 *     `httpStatus` at all (the unreachable-in-practice loop-exhaustion
 *     fallback) → `network` (transient 5min).
 *   - `timeout` → `timeout`, `network` → `network`, `busy` → `busy`
 *     (as-is, all transient — `busy` is the shared OGP-fetch
 *     wait-queue's cap/timeout rejection, spec
 *     feature-link-card-fetch-queue-bound, never a property of the
 *     target url).
 *   - `too-large` / `unknown` → `unknown` (transient).
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
  if (code === 'timeout' || code === 'network' || code === 'busy') return { code, message };
  // 'too-large' | 'unknown'
  return { code: 'unknown', message };
}
