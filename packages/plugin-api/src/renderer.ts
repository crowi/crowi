import type { z } from 'zod/v3';
import type { PluginLogger } from './context';

/**
 * Renderer extension contract — type-only. Plugins contribute parse /
 * transform behaviour to the server-side markdown pipeline through
 * `registerRenderer(scope, ctx)`. The runtime owns the unified.js
 * pipeline; plugins push unified plugins, node renderers, code-block
 * renderers, embed renderers, and URL inline-expansion rules into the
 * passed `RendererRegistry`.
 *
 * Phase 4 of RFC-0002 implements the I/O surface for plugins:
 *   - `CacheStorage` (MongoDB-backed) with stale-while-revalidate
 *     and error-cache TTLs.
 *   - `Reservation` API: plugins declare the shape of their placeholder
 *     so the core renders a stable layout while the embed loads.
 *   - `AuthContext`: shape confirmed here; Phase 7 wires the encrypted-
 *     config lookup. **Phase 6 no-I/O plugins (PlantUML / KaTeX /
 *     Mermaid / emoji) must NOT touch `AuthContext`** — the registry
 *     impl will throw at the call site until Phase 7 lands.
 *   - `addEmbedTag` / `addUrlInlineExpander`: registered renderers are
 *     dispatched against the `@[tag](url)` mdast parser and the URL
 *     inline-expansion walker respectively.
 *
 * Phase 2 covered `addUnifiedPlugin` + `addNodeRenderer`; Phase 3 added
 * SSR HTML generation + bundled shiki. Phase 4 promotes the warn-noop
 * `addEmbedTag` / `addUrlInlineExpander` to live registrations.
 */

/**
 * Identifier for the unified pipeline phase a plugin wants to attach a
 * `unified` transformer to. Phase 2 only honours `'transform'`; `'pre'`
 * is reserved for Phase 3 (parse-time tweaks before remark-gfm) and
 * `'post'` for the future hydrate phase.
 */
export type RenderPhase = 'pre' | 'transform' | 'post';

/**
 * mdast node type → custom AST visitor. Plugins use this when they want
 * to mutate a specific node type (e.g. rewrite `code` blocks, swap
 * `link` targets) without writing a full unified transformer. The
 * runtime invokes the renderer once per matching node, depth-first.
 *
 * The `node` parameter is intentionally typed loosely (`unknown`) at
 * this contract layer; plugins narrow at the call site against the
 * mdast type they registered for.
 */
export interface NodeRenderer {
  (node: unknown, ctx: RenderContext): void | Promise<void>;
}

/**
 * Code-block renderer — invoked for fenced code blocks whose `lang`
 * matches the registered language tag (e.g. `mermaid`, `plantuml`,
 * `katex`). Phase 6 lights this up.
 *
 * Shape mirrors `EmbedRenderer`: a required `cacheVersion` so the core
 * can route renders through the same SWR + error-cache wrapper, an
 * optional `reservation` for layout-stable placeholders, and an
 * optional `computeEmbedKey` override (the default hashes
 * `{lang, source}`).
 *
 * Phase 4 declared a bare callable; Phase 6 expands the shape to an
 * object so plugins can declare cacheVersion / reservation alongside
 * `render`. This is non-breaking because the Phase 4 stub discarded all
 * registrations — there is no production implementer to migrate.
 */
export interface CodeBlockRenderer {
  /**
   * Bumped by the plugin whenever the rendered HTML shape changes.
   * Read-side cache hits ignore entries with a stale version, so
   * version bumps are an instant "invalidate all my cached output"
   * without operator action.
   */
  cacheVersion: number;
  /**
   * Optional placeholder declaration. Used in the same two cases as
   * `EmbedRenderer.reservation`: layout placeholder while rendering,
   * and fall-back when cache rejects on size limit or `render` errors.
   */
  reservation?: Reservation;
  /**
   * Optional custom cache-key computer. Default = sha256(JSON.stringify({
   * lang, source})). Plugins can override to canonicalise whitespace,
   * strip comments, etc.
   */
  computeEmbedKey?(info: CodeBlockInfo): string;
  /**
   * Opt into a CPU-bounded admission control pool (`render-admission.ts`,
   * `packages/api/src/renderer/core/render-admission.ts`). When present,
   * `cachedRenderOrPending` (`packages/api/src/renderer/cache/index.ts`)
   * and `renderCodeBlockForPreview` acquire a ticket from the named pool
   * (keyed per `pluginName`) immediately around the `render()` call and
   * release it on completion; when absent (the default — PlantUML /
   * KaTeX / emoji and existing embed/URL-expansion plugins), `render()`
   * is called directly with no admission gate, matching today's
   * behaviour. See spec §6 for the full design (global / per-user
   * concurrency caps + priority queue).
   */
  admissionControl?: AdmissionControlConfig;
  /**
   * Opt into server-rendering during editor live preview
   * (`POST /pages/preview`, which runs with no `pageId`). Default
   * `'source'` (omitted) leaves the fenced block untouched in preview —
   * today's behaviour for every existing `CodeBlockRenderer`. Plugins
   * that declare `'server-render'` MUST be no-I/O and deterministic:
   * `makePreviewCodeBlockDispatch` calls them outside the persisted-
   * cache path (`packages/api/src/renderer/core/code-block-dispatch.ts`).
   */
  previewPolicy?: 'source' | 'server-render';
  /** Render a single code block. */
  render(info: CodeBlockInfo, ctx: RenderContext): EmbedFragment | RenderResult | Promise<EmbedFragment | RenderResult>;
}

/**
 * Per-`pluginName` admission-control pool declaration (§6). Shared by
 * `CodeBlockRenderer` and `EmbedRenderer` — `EmbedRenderer` carries it so
 * `code-block-dispatch.ts`'s `codeBlockAsEmbedRenderer` adaptor can copy
 * `CodeBlockRenderer.admissionControl` straight through to the
 * `EmbedRenderer` shape `cachedRenderOrPending` actually consumes.
 */
export interface AdmissionControlConfig {
  /** Process-wide concurrent `render()` calls in flight for this plugin. */
  maxConcurrentGlobal: number;
  /** Concurrent `render()` calls in flight for a single `actor` (kind:'user' only). */
  maxConcurrentPerUser: number;
  /** Max jobs allowed to wait for a slot before new requests are rejected outright. */
  queueDepth: number;
}

/**
 * Who is driving this render call. Threaded through `RenderContext` so
 * admission control (§6) can apply a per-user concurrency cap. Today
 * every real call site is authenticated (`createJwtAuth` has no
 * anonymous fallback), so `'user'` is the only variant actually
 * produced — `'anonymous'` / `'system'` are reserved for future
 * unauthenticated-read and offline-tooling call sites and must not be
 * synthesised speculatively.
 */
export type RenderActor = { kind: 'user'; userId: string } | { kind: 'anonymous' } | { kind: 'system' };

export interface CodeBlockInfo {
  /** The language tag from the fence (the `ts` in ```` ```ts ````). */
  lang: string;
  /** Raw fenced source (no surrounding backticks). */
  source: string;
}

/**
 * Embed-tag renderer — invoked for `@[tag](url)` embeds whose `tag`
 * matches a registered name. The plugin receives the parsed `EmbedInput`
 * and returns a `RenderResult` containing pre-sanitised HTML plus
 * optional cache + reservation metadata. Phase 4 dispatches via the
 * cache wrapper; the result is persisted into MongoDB
 * `PluginRenderCache` keyed by `(pluginName, pluginCacheVersion, pageId,
 * embedKey)`.
 *
 * The renderer is responsible for HTML sanitisation. The core does NOT
 * escape `RenderResult.html` and trusts the plugin's output.
 */
export interface EmbedRenderer {
  /**
   * Bumped by the plugin whenever the rendered HTML shape changes.
   * Read-side cache hits ignore entries with a stale version, so
   * version bumps are an instant "invalidate all my cached output"
   * without operator action.
   */
  cacheVersion: number;
  /**
   * Optional placeholder declaration. Used in two cases:
   *   1. While rendering for the first time (mode: 'edit' or cache
   *      stampede protection), the core renders this reservation so
   *      page layout doesn't shift when the real HTML lands.
   *   2. When `render()` rejects or the cached entry exceeds size
   *      limits, the core falls back to a reservation-shaped
   *      placeholder.
   */
  reservation?: Reservation;
  /**
   * Optional custom cache-key computer. Phase 4 defaults to
   * `sha256(JSON.stringify(input))` when omitted — that covers
   * arg-only inputs. Plugins can override to (a) ignore query-string
   * volatility (`?utm_*`) or (b) include external state (Accept-Language).
   */
  computeEmbedKey?(input: EmbedInput): string;
  /**
   * Opt into admission control (§6). See `CodeBlockRenderer.admissionControl`
   * for the full rationale — declared here too because `cachedRenderOrPending`
   * (`packages/api/src/renderer/cache/index.ts`) is written against the
   * `EmbedRenderer` shape (`code-block-dispatch.ts`'s
   * `codeBlockAsEmbedRenderer` adaptor copies a `CodeBlockRenderer`'s
   * declaration through unchanged). Native `EmbedRenderer` plugins
   * (embed-tags / URL-inline-expansion) can also opt in if a future one
   * turns out to be CPU-bound.
   */
  admissionControl?: AdmissionControlConfig;
  /**
   * Optional per-dispatch cache-bypass predicate
   * (feature-renderer-plugin-boundary Phase 3). Checked by the generic
   * embed-tag dispatcher (`packages/api/src/renderer/core/embed-tags.ts`)
   * BEFORE it touches `CacheStorage` at all for this dispatch — no
   * `get`, no `set`. When it returns `true`, the dispatcher calls
   * `render()` directly (via the same `normalizeRenderResult` error
   * normalisation the preview path uses) and never persists the
   * result.
   *
   * This exists because a renderer whose behaviour is gated by a
   * runtime policy toggle (e.g. link-card's admin
   * `security:linkCardEnabled` switch) cannot enforce a literal
   * zero-cache-access guarantee by checking the toggle only inside
   * `render()` — a cache HIT from before the toggle flipped would
   * short-circuit `render()` entirely and keep serving pre-toggle
   * output (and, symmetrically, writing a toggled-off result to the
   * cache would keep serving it for up to that entry's TTL after the
   * toggle flips back). Declaring the check here instead makes the
   * dispatcher skip the cache outright for that one call. Absent (the
   * default) or returning `false` goes through the normal cached path
   * unchanged.
   */
  shouldBypassCache?(input: EmbedInput): boolean;
  /** Render a single embed. */
  render(input: EmbedInput, ctx: RenderContext): RenderResult | Promise<RenderResult>;
  /**
   * Optional batched render for plugins that can amortise a single
   * upstream call across N inputs (Phase 7+ GitHub GraphQL).
   * Phase 4 registry impl calls `render` 1 input at a time; this
   * field is reserved for the Phase 7 batching path.
   */
  renderBatch?(inputs: EmbedInput[], ctx: RenderContext): Promise<RenderResult[]>;
}

/**
 * What an `EmbedRenderer` receives. Phase 4 plumbs `tag` + `url` from
 * `@[tag](url)`; plugins are free to pull additional state via
 * `RenderContext.auth.config<S>()` (Phase 7) or
 * `RenderContext.pageMetadata`.
 */
export interface EmbedInput {
  /** The bracketed tag — `[A-Za-z0-9_-]{1,64}`. */
  tag: string;
  /** The parenthesised URL. Free-form; plugins validate per-renderer. */
  url: string;
  /** Page id the embed is being rendered for; cache key includes this. */
  pageId: string;
}

/**
 * What an `EmbedRenderer` returns. Phase 4 caches the whole `RenderResult`
 * (html + error meta + ttl) so a subsequent read can short-circuit.
 * Stale-while-revalidate uses `ttlSec * DEFAULT_STALE_MULTIPLIER` as the
 * background-refresh window (see
 * `packages/api/src/renderer/cache/index.ts:cachedRender`).
 */
/**
 * RFC-0023 (design doc §12) — the structured (typed) counterpart of a
 * producer's `html` output. Additive and optional everywhere: a plugin
 * that never sets it keeps today's behaviour byte-for-byte.
 *
 * `node` is the producer-shaped typed node (`type` selects the sidecar
 * kind — `'crowiDiagram'` / `'crowiLinkCard'` / `'crowiPlaceholder'`).
 * Deliberately loose (`Record<string, unknown>`) at this SDK layer:
 * `@crowi/plugin-api` does not depend on `@crowi/api-contract`, so the
 * authoritative shape lives in the api-contract sidecar schemas and the
 * api-side dispatch mapper validates against them before stamping a
 * sidecar onto the persisted AST (invalid payloads degrade to a plain
 * `html` node, never poisoning what the web reads).
 */
export interface StructuredRenderPayload {
  node: Record<string, unknown>;
}

export interface RenderResult {
  /** Already-sanitised HTML the core will inline. Unchanged — the one and only web/legacy representation. */
  html: string;
  /**
   * RFC-0023 — optional structured payload paired with `html`. Both
   * must describe the SAME render outcome: the dispatch layer stamps
   * this (schema-validated) as a sidecar on the `html` node it splices,
   * and the `X-Crowi-Ast-Version: 1` projection turns it into a typed
   * node. On an `error` result, pair it with `errorHtml` when the
   * error display carries real content (e.g. link-card's fallback
   * card); leave it unset to get the generic structured placeholder.
   */
  structured?: StructuredRenderPayload;
  /**
   * Optional `<head>`-bound assets — Phase 4 records them on the
   * cache entry but the SSR layer does not yet inject them. Phase 7
   * will close that loop together with `hydrate` script wiring.
   */
  assets?: { css?: string[]; js?: string[] };
  /**
   * How long the entry stays fresh. After this, reads still get the
   * cached html but a background re-render is scheduled.
   *
   * Default 300s (5 minutes) when omitted. Error responses ignore
   * `ttlSec` and use the per-code defaults from `RENDER_ERROR_TTL`.
   */
  ttlSec?: number;
  /**
   * When the render failed (network / auth / not_found / rate_limit /
   * timeout / unknown / blocked), plugins should set `error` instead of
   * building an html error frame. The core caches the error using
   * `RENDER_ERROR_TTL` and, absent `errorHtml`, substitutes a fixed
   * placeholder when re-rendering the page.
   */
  error?: RenderError;
  /**
   * Optional failure-display HTML, paired with `error`. When `error` is
   * set and `errorHtml` is present, the core shows `errorHtml` instead of
   * the generic `errorPlaceholder()` — e.g. a link-card plugin can keep
   * its URL clickable even when the OGP fetch failed. Same trust
   * contract as `html`: **pre-sanitised, the core does not re-escape it**.
   *
   * Deliberately a separate field rather than "non-empty `html` + `error`
   * means show `html`" — that shape makes a plugin's stray/forgotten
   * `html` leak into the error display by accident. An explicit opt-in
   * field means a plugin that hasn't been updated for `errorHtml` keeps
   * the current safe-by-default behaviour (placeholder).
   *
   * Ignored when `error` is unset.
   */
  errorHtml?: string;
}

/**
 * Error categories cached with their own per-code TTLs. See
 * `packages/api/src/renderer/cache/index.ts:RENDER_ERROR_TTL` for the
 * concrete numbers. `blocked` is a policy-level permanent rejection
 * (SSRF block, disallowed scheme, disallowed content-type) — distinct
 * from `not_found` semantically but sharing its 1h persistent-failure
 * TTL. `busy` is a transient renderer-admission rejection (e.g. a
 * shared fetch/render concurrency semaphore's wait queue was full, or a
 * queued request's wait deadline elapsed) — never a property of the
 * embed's target, so it shares a short transient TTL with
 * `network`/`timeout` rather than `blocked`'s persistent one.
 */
export interface RenderError {
  code: 'auth' | 'rate_limit' | 'not_found' | 'network' | 'timeout' | 'unknown' | 'blocked' | 'busy';
  /** Free-form text for log/debug — NOT inlined into the user-facing placeholder. */
  message?: string;
  /**
   * Server-supplied retry-after hint in seconds. When set on a
   * `rate_limit` error, it overrides the default 5min TTL.
   */
  retryAfterSec?: number;
}

/**
 * Placeholder shape declaration. Three variants align with the typical
 * embed shapes we anticipate:
 *
 *   - `fixed`: pixel-precise (e.g. exact-size avatar / icon)
 *   - `aspect`: responsive width with a locked aspect ratio
 *     (e.g. video thumbnail)
 *   - `card`: small / medium / large card style for link-preview-y
 *     embeds where the exact size flexes with available width
 *
 * Numbers are plugin-declared and treated as trusted — they are
 * interpolated into the placeholder HTML's inline style. User-supplied
 * tag args never reach style values.
 */
export type Reservation =
  | { variant: 'fixed'; widthPx?: number; heightPx: number }
  | { variant: 'aspect'; aspectRatio: number /* width / height */ }
  | { variant: 'card'; size: 'small' | 'medium' | 'large' };

/**
 * URL inline-expansion rule — when an inline link target matches the
 * registered host / pattern, the plugin can inline-expand the link to
 * a richer fragment (e.g. GitHub issue card). Phase 4 lights this up
 * through the `core/url-inline-expand.ts` transform; plugins return
 * either `'replaced'` (HTML to substitute) or `'unchanged'` (let the
 * next expander try, falling through to plain autolink).
 */
export interface UrlInlineExpansionRule {
  /** Bumped to invalidate cached expansions, same semantics as `EmbedRenderer.cacheVersion`. */
  cacheVersion: number;
  /** Pattern the URL must match. RegExp or substring matcher. */
  match: RegExp | ((url: string) => boolean);
  /** Produce the expanded fragment OR signal "no opinion, fall through". */
  expand: (url: string, ctx: RenderContext) => InlineExpansion | Promise<InlineExpansion>;
}

/** Result of an `UrlInlineExpansionRule.expand` call. */
export type InlineExpansion = { kind: 'unchanged' } | ({ kind: 'replaced' } & RenderResult);

/**
 * The fragment a code-block renderer produces (Phase 6). Kept in the
 * contract so Phase 6 plugins type-check against the final shape.
 */
export interface EmbedFragment {
  /** Pre-sanitised HTML fragment to inline at the source position. */
  html: string;
  /** RFC-0023 — optional structured payload paired with `html` (see `RenderResult.structured`). */
  structured?: StructuredRenderPayload;
  /** Optional `<head>`-bound assets (CSS / JS) keyed by URL. */
  assets?: { css?: string[]; js?: string[] };
}

/**
 * Shared key shape for `CacheStorage.get` / `set`. The 4-tuple
 * `(pluginName, pluginCacheVersion, pageId, embedKey)` is the unique
 * compound index on `PluginRenderCache`. `pluginCacheVersion` lives in
 * the key (not just on the document) so reads can early-out without a
 * second roundtrip when the plugin bumped its version.
 */
export interface CacheKey {
  pluginName: string;
  pluginCacheVersion: number;
  pageId: string;
  embedKey: string;
}

/**
 * What `CacheStorage.get` returns on a hit. `fetchedAt` lets the SWR
 * wrapper decide fresh / stale / expired without doing a second `now()`
 * roundtrip; `expiresAt` is the TTL deadline written when the entry
 * was last set.
 */
export interface CacheEntry {
  html: string;
  result: RenderResult;
  fetchedAt: Date;
  expiresAt: Date;
  /**
   * Present ⇔ this is a stale-if-error entry keeping a prior success on
   * screen (see `packages/api/src/renderer/cache/index.ts:
   * STALE_IF_ERROR_MAX_AGE_SEC`): the value is that ORIGINAL success's
   * timestamp, carried forward unchanged across consecutive failed
   * retries — never the failed attempt's `fetchedAt`. Success entries do
   * not carry it (their `fetchedAt` IS the last-good time; readers use
   * that directly, which also covers, value-identically, entries written
   * while this field was still being set on success).
   */
  lastGoodFetchedAt?: Date;
}

/**
 * MongoDB-backed cache surface. Phase 4 ships exactly one
 * implementation (`packages/api/src/renderer/cache/mongodb-cache.ts`);
 * the interface is abstracted so a future Redis hot tier can plug in
 * without contract changes.
 *
 * Plugins access a **per-plugin scoped** view of this interface
 * (`RenderContext.cache`): the runtime auto-stamps `pluginName` on
 * every `get` / `set` so a plugin cannot read / write another plugin's
 * cache.
 */
export interface CacheStorage {
  get(key: CacheKey): Promise<CacheEntry | null>;
  set(key: CacheKey, entry: CacheEntry): Promise<void>;
  /** Drop every entry for a page; returns the number of deleted rows. */
  invalidatePage(pageId: string): Promise<number>;
  /** Drop every entry written by a plugin; returns the number of deleted rows. */
  invalidatePlugin(pluginName: string): Promise<number>;
  /** Drop every cached entry; returns the number of deleted rows. */
  invalidateAll(): Promise<number>;
}

/**
 * Per-plugin scoped cache surface handed to a plugin via
 * `RenderContext.cache`. Same shape as `CacheStorage` minus the
 * `pluginName` requirement on key — the runtime stamps it.
 */
export interface ScopedCacheStorage {
  get(key: Omit<CacheKey, 'pluginName'>): Promise<CacheEntry | null>;
  set(key: Omit<CacheKey, 'pluginName'>, entry: CacheEntry): Promise<void>;
  /** Convenience for plugin-driven invalidation. Always scoped to this plugin. Returns deleted count. */
  invalidatePage(pageId: string): Promise<number>;
}

/**
 * Authentication context for plugins that need to look up their own
 * (encrypted) config / per-user tokens.
 *
 * **Phase 4 ships the interface only.** The registry impl in
 * `packages/api/src/renderer/registry.ts` throws
 * `Error('AuthContext not yet implemented — Phase 7')` from the
 * `config()` callsite. Phase 7 will wire this against RFC-0001's
 * encrypted-config lookup and a per-plugin namespace.
 *
 * Phase 6 no-I/O plugins (PlantUML / KaTeX / Mermaid / emoji) must NOT
 * call `AuthContext.config()` — they are no-I/O by definition. The
 * thrown-error stub will surface accidental coupling immediately.
 */
export interface AuthContext {
  /**
   * Parse this plugin's encrypted config row through the supplied
   * Zod schema and return the typed values. Throws on Phase 4 (stub).
   */
  config<S extends z.ZodTypeAny>(schema: S): z.infer<S>;
}

/**
 * Context passed to every renderer callback. Phase 2 exposed `mode` +
 * `log`; Phase 4 adds `cache` (per-plugin scoped) and `auth` (interface
 * only; throws on access). Existing core plugins (headings / wikilinks
 * / mentions / code-blocks / syntax-highlight) do not read `cache` or
 * `auth` so the addition is non-breaking.
 */
export interface RenderContext {
  /**
   * What the pipeline is being run for. `'save'` = persisting a new
   * revision (cache writes are appropriate); `'read'` = on-the-fly
   * fallback for an old revision; `'view'` = view-mode page render
   * (cache reads + writes); `'edit'` = edit-mode draft (Phase 7 will
   * special-case this to return placeholder only).
   *
   * Phase 4 treats `'view'` and `'edit'` identically — both run the
   * cached render path. The branching is reserved for Phase 7 where
   * the edit-mode Yjs integration lands.
   */
  mode: 'save' | 'read' | 'view' | 'edit';
  /** Structured logger scoped to the registering plugin. */
  log: PluginLogger;
  /**
   * Per-plugin scoped cache. Provided to `EmbedRenderer.render` /
   * `UrlInlineExpansionRule.expand` callsites by the dispatch layer.
   * Absent on the core-transform path (headings / wikilinks / mentions /
   * code-blocks / syntax-highlight never consult the cache), so the
   * field is optional and consumers that do need it can rely on the
   * dispatch layer always providing it.
   */
  cache?: ScopedCacheStorage;
  /**
   * Auth surface. Phase 4 stub: `config()` throws when called. Absent on
   * the core-transform path; provided by the dispatch layer to embed
   * renderer / inline-expander callsites. Phase 7 will wire the real
   * encrypted-config-backed implementation.
   */
  auth?: AuthContext;
  /**
   * Who is driving this render. Required so admission control (§6) can
   * apply its per-user concurrency cap end-to-end — every entry point
   * (`Renderer.run`/`runMetadata`/`runRender`, `packages/api/src/renderer/
   * index.ts`) requires callers to supply this. See `RenderActor`'s doc
   * comment for which variant real call sites actually produce today.
   */
  actor: RenderActor;
  /**
   * Optional cancellation signal, propagated from the originating HTTP
   * request (`c.req.raw.signal` on `POST /pages/preview`). A waiting
   * (not-yet-running) admission-control job is removed from its queue
   * the instant this fires; an already-running child-process render is
   * NOT force-killed (§6 — the cost of killing/respawning a worker
   * outweighs letting an already-cheap render finish and discarding the
   * result). Absent on the save / read call sites, which have no
   * request to cancel against.
   */
  signal?: AbortSignal;
}

/**
 * The registry handed to every plugin's `registerRenderer(scope, ctx)`.
 * Each method tags the registration with the registering plugin so the
 * runtime can attribute warnings ("plugin X tried to register
 * something the runtime doesn't support yet").
 *
 * Phase 4 honours:
 *   - `addUnifiedPlugin(plugin, { phase: 'transform' })`
 *   - `addNodeRenderer(type, renderer)`
 *   - `addEmbedTag(name, renderer)` — last-wins + boot warn on collision
 *   - `addUrlInlineExpander(rule)` — registration-order list
 *
 * Phase 4 stubs (warn-noop):
 *   - `addCodeBlockRenderer` (Phase 6 lights this up)
 *
 * feature-renderer-plugin-boundary Phase 1 adds `addStylesheet(path)` —
 * the boot-time CSS-manifest extension point (see that method's own doc
 * comment).
 */
export interface RendererRegistry {
  /**
   * Append a `unified` transformer plugin. `options.phase` controls
   * whether it runs before the parser tweaks (`'pre'`), after the core
   * 4 transforms (`'transform'`), or in the hydrate phase (`'post'`).
   * Phase 2: only `'transform'` is honoured; other phases warn-noop.
   *
   * The plugin signature follows unified.js conventions
   * (`() => (tree, file) => void`). Typed loosely here so plugins can
   * pull `unified` themselves without the contract dragging in the
   * dep.
   */
  addUnifiedPlugin(plugin: unknown, options?: { phase?: RenderPhase }): void;

  /**
   * Register a per-mdast-node-type renderer. The runtime walks the
   * tree once and dispatches each node to every renderer registered
   * for its `type`, in registration order.
   */
  addNodeRenderer(type: string, renderer: NodeRenderer): void;

  /**
   * Register a code-block renderer for a language tag. Phase 4 warns
   * and discards. Phase 6 lights this up.
   */
  addCodeBlockRenderer(lang: string, renderer: CodeBlockRenderer): void;

  /**
   * Register an embed-tag renderer for `@[name](url)`. Collisions are
   * resolved last-wins with a boot-time warn (see RFC §"Plugin tag
   * collision").
   */
  addEmbedTag(name: string, renderer: EmbedRenderer): void;

  /**
   * Register a URL inline-expansion rule. Order of registration is
   * preserved; the first match that returns `'replaced'` wins.
   */
  addUrlInlineExpander(rule: UrlInlineExpansionRule): void;

  /**
   * Declare a static CSS asset the plugin needs the browser to load
   * (e.g. KaTeX's ~30KB math stylesheet). `path` MUST be an
   * API-relative absolute path confined to the plugin's own
   * `registerRoutes` namespace — `/api/plugins/<this plugin's
   * name>/<…>` — the same prefix `PluginRouterScope.route(...)` mounts
   * that plugin's HTTP routes under. A URL scheme, protocol-relative
   * `//host`, backslash, `..` traversal segment, or a path outside the
   * plugin's own namespace all throw synchronously (boot-time reject —
   * this is not an operator-configurable external URL; see spec
   * §2.1's "不採用案"). During the `feature-api-v2-path-removal`
   * migration period the legacy `/api/v2/plugins/<name>/<…>` prefix is
   * also accepted and silently normalised to the canonical `/api/plugins/`
   * form before publication — a plugin package that hasn't bumped its own
   * `addStylesheet(...)` call site yet still gets a working manifest
   * entry; this dual-accept is transitional, not a permanent alias.
   *
   * The call only stages the path in a per-plugin pending set: it is
   * published to the public `GET /api/app/info` `rendererStylesheets`
   * manifest ONLY after this plugin's OWN `registerRoutes(scope, ctx)`
   * completes without throwing (so the manifest never advertises a path
   * whose route failed to mount). A plugin with no `registerRoutes` at
   * all, or whose `registerRoutes` throws, never gets its pending
   * stylesheets committed — dropped wholesale, not partially. Query /
   * fragment are allowed; duplicate calls with the same path are a
   * no-op. Call this from `registerRenderer`, not `registerRoutes` —
   * commit timing depends on this method having already run.
   */
  addStylesheet(path: string): void;
}
