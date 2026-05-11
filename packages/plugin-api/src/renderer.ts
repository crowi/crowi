import type { z } from 'zod';
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
 * `katex`). Phase 6 lights this up; Phase 4 keeps the warn-noop.
 */
export interface CodeBlockRenderer {
  (info: CodeBlockInfo, ctx: RenderContext): EmbedFragment | Promise<EmbedFragment>;
}

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
 * `apps/crowi-api/src/renderer/cache/index.ts:cachedRender`).
 */
export interface RenderResult {
  /** Already-sanitised HTML the core will inline. */
  html: string;
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
   * timeout / unknown), plugins should set `error` instead of building
   * an html error frame. The core caches the error using `RENDER_ERROR_TTL`
   * and substitutes a fixed placeholder when re-rendering the page.
   */
  error?: RenderError;
}

/**
 * Error categories cached with their own per-code TTLs. See
 * `apps/crowi-api/src/renderer/cache/index.ts:RENDER_ERROR_TTL` for the
 * concrete numbers.
 */
export interface RenderError {
  code: 'auth' | 'rate_limit' | 'not_found' | 'network' | 'timeout' | 'unknown';
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
}

/**
 * MongoDB-backed cache surface. Phase 4 ships exactly one
 * implementation (`apps/crowi-api/src/renderer/cache/mongodb-cache.ts`);
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
 * `apps/crowi-api/src/renderer/registry.ts` throws
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
}
