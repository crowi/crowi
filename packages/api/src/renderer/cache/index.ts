import { createHash } from 'node:crypto';
import type {
  CacheEntry,
  CacheKey,
  CacheStorage,
  EmbedInput,
  EmbedRenderer,
  RenderContext,
  RenderError,
  RenderResult,
  ScopedCacheStorage,
} from '@crowi/plugin-api';
import { acquireRenderSlot, type RenderPriority } from '../core/render-admission';
import { MongoCacheStorage } from './mongodb-cache';
import { errorPlaceholder, sizeLimitPlaceholder } from './reservation';

export type { CacheSetReject } from './mongodb-cache';
export { createMongoCacheStorage, MongoCacheStorage } from './mongodb-cache';
export { dispatchLimitPlaceholder, errorPlaceholder, renderReservation, sizeLimitPlaceholder } from './reservation';

/**
 * Default fresh-TTL when `RenderResult.ttlSec` is unset. RFC §"Stale-
 * while-revalidate".
 */
export const DEFAULT_FRESH_TTL_SEC = 5 * 60; // 5min
/**
 * Default `staleAfterSec` multiplier — entries stay revalidate-in-
 * background until `ttlSec * 4`, after which a read blocks on the
 * re-render.
 */
export const DEFAULT_STALE_MULTIPLIER = 4;

/**
 * Per-code TTLs for cached error responses (RFC §"Error caching").
 * `rate_limit` is overridable per-call via `RenderError.retryAfterSec`.
 * `blocked` (a policy-level permanent rejection — SSRF block,
 * disallowed scheme, disallowed content-type) shares `not_found`'s 1h
 * persistent-failure TTL.
 */
export const RENDER_ERROR_TTL: Readonly<Record<RenderError['code'], number>> = {
  auth: 60,
  rate_limit: 5 * 60,
  not_found: 60 * 60,
  network: 5 * 60,
  timeout: 5 * 60,
  unknown: 5 * 60,
  blocked: 60 * 60,
};

/**
 * How long a stale-if-error entry is allowed to keep showing its
 * last-good `html` while revalidation keeps failing. Once the last-good
 * render is older than this, `renderAndStore` degrades to
 * `errorHtml ?? errorPlaceholder(...)` instead — a dead URL/upstream
 * doesn't keep showing an ancient card/diagram forever.
 */
export const STALE_IF_ERROR_MAX_AGE_SEC = 24 * 60 * 60; // 24h

/**
 * Error codes whose failures may keep displaying the last-good `html`
 * (stale-if-error). Deliberately an allowlist of transient/availability
 * failures: a policy-level rejection (`blocked` — e.g. a host newly
 * added to the SSRF blocklist) or an authorization failure (`auth` —
 * token revoked, content made private) must take effect on the NEXT
 * revalidation, not `STALE_IF_ERROR_MAX_AGE_SEC` later — retaining
 * content past a permanent policy rejection would contradict what those
 * codes mean. `not_found` retains: the 24h grace is exactly the
 * "dead URL shouldn't flip the page instantly" case described above.
 */
export const STALE_IF_ERROR_RETAINABLE_CODES: ReadonlySet<RenderError['code']> = new Set(['network', 'timeout', 'rate_limit', 'not_found', 'unknown']);

/**
 * Upper bound for any plugin/upstream-supplied TTL (`RenderResult.ttlSec`,
 * `RenderError.retryAfterSec`). Plugin values are untrusted at this
 * boundary — operator-installed third-party plugins, or an upstream's
 * attacker-controlled `Retry-After` header, could otherwise produce an
 * `Invalid Date` `expiresAt` (failing the cache write and losing the
 * fallback rendering) or an effectively-permanent entry.
 */
export const MAX_TTL_SEC = 24 * 60 * 60; // 24h

/**
 * Compute the cache embed-key for an input. Default
 * `sha256(JSON.stringify(input))` keeps callers honest about input
 * stability; plugins can override via `EmbedRenderer.computeEmbedKey`
 * to canonicalise query strings, ignore tracking params, etc.
 */
export function defaultEmbedKey(input: EmbedInput): string {
  const json = JSON.stringify({ tag: input.tag, url: input.url });
  return createHash('sha256').update(json).digest('hex');
}

/** Shared by `cachedRender` / `cachedRenderOrPending` — the `CacheKey` for a single render call. */
function buildCacheKey(pluginName: string, renderer: EmbedRenderer, input: EmbedInput): CacheKey {
  const embedKey = renderer.computeEmbedKey ? renderer.computeEmbedKey(input) : defaultEmbedKey(input);
  return {
    pluginName,
    pluginCacheVersion: renderer.cacheVersion,
    pageId: input.pageId,
    embedKey,
  };
}

/** Shared by `cachedRender` / `cachedRenderOrPending` — fresh / stale-within-window classification for a cache hit. */
function classifyFreshness(cached: CacheEntry, now: number): { isFresh: boolean; isWithinStaleWindow: boolean } {
  const expiresMs = cached.expiresAt.getTime();
  const ttlMs = expiresMs - cached.fetchedAt.getTime();
  const staleWindowMs = ttlMs * DEFAULT_STALE_MULTIPLIER;
  const isFresh = now < expiresMs;
  const isWithinStaleWindow = !isFresh && now < expiresMs + staleWindowMs;
  return { isFresh, isWithinStaleWindow };
}

/**
 * Wrap a `CacheStorage` in a per-plugin view that auto-stamps
 * `pluginName` on every key. Plugins receive this on
 * `RenderContext.cache` and never see other plugins' entries.
 */
export function scopeForPlugin(storage: CacheStorage, pluginName: string): ScopedCacheStorage {
  return {
    async get(key) {
      return storage.get({ ...key, pluginName });
    },
    async set(key, entry) {
      await storage.set({ ...key, pluginName }, entry);
    },
    async invalidatePage(pageId) {
      // Pull only this plugin's entries on this page. The underlying
      // storage's `invalidatePlugin` would nuke other pages too, so we
      // intentionally do not expose it through the scoped view.
      return storage.invalidatePage(pageId);
    },
  };
}

/** What `cachedRender` may return — html plus a freshness hint for SSR layers. */
export interface CachedRenderResult {
  html: string;
  /** 'fresh' | 'stale' so a caller can emit `data-stale="true"` if desired. */
  freshness: 'fresh' | 'stale';
  /** The full `RenderResult` (errors included) for downstream telemetry. */
  result: RenderResult;
}

// Process-wide in-flight tracker — collapses concurrent renders for the
// same cache key into a single upstream call. Without this, K viewers
// of a page entering the stale window each kick off a background
// `renderAndStore`, multiplying load against the plugin's upstream
// (`addEmbedTag` is typically a GitHub / Slack / KaTeX / Mermaid call).
const inFlightRender = new Map<string, Promise<RenderAndStoreResult>>();

function cacheKeyString(key: CacheKey): string {
  return `${key.pluginName}${key.pluginCacheVersion}${key.pageId}${key.embedKey}`;
}

/**
 * Stale-while-revalidate wrapper for a single embed render. Resolves
 * the four cases:
 *
 *   - **miss**: render now, cache, return fresh.
 *   - **hit + fresh** (`now < expiresAt`): return cached, no re-render.
 *   - **hit + stale-within-window** (`expiresAt < now < expiresAt + (stale*ttl)`):
 *     return cached, fire background re-render.
 *   - **hit + expired**: block on re-render, cache, return.
 *
 * Errors from `render()` (both thrown and `RenderResult.error`) cache
 * with `RENDER_ERROR_TTL[code]` and surface `RenderResult.errorHtml` when
 * the plugin set one, else the generic `errorPlaceholder()`. When a
 * still-fresh-enough successful render preceded the error (stale-if-
 * error — see `resolveDisplay` / `STALE_IF_ERROR_MAX_AGE_SEC`), the
 * previous success's `html` is kept on screen instead and the error is
 * only recorded for telemetry/retry-cadence purposes.
 *
 * NOTE: this is the **internal** wrapper used by Phase 4 core plugins
 * (`embed-tags.ts`, `url-inline-expand.ts`) and the Phase 6 code-block
 * dispatch (`code-block-dispatch.ts`). Plugins do not call it directly;
 * they call `EmbedRenderer.render()` / `CodeBlockRenderer.render()` and
 * the core wraps.
 */
export async function cachedRender(
  storage: MongoCacheStorage,
  pluginName: string,
  renderer: EmbedRenderer,
  input: EmbedInput,
  ctx: RenderContext,
): Promise<CachedRenderResult> {
  const key = buildCacheKey(pluginName, renderer, input);

  const cached = await storage.get(key);
  const now = Date.now();
  if (cached) {
    const { isFresh, isWithinStaleWindow } = classifyFreshness(cached, now);

    if (isFresh) {
      return { html: cached.html, freshness: 'fresh', result: cached.result };
    }
    if (isWithinStaleWindow) {
      // Skip the background fire if a re-render is already in flight
      // for this cache key — otherwise K concurrent viewers each kick
      // off a parallel `render()` and amplify upstream load by K.
      const ks = cacheKeyString(key);
      if (!inFlightRender.has(ks)) {
        // `setImmediate` rather than `Promise.resolve().then` so it
        // lands at the start of the next event loop tick (lower priority
        // than the in-flight request).
        setImmediate(() => {
          void dedupedRenderAndStore(ks, storage, key, renderer, input, ctx, cached).catch((err) => {
            ctx.log.warn(`[plugin-render-cache] background re-render failed for plugin=${pluginName} pageId=${input.pageId}: ${stringifyError(err)}`);
          });
        });
      }
      return { html: cached.html, freshness: 'stale', result: cached.result };
    }
    // expired beyond stale window — block on re-render.
  }

  // miss or expired: render now (de-duped against any concurrent miss
  // for the same key — second viewer awaits the first viewer's render).
  const ks = cacheKeyString(key);
  const result = await dedupedRenderAndStore(ks, storage, key, renderer, input, ctx, cached);
  return { html: result.html, freshness: 'fresh', result: result.result };
}

function dedupedRenderAndStore(
  ks: string,
  storage: MongoCacheStorage,
  key: CacheKey,
  renderer: EmbedRenderer,
  input: EmbedInput,
  ctx: RenderContext,
  prevEntry: CacheEntry | null,
): Promise<RenderAndStoreResult> {
  const existing = inFlightRender.get(ks);
  if (existing) return existing;
  const p = renderAndStore(storage, key, renderer, input, ctx, prevEntry).finally(() => {
    inFlightRender.delete(ks);
  });
  inFlightRender.set(ks, p);
  return p;
}

interface RenderAndStoreResult {
  html: string;
  result: RenderResult;
}

async function renderAndStore(
  storage: MongoCacheStorage,
  key: CacheKey,
  renderer: EmbedRenderer,
  input: EmbedInput,
  ctx: RenderContext,
  prevEntry: CacheEntry | null,
): Promise<RenderAndStoreResult> {
  const { result } = await normalizeRenderResult(() => renderer.render(input, ctx), renderer.reservation);
  return persistRenderResult(storage, key, renderer, result, prevEntry);
}

/**
 * Shared exception/error → user-facing-html normalisation. Used by both
 * the persisted save path (`renderAndStore` above, via
 * `resolveResultHtml`/`persistRenderResult`) and the non-persistent
 * editor live-preview path (`renderCodeBlockForPreview`,
 * `../core/code-block-dispatch.ts`, feature-plugin-renderer-mermaid spec
 * §7 item 5) — a thrown `render()` and a returned `RenderResult.error`
 * must resolve to BYTE-IDENTICAL placeholder html on both paths, so this
 * is the one place that logic lives rather than being duplicated per
 * caller. A thrown `render()` is treated as an `unknown` infra failure
 * (matching `renderAndStore`'s historical behaviour); never touches
 * `CacheStorage` — callers that persist (`renderAndStore`) layer TTL /
 * cache-write concerns on top via `persistRenderResult`.
 */
export async function normalizeRenderResult(
  render: () => RenderResult | Promise<RenderResult>,
  reservation: EmbedRenderer['reservation'],
): Promise<{ html: string; result: RenderResult }> {
  let result: RenderResult;
  try {
    result = await render();
  } catch (err) {
    result = {
      html: '',
      error: {
        code: 'unknown',
        message: stringifyError(err),
      },
    };
  }
  return { html: resolveResultHtml(result, reservation), result };
}

/** Pure/sync core of `normalizeRenderResult` — the plugin's `html` on success, or `errorPlaceholder(code, reservation)` on error. Also reused by `persistRenderResult` (admission-gated results never flow through `normalizeRenderResult` itself, only through this). */
function resolveResultHtml(result: RenderResult, reservation: EmbedRenderer['reservation']): string {
  return result.error ? errorPlaceholder(result.error.code, reservation) : result.html;
}

/**
 * Shared tail of `renderAndStore` / `cachedRenderOrPending`'s admission-
 * gated render path: TTL computation, display resolution (`resolveDisplay`
 * — error → errorHtml/placeholder, or stale-if-error retention of
 * `prevEntry`'s last good html), and the size-limit-reject fallback.
 * Split out so `cachedRenderOrPending` (below) persists a
 * `renderer.render()` result exactly the same way `cachedRender` always
 * has, without duplicating the logic.
 */
async function persistRenderResult(
  storage: MongoCacheStorage,
  key: CacheKey,
  renderer: EmbedRenderer,
  result: RenderResult,
  prevEntry: CacheEntry | null,
): Promise<RenderAndStoreResult> {
  const now = new Date();
  const ttlSec = pickTtl(result);
  const expiresAt = new Date(now.getTime() + ttlSec * 1000);

  const { html, lastGoodFetchedAt } = resolveDisplay(result, renderer, prevEntry, now);
  const cachedHtml: string = html;

  // `errorHtml` is display plumbing, not telemetry — when the entry is a
  // degraded error, `entry.html` already IS the errorHtml, and a later
  // degrade uses the fresh attempt's `errorHtml`, never this stored copy.
  // Persisting it would just re-ship a few hundred dead bytes per read.
  const { errorHtml: _displayOnly, ...resultMeta } = result;
  const cacheEntry: CacheEntry = {
    html: cachedHtml,
    result: { ...resultMeta, html: cachedHtml },
    fetchedAt: now,
    expiresAt,
    lastGoodFetchedAt,
  };

  const rejection = await storage.setOrReject(key, cacheEntry);
  if (rejection) {
    // Size-limit reject → fall back to a placeholder for THIS render
    // call. We don't write the placeholder to the cache (it would
    // pollute the slot if the plugin shrinks its output later); the
    // next read just sees a miss and re-renders.
    return {
      html: sizeLimitPlaceholder(rejection, renderer.reservation),
      result: cacheEntry.result,
    };
  }

  return { html: cachedHtml, result: cacheEntry.result };
}

/** What `cachedRenderOrPending` returns — a rendered/cached result, or `pending` (nothing written to the cache). */
export type CachedRenderOrPendingResult = { kind: 'rendered'; html: string; freshness: 'fresh' | 'stale'; result: RenderResult } | { kind: 'pending' };

// Separate from `inFlightRender` (above) even though both key by the
// same `cacheKeyString` shape — a `pluginName` only ever goes through
// ONE of `cachedRender` / `cachedRenderOrPending` (registration-time
// `admissionControl` presence decides which, see `code-block-dispatch.ts`),
// so there is no real overlap; keeping the maps separate just keeps the
// stored promise's resolved type (`RenderAndStoreResult` vs. `| null`)
// distinct without a union.
const inFlightAdmissionRender = new Map<string, Promise<RenderAndStoreResult | null>>();

/**
 * Admission-control-aware sibling of `cachedRender` (spec §5 / §6).
 * Identical fresh / stale-serve-then-background-refresh / miss branching,
 * but the actual `renderer.render()` call (foreground miss AND the SWR
 * background refresh) is wrapped with `acquireRenderSlot` when
 * `renderer.admissionControl` is declared. Admission rejection (queue
 * overflow, aborted while queued) and a thrown `renderer.render()` both
 * resolve to `{ kind: 'pending' }` — nothing is written to `storage`, so
 * a later, successful retry is never shadowed by a stale cached failure.
 *
 * `cachedRender` itself is untouched — this is a sibling, not a
 * replacement, and only plugins that declare `admissionControl` (today,
 * only Mermaid) are ever routed here (`code-block-dispatch.ts`).
 */
export async function cachedRenderOrPending(
  storage: MongoCacheStorage,
  pluginName: string,
  renderer: EmbedRenderer,
  input: EmbedInput,
  ctx: RenderContext,
  admission: { priority: RenderPriority },
): Promise<CachedRenderOrPendingResult> {
  if (!renderer.admissionControl) {
    // No admission declared for this registration — behave exactly like
    // `cachedRender` (fresh/stale/miss branching, no admission gate).
    const rendered = await cachedRender(storage, pluginName, renderer, input, ctx);
    return { kind: 'rendered', ...rendered };
  }

  const key = buildCacheKey(pluginName, renderer, input);

  const cached = await storage.get(key);
  const now = Date.now();
  if (cached) {
    const { isFresh, isWithinStaleWindow } = classifyFreshness(cached, now);

    if (isFresh) {
      return { kind: 'rendered', html: cached.html, freshness: 'fresh', result: cached.result };
    }
    if (isWithinStaleWindow) {
      // Cache-hit path (fresh or stale-serve) never touches admission —
      // only the background refresh kicked off below acquires a slot,
      // matching spec §6's "admission gates renderer.render(), not the
      // cache read" invariant.
      const ks = cacheKeyString(key);
      if (!inFlightAdmissionRender.has(ks)) {
        setImmediate(() => {
          void dedupedRenderOrSkip(ks, storage, key, renderer, input, ctx, admission, cached).catch((err) => {
            ctx.log.warn(
              `[plugin-render-cache] background re-render (admission) failed for plugin=${pluginName} pageId=${input.pageId}: ${stringifyError(err)}`,
            );
          });
        });
      }
      return { kind: 'rendered', html: cached.html, freshness: 'stale', result: cached.result };
    }
    // expired beyond stale window — fall through to a blocking attempt.
  }

  const ks = cacheKeyString(key);
  const outcome = await dedupedRenderOrSkip(ks, storage, key, renderer, input, ctx, admission, cached);
  if (outcome === null) return { kind: 'pending' };
  return { kind: 'rendered', html: outcome.html, freshness: 'fresh', result: outcome.result };
}

function dedupedRenderOrSkip(
  ks: string,
  storage: MongoCacheStorage,
  key: CacheKey,
  renderer: EmbedRenderer,
  input: EmbedInput,
  ctx: RenderContext,
  admission: { priority: RenderPriority },
  prevEntry: CacheEntry | null,
): Promise<RenderAndStoreResult | null> {
  const existing = inFlightAdmissionRender.get(ks);
  if (existing) return existing;
  const p = renderUnderAdmissionAndStore(storage, key, renderer, input, ctx, admission, prevEntry).finally(() => {
    inFlightAdmissionRender.delete(ks);
  });
  inFlightAdmissionRender.set(ks, p);
  return p;
}

/**
 * Acquire an admission slot, call `renderer.render()`, release the slot,
 * and persist on success — `null` on any admission rejection or a
 * thrown `render()` (spec §5 classification B: caller treats `null` as
 * `{ kind: 'pending' }` and writes nothing to the cache).
 */
async function renderUnderAdmissionAndStore(
  storage: MongoCacheStorage,
  key: CacheKey,
  renderer: EmbedRenderer,
  input: EmbedInput,
  ctx: RenderContext,
  admission: { priority: RenderPriority },
  prevEntry: CacheEntry | null,
): Promise<RenderAndStoreResult | null> {
  const admissionControl = renderer.admissionControl;
  // Unreachable via the two call sites above (both already checked
  // `renderer.admissionControl` is set) — kept as a defensive fallback
  // rather than a non-null assertion.
  if (!admissionControl) return renderAndStore(storage, key, renderer, input, ctx, prevEntry);

  let ticket: { release(): void };
  try {
    ticket = await acquireRenderSlot({
      pluginName: key.pluginName,
      actor: ctx.actor,
      priority: admission.priority,
      signal: ctx.signal,
      admissionControl,
    });
  } catch {
    // Queue overflow, or the signal aborted while queued.
    return null;
  }

  let result: RenderResult;
  try {
    result = await renderer.render(input, ctx);
  } catch {
    // A thrown `render()` under admission is, by contract (spec §5),
    // always an infra failure (child-process timeout/crash) — Mermaid's
    // own `index.ts` never lets a classification-A (notation error /
    // §3 reject / sanitizer reject / size limit) failure escape as an
    // exception. Treat it as pending, same as an admission rejection.
    return null;
  } finally {
    ticket.release();
  }

  return persistRenderResult(storage, key, renderer, result, prevEntry);
}

/**
 * Pick what `html` (and, on success, the new `lastGoodFetchedAt`) a
 * render attempt should be stored/displayed with.
 *
 *   - success: display the plugin's `html`; `lastGoodFetchedAt` = `now`
 *     (this render IS the new last-good).
 *   - error, with a still-fresh-enough last-good available (see
 *     `resolvePrevGood`): keep showing that last-good `html` — a
 *     transient upstream failure must not immediately downgrade a
 *     working card/diagram to an error placeholder. `lastGoodFetchedAt`
 *     carries the ORIGINAL success's value forward unchanged, so the
 *     `STALE_IF_ERROR_MAX_AGE_SEC` clock keeps counting from the real
 *     last success, not from this (failed) attempt.
 *   - error, with no usable last-good (first-ever failure, or the kept
 *     last-good aged past `STALE_IF_ERROR_MAX_AGE_SEC`): degrade to
 *     `errorHtml ?? errorPlaceholder(...)`, same as before this policy
 *     existed. `lastGoodFetchedAt` is left unset.
 */
function resolveDisplay(
  result: RenderResult,
  renderer: EmbedRenderer,
  prevEntry: CacheEntry | null,
  now: Date,
): { html: string; lastGoodFetchedAt: Date | undefined } {
  if (!result.error) {
    // `lastGoodFetchedAt` is deliberately NOT written on success entries —
    // it would always equal `fetchedAt`. Field present ⇔ stale-if-error
    // retained entry, one crisp invariant (readers fall back to
    // `fetchedAt` for success entries, see `resolvePrevGood`).
    return { html: result.html, lastGoodFetchedAt: undefined };
  }
  // Only transient/availability failures may keep the last-good display —
  // a policy-level rejection (`blocked`/`auth`) must take effect NOW, not
  // 24h later (see `STALE_IF_ERROR_RETAINABLE_CODES`).
  const prevGood = STALE_IF_ERROR_RETAINABLE_CODES.has(result.error.code) ? resolvePrevGood(prevEntry, now) : null;
  if (prevGood) {
    return { html: prevGood.html, lastGoodFetchedAt: prevGood.lastGoodFetchedAt };
  }
  return { html: result.errorHtml ?? errorPlaceholder(result.error.code, renderer.reservation), lastGoodFetchedAt: undefined };
}

/**
 * Resolve the last-good `{ html, lastGoodFetchedAt }` a failed render
 * attempt may keep displaying, or `null` when there is none to keep
 * (no previous entry, previous entry was itself a fully-degraded error,
 * or the last-good is older than `STALE_IF_ERROR_MAX_AGE_SEC`).
 *
 * `prevEntry.result.error` truthy but `prevEntry.lastGoodFetchedAt` set
 * means `prevEntry` is ITSELF a stale-if-error entry mid-retry-cadence —
 * its `lastGoodFetchedAt` is the ORIGINAL success's timestamp (carried
 * forward, see `resolveDisplay`), so chaining through it here is what
 * lets the kept display survive multiple consecutive failed retries
 * instead of degrading on the second failure.
 */
function resolvePrevGood(prevEntry: CacheEntry | null, now: Date): { html: string; lastGoodFetchedAt: Date } | null {
  if (!prevEntry) return null;
  // Success entries never carry `lastGoodFetchedAt` (their `fetchedAt` IS
  // the last-good time — this also covers, value-identically, any entry
  // written while the field was still being set on success). Error entries
  // carry it iff they retained a last-good display.
  const lastGoodFetchedAt = prevEntry.result.error ? prevEntry.lastGoodFetchedAt : prevEntry.fetchedAt;
  if (!lastGoodFetchedAt) return null;
  const ageSec = (now.getTime() - lastGoodFetchedAt.getTime()) / 1000;
  if (ageSec > STALE_IF_ERROR_MAX_AGE_SEC) return null;
  return { html: prevEntry.html, lastGoodFetchedAt };
}

/**
 * Resolve the effective fresh-TTL for a render result. Error responses
 * use the per-code default table (with `retryAfterSec` override for
 * rate-limit); successful responses honour `RenderResult.ttlSec` or
 * fall back to `DEFAULT_FRESH_TTL_SEC`.
 */
function pickTtl(result: RenderResult): number {
  if (result.error) {
    if (result.error.code === 'rate_limit' && typeof result.error.retryAfterSec === 'number') {
      return clampTtl(result.error.retryAfterSec, RENDER_ERROR_TTL.rate_limit);
    }
    return RENDER_ERROR_TTL[result.error.code];
  }
  return clampTtl(result.ttlSec ?? DEFAULT_FRESH_TTL_SEC, DEFAULT_FRESH_TTL_SEC);
}

/**
 * Clamp an untrusted plugin/upstream-supplied TTL into `[1, MAX_TTL_SEC]`
 * at the core boundary — this is the chokepoint where `expiresAt` gets
 * built, so the "valid, bounded Date" invariant is enforced here for
 * every plugin rather than re-implemented per plugin. Non-finite input
 * (NaN from a plugin bug) falls back to `fallbackSec`.
 */
function clampTtl(ttlSec: number, fallbackSec: number): number {
  if (!Number.isFinite(ttlSec)) return fallbackSec;
  return Math.min(Math.max(1, ttlSec), MAX_TTL_SEC);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
