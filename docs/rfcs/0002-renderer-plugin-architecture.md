# RFC-0002: Renderer Plugin Architecture

- **Status**: Draft (round 3 — implementation feedback integrated)
- **Target**: Crowi 2.1 release
- **Owner**: TBD
- **Last updated**: 2026-05-12
- **Depends on**: RFC-0001 (Plugin Architecture)
- **Implements**: Phase 1–6 landed in `rfc002-phase2/impl` branch; Phase 7+ in progress

## Summary

Extend the v2.0 plugin model (RFC-0001) with a fifth orthogonal concern:
**rendering**. Markdown parsing, AST transformation, embed handling, and
HTML rendering all become extension points that plugins can hook into.

Three architectural commitments distinguish this design from a naive
"add another plugin hook":

1. **SSR-first**: every renderer plugin must produce HTML on the server.
   Client-side rendering of plugin content is forbidden, because it
   causes layout shift.
2. **No external API calls during real-time editing**: plugins that
   fetch external data (GitHub PR cards, Slack threads, etc.) reserve
   space with a placeholder while editing, and only fetch on
   page save or explicit user interaction.
3. **No new Markdown syntax (mostly)**: plugins extend behavior, not
   grammar. New surface syntax requires explicit RFC approval and
   is restricted to a small set of well-known patterns.

## Round 3 changes

Round 3 incorporates concrete decisions made during Phase 1–6
implementation. Major changes from round 2:

- **`RenderContext.mode`** expanded from `'edit' | 'view'` to
  `'save' | 'read' | 'view' | 'edit'`.
- **Render artifact persistence** moved from `Page.renderedHtml`
  (HTML string on Page) to **`Revision.renderedAst`** (mdast JSON on
  Revision). Rationale and trade-offs documented below.
- **`EmbedRenderer.reservation`** is now optional (was required), to
  accommodate no-I/O plugins like emoji.
- **`addCodeBlockRenderer` return type** widened to
  `EmbedFragment | RenderResult` union.
- **`addNodeRenderer` contract** clarified: `void | Promise<void>`
  with in-place AST mutation.
- **Cache cleanup on plugin uninstall** clarified: cache is always
  cleared on uninstall regardless of `--purge` flag (cache is derived
  data, not user data).
- **`AuthContext`** is interface-stable but `config()` throws until
  Phase 7; no-I/O plugins must not call it.
- **Migration command framework** is now a separate future RFC
  (RFC-0008). `renderer:rebuild` and `wikilink migrator` are listed
  here as scope items, but their command infrastructure is deferred.
- **Implementation notes section** added (jiti, shiki, hast-util-raw
  caveats — see end of document).

## Goals

- **Renderer extensibility** for math, diagrams, syntax highlighting,
  embeds, and custom blocks, without bloating core.
- **Zero layout shift** for async-data plugins via a reservation API and
  a server-side cache contract.
- **Clean separation between editing and viewing**. Editors see
  placeholders for async embeds; viewers see fully-rendered cached HTML.
- **Backward compatibility with v1.x renderer behaviour** via a single
  bundled compatibility plugin (`@crowi/plugin-renderer-crowi-legacy`),
  isolated from new installs.
- **Markdown source remains the source of truth**. AST is derived; HTML
  is derived; both are caches over the canonical Markdown.
- **Historical fidelity for revisions**. Past revisions render with the
  renderer state at the time of save (preserved via `renderedAst`
  persistence), unless explicitly rebuilt with `renderer:rebuild`.
- **Stable plugin API across the v2.x line**. Renderer plugins authored
  against `@crowi/plugin-api@2.x` keep working through every v2 minor.

## Non-goals (this RFC)

- WYSIWYG editor extensibility. The editor uses a single core engine
  (CodeMirror 6, per RFC-0003) that is not pluggable.
- Editor-side preview of async embeds. Editing always shows placeholders
  for async content; full rendering only happens on save and on view.
- Per-user OAuth token forwarding to renderer plugins. v2.1 uses a
  single owner-provided token per plugin (see "Authentication context").
  Per-user tokens are a future extension.
- Sandboxed plugin execution (same trust model as RFC-0001 — official
  `@crowi/*` packages only for v2.1).
- Hot-reload / install-without-restart (same constraint as RFC-0001).
- Per-user renderer config. Renderer plugins are configured per-instance
  by operators, not per-user.
- **Generic migration command framework**. Individual migration commands
  (`renderer:rebuild`, `wikilink migrator`) ship in v2.1, but the
  framework that registers and orchestrates them is deferred to RFC-0008.

## Overview

```
┌──────────────── Markdown source (Yjs Y.Text or revision.body) ─┐
│   # Title                                                      │
│   Some text with @[card](https://github.com/...)               │
│   ```mermaid ... ```                                           │
└──────────┬─────────────────────────────────────────────────────┘
           │
           │  parse phase  (remark + plugin remark plugins)
           ▼
┌─────────────────── MDAST ──────────────────────────┐
│   heading / paragraph / code(mermaid) / embed-tag  │
└──────────┬─────────────────────────────────────────┘
           │
           │  transform phase  (AST → AST mutations)
           │  - wikilink resolution ([[Page]])
           │  - URL inline expansion (plugin-driven)
           │  - mention extraction
           │  - heading anchor ID generation
           ▼
┌─────────────────── transformed MDAST ──────────────┐
│   wikilink / mention / heading-with-id / ...       │
└──────────┬─────────────────────────────────────────┘
           │
           │  render phase  (server-side)
           │  - core node renderers
           │  - plugin node renderers
           │  - embed renderers (with cache lookup)
           │  - reservation API for async embeds
           ▼
┌─────────────────── persisted artifacts ────────────┐
│   Revision.renderedAst (mdast JSON, per-revision)  │
│   Revision.metadata (toc, links, mentions, ...)    │
│   PluginRenderCache (per-page embed cache)         │
└──────────┬─────────────────────────────────────────┘
           │
           │  view phase  (Web tier)
           │  - mdast → hast → JSX runtime
           │  - hast-util-raw to handle plugin-emitted raw HTML
           │  - Tailwind class injection
           ▼
┌──────────────── Rendered page in browser ──────────┐
```

The four pipeline phases — **parse**, **transform**, **render**,
**hydrate** — are the extension points. Plugins declare which phases
they participate in.

The view phase is handled by the Web tier and is not a plugin extension
point.

## Render artifact persistence: `Revision.renderedAst`

Render output is persisted as a **mdast JSON tree** on each `Revision`
document, NOT as HTML on the `Page` document.

```ts
Revision {
  _id, pageId, body, // existing fields
  renderedAst: object | null,   // mdast JSON, post-transform phase
  renderedAt: Date | null,
  rendererVersion: string,      // semver of the renderer pipeline that produced this
  metadata: RevisionMetadata,   // toc, wikiLinks, mentions, codeBlockLanguages
}
```

### Why mdast JSON instead of HTML

- **Web tier flexibility**: the Web layer converts mdast → hast → JSX
  with Tailwind class injection at render time. Storing HTML would
  freeze the style choices at save time.
- **Plugin output compatibility**: plugin-emitted raw HTML fragments
  (shiki, embeds) are stored as `html` nodes in the AST and rendered
  via `hast-util-raw` at view time. Storing pre-finalised HTML would
  require re-parsing it.
- **Forward compatibility**: future view-side features (search
  highlighting, comment anchoring, AI annotations) can manipulate the
  AST rather than parsing HTML.

### Why per-revision

- **Historical fidelity**: revision N renders the way it looked when
  saved at revision N's renderer version. If we upgrade the renderer
  later (e.g. fix a Markdown edge case, add a plugin), past revisions
  do NOT silently change appearance.
- **Stale detection**: `rendererVersion` lets us identify revisions
  whose AST was produced by an older pipeline. `renderer:rebuild`
  uses this to find rebuild targets.

### Trade-off

A renderer security fix or bug fix does NOT automatically improve past
revisions' display. Operators must run `renderer:rebuild` to apply
fixes to historical content. This is a deliberate choice — surprise
visual changes to historical content are worse than the operational
cost of a rebuild command.

### `renderer:rebuild`

```bash
crowi-admin renderer rebuild --dry-run
crowi-admin renderer rebuild
crowi-admin renderer rebuild --only-stale          # rendererVersion mismatch only
crowi-admin renderer rebuild --pages=<glob>        # subset
```

Iterates revisions, re-runs the parse/transform/render pipeline,
updates `renderedAst` and `rendererVersion`. Idempotent; safe to
re-run. Processes in batches with bounded concurrency to avoid
overwhelming embed plugins' rate limits.

This command also handles the v1.x → v2.1 upgrade case: legacy
revisions have no `renderedAst` field and must be populated before
their content can display via the v2.1 view pipeline.

The command itself ships in v2.1. The registration framework that
makes it discoverable alongside other migrations (`wikilink migrator`,
future v2.1 → v2.2 migrations, etc.) is **deferred to RFC-0008**.
Until then, each command is implemented and exposed individually.

## The `registerRenderer` extension

Adds one new field to the `CrowiPlugin` interface from RFC-0001:

```ts
export interface CrowiPlugin {
  // ... existing fields from RFC-0001 ...

  /**
   * Renderer extensions. Called once at boot, after all other
   * register* hooks. The registry is frozen after registration.
   */
  registerRenderer?: (registry: RendererRegistry, ctx: PluginContext) => void;
}
```

### `RendererRegistry`

```ts
export interface RendererRegistry {
  /**
   * Add a remark/rehype unified plugin to the parse pipeline.
   * `phase: 'pre'` runs before core normalisation,
   * `phase: 'post'` runs after.
   */
  addUnifiedPlugin(
    plugin: UnifiedPlugin,
    options: { phase: 'pre' | 'post' }
  ): void;

  /**
   * Render a specific MDAST node type. Mutation is in-place; the
   * renderer mutates the node (or replaces it) and returns
   * void | Promise<void>. If multiple plugins register for the same
   * node type, the last registration wins with a boot-time warning.
   */
  addNodeRenderer<T extends MdastNodeType>(
    nodeType: T,
    renderer: NodeRenderer<T>
  ): void;

  /**
   * Render a fenced code block with a specific language tag.
   * e.g. ```mermaid, ```plantuml, ```math
   *
   * Return type is a union:
   * - EmbedFragment: simple synchronous transformation, not cached
   *   independently of the revision's renderedAst.
   * - RenderResult: full cache-aware result, used when the code block
   *   does I/O (e.g. PlantUML server fetch).
   */
  addCodeBlockRenderer(
    lang: string,
    renderer: CodeBlockRenderer
  ): void;

  /**
   * Render a Zenn-style embed tag: @[tag](url)
   * e.g. @[github-pr](https://github.com/.../pull/123)
   */
  addEmbedTag(
    tag: string,
    renderer: EmbedRenderer
  ): void;

  /**
   * Expand URLs inline (mid-paragraph) to richer text.
   * Standalone-URL-as-card is NOT auto-applied; users must use
   * @[card](url) explicitly. See "URL handling policy" below.
   */
  addUrlInlineExpander(rule: UrlInlineExpansionRule): void;
}

export type CodeBlockRendererReturn = EmbedFragment | RenderResult;
```

`EmbedFragment` is for simple, deterministic transformations
(KaTeX-render-once, emoji-substitution) where the output is a function
of the input alone and benefits from being inlined into the
revision's `renderedAst`. `RenderResult` is for I/O-bound operations
that need the per-page cache, reservation, and stale-while-revalidate
machinery.

## URL handling policy

Three behaviours, three triggers:

| Behaviour | Trigger | Provided by |
|---|---|---|
| **Auto-link** (URL → clickable link) | Any bare URL in text | Core, always on. CommonMark autolink behaviour. |
| **Inline expansion** (URL → rich text in-paragraph, e.g. `https://github.com/.../issues/445` → `Title #445`) | Bare URL matched by a registered `UrlInlineExpansionRule` | Plugin |
| **Card embed** (full card UI) | Explicit `@[card](url)` or `@[<plugin-tag>](url)` | Plugin |

This is a deliberate departure from Slack/Discord/Zenn, which auto-card
standalone URL lines. The reasoning: surprise rendering ("I pasted a
URL and it became a giant card") is intrusive in a Wiki context, where
users may genuinely want the URL displayed verbatim. Card embedding is
opt-in via explicit syntax.

If no plugin handles an inline URL, it falls through to plain
auto-link — same as a Markdown processor without plugins.

```ts
export interface UrlInlineExpansionRule {
  /** Plugin-supplied predicate. Returns true if this rule handles the URL. */
  match(url: URL): boolean;

  /**
   * Compute the inline replacement. May fetch from network — same
   * cache contract as embeds (see "Cache contract" section).
   */
  expand(url: URL, ctx: RenderContext): Promise<InlineExpansion>;

  /** For cache invalidation (see "Cache versioning"). */
  cacheVersion: number;
}

export type InlineExpansion =
  | { kind: 'replaced'; html: string }
  | { kind: 'unchanged' };  // fall through to plain link
```

## Reservation API (optional)

Async-data renderers that fetch over the network SHOULD declare a
layout reservation. Plugins without I/O (emoji, KaTeX) MAY omit it.

```ts
export interface EmbedRenderer {
  /** Stable name for this embed kind, used in cache keys. */
  name: string;

  /**
   * Bumped when the rendered HTML output changes (e.g. card layout
   * redesign). All cache entries with a different version are
   * ignored on read.
   */
  cacheVersion: number;

  /**
   * Layout reservation. OPTIONAL.
   * Required for I/O-bound renderers (anything calling out to a
   * network or subprocess); without it, layout shift is possible.
   * For deterministic no-I/O renderers (emoji, basic KaTeX), the
   * field MAY be omitted — these render synchronously to their
   * natural size.
   */
  reservation?:
    | { kind: 'fixed'; widthPx?: number; heightPx: number }
    | { kind: 'aspect'; aspectRatio: number /* w/h */ }
    | { kind: 'card'; variant: 'small' | 'medium' | 'large' };

  /**
   * Cache TTL. Server re-fetches in the background after this
   * duration; staleness is served immediately while refresh runs.
   */
  cacheTtlSec: number;

  /**
   * Hard staleness limit. After this, served HTML shows a "stale"
   * indicator and forces refresh on next render.
   */
  staleAfterSec: number;

  /**
   * Compute a stable cache key from input.
   * Default implementation: sha256(JSON.stringify(input)).
   * Plugins override only when they want non-input data in the key
   * (rare; usually for v2.2+ per-user token forwarding).
   */
  cacheKey?(input: EmbedInput): string;

  /** Single-item render. Implement at least one of render / renderBatch. */
  render?(input: EmbedInput, ctx: RenderContext): Promise<RenderResult>;

  /**
   * Batch render — preferred when the plugin can fetch many inputs
   * in one external call (e.g. GitHub GraphQL for many PRs).
   * Core groups embeds per-page and calls renderBatch when available.
   */
  renderBatch?(
    inputs: EmbedInput[],
    ctx: RenderContext
  ): Promise<RenderResult[]>;
}

export type RenderResult =
  | { kind: 'ok'; html: string }
  | {
      kind: 'error';
      code: 'auth' | 'rate_limit' | 'not_found'
          | 'network' | 'timeout' | 'unknown';
      message: string;
      retryAfterSec?: number;
      placeholderHtml?: string;
    };

export interface RenderContext {
  /** Per-page cache. Scoped to (pluginName, pageId, cacheKey). */
  cache: CacheStorage;

  /**
   * Render trigger.
   * - 'save': running inside the page-save transaction; produce
   *   authoritative output for persistence in renderedAst.
   * - 'read': serving a viewer; cache lookup expected.
   * - 'view': one-shot interactive render (e.g. user clicked an
   *   edit-mode placeholder to force a real render).
   * - 'edit': running inside the live editor; placeholder-only,
   *   no I/O permitted.
   */
  mode: 'save' | 'read' | 'view' | 'edit';

  /** The currently-rendering page; same models as RFC-0001's PluginContext. */
  page: PageRef;

  /** Authenticated context for outbound calls. See "Authentication context". */
  auth: AuthContext;

  /** Structured logger scoped to the plugin. */
  log: { info: (...) => void; warn: (...) => void; error: (...) => void };
}
```

The core handles cache eviction, stale-while-revalidate, and edit-mode
placeholder rendering. Plugins only implement `render` (or
`renderBatch`).

### Mode semantics

| Mode | Caller | Plugin behaviour |
|---|---|---|
| `'save'` | Page-save transaction (RFC-0003) | Produce authoritative output. Always invoke `render`; cache the result for subsequent `'read'` calls. |
| `'read'` | Web tier serving a viewer | Read from cache; if stale, return cached + spawn background refresh; if missing, invoke `render`. |
| `'view'` | One-shot force-render (e.g. clicked placeholder in editor) | Same as `'read'` but bypass stale-while-revalidate and re-fetch unconditionally. |
| `'edit'` | Inside the live editor pipeline | **Plugin MUST return immediately with a placeholder derived from `reservation`. No I/O. No cache writes.** The editor shows placeholders so embeds don't thrash external APIs as the user types. |

The `'edit'` mode is the contract that prevents real-time editing
from triggering renders. RFC-0003 defines the editor-side invocation;
plugin authors only need to know: in `'edit'` mode, no I/O.

## Authentication context

Many renderer plugins make outbound API calls (GitHub PR fetch, Slack
thread fetch, etc.) which require authentication. Crowi v2.1 takes a
deliberately simple approach:

### v2.1: Owner-provided tokens

- Plugins declare what credentials they need via `configSchema`,
  marking sensitive fields with `@sensitive` (per RFC-0001).
- The Crowi instance owner enters credentials once via the admin UI.
- Credentials are encrypted at rest (RFC-0001's existing mechanism).
- The plugin uses *the same credentials for all fetches*, regardless
  of which user authored or views the page.

```ts
export interface AuthContext {
  /**
   * Plugin-scoped config (decrypted). Same shape as
   * PluginContext.config() from RFC-0001 — re-exposed here for
   * convenience inside RenderContext.
   *
   * IMPLEMENTATION NOTE: in Phase 6, the implementation is a stub
   * that throws on call. No-I/O plugins (emoji, KaTeX, mermaid,
   * etc.) must not invoke this. Full implementation lands in
   * Phase 7 alongside GitHub Embed plugin.
   */
  config: <S extends z.ZodTypeAny>() => z.infer<S>;
}
```

Plugins that need credentials MUST declare `requiresAuth: true` on
their `EmbedRenderer` / `UrlInlineExpansionRule`. The core blocks
registration if `requiresAuth` is true and `AuthContext` is not yet
implemented (or the plugin's config is missing).

### Implications operators must accept

By design, this means:

- **All Wiki users (with page-read permission) effectively have read
  access to anything the owner's token can read.** If the owner provides
  a GitHub PAT with `repo` scope, every Wiki user can see private repo
  content via embeds, regardless of their personal GitHub permissions.
- **Wiki page permissions become the security boundary**, not the
  upstream service's permissions.

The admin UI MUST display this clearly when an operator configures any
plugin that requires credentials. Suggested wording:

> ⚠️ Content fetched with these credentials will be visible to all users
> with read access to pages where it's embedded. Use a token with the
> minimum scope needed.

### Recommended scope guidance

Plugins SHOULD declare recommended token scopes in their `configSchema`
description so the admin UI can show guidance:

```ts
configSchema: z.object({
  githubToken: z.string().describe(
    '@sensitive GitHub Personal Access Token. ' +
    'Recommended scope: `public_repo` (for public PRs/issues only) ' +
    'or fine-grained PAT with `Pull requests: Read` ' +
    '+ `Issues: Read` on specific repositories.'
  ),
}),
```

For GitHub specifically, `@crowi/plugin-renderer-github-embed` recommends
**fine-grained PATs with read-only scopes on specific repositories**
rather than classic PATs with `repo` scope.

### Rate limit handling

A single owner token shares its rate limit budget across all Wiki
users. To avoid exhaustion:

- Plugins SHOULD implement `renderBatch` whenever the upstream API
  supports batching (GitHub GraphQL: up to ~100 PRs per call).
- `cacheTtlSec` should err on the side of being long (1+ hours for
  GitHub, since PR titles/states don't change often).
- On `rate_limit` errors, core respects `retryAfterSec` and serves
  stale cache entries past their nominal TTL.

### v2.2+ extension: per-user tokens (deferred)

A future RFC will introduce a mechanism for renderer plugins to
borrow per-user OAuth tokens from auth plugins (RFC-0001's
`registerAuth`). This will:

- Allow per-user scoped fetches (each user sees only what their
  GitHub account allows)
- Distribute rate limit budget across users
- Require per-user cache scoping (a major change to cache key shape)

The v2.1 cache key (see "Cache contract") deliberately keeps the
shape extensible so per-user keys can be added without a breaking
change.

## Phase: parse

Plugins can add `unified` (remark/rehype) plugins via
`addUnifiedPlugin`. This is the most flexible but also the most
constrained extension point — plugins MUST NOT introduce new Markdown
syntax beyond the small set listed in **Permitted syntax extensions**
below.

```ts
registerRenderer((reg) => {
  reg.addUnifiedPlugin(remarkGfm, { phase: 'pre' });
});
```

### Permitted syntax extensions

Only these patterns may be added by plugins:

| Pattern | Example | Rationale |
|---|---|---|
| Fenced code blocks with custom lang | ` ```mermaid ` | Universally supported, ignored gracefully by other Markdown processors |
| Wikilinks | `[[Page Name]]` | De facto standard (Obsidian, Logseq, GitHub Wiki) |
| Embed tags | `@[card](url)` | Zenn-style; `@[tag](url)` shape is unambiguous |
| Mentions | `@username` | Industry standard (GitHub, Slack, etc.) |
| URL inline expansion | `https://...` (no syntax change, just smarter rendering) | Plugin-driven, falls back to autolink |

Any other syntax extension requires a follow-up RFC. This is a hard
constraint to keep documents portable.

## Phase: transform

AST-to-AST mutations. Used for:

- **Wikilink resolution**: `[[Page Name]]` → `<a href="/path/to/page">Page Name</a>`,
  with target lookup against the page index. If the target doesn't
  exist, render with a "broken link" class for styling.
  - Variations supported: `[[/path/to/page]]`, `[[Page|Display]]`,
    `[[Page#section]]`.
- **URL inline expansion** (plugin-driven): for each bare URL in a
  paragraph, run registered `UrlInlineExpansionRule`s in order; first
  match wins. If none match, leave URL as a plain autolink.
- **Mention extraction**: `@username` → `<a class="mention">` node, AND
  add to `Revision.metadata.mentions[]` for internal notification
  dispatch (see "Mention notification" below). Implemented in core,
  NOT as a plugin.
- **Heading anchor IDs**: every `heading` node gets an `id` attribute
  via `github-slugger`. Duplicates get `-1`, `-2` suffixes.

Transform plugins receive the parsed MDAST and mutate it in place.

### Mention notification

Mention is fundamental Wiki functionality and lives in core, not as a
plugin. The notification flow:

1. Transform phase extracts mentions into `Revision.metadata.mentions[]`.
2. After the save transaction completes, a core dispatcher reads
   `Revision.metadata.mentions[]` and invokes the notifier registry
   (RFC-0001's `registerNotifier`) for each mentioned user.

The dispatcher is an internal mechanism, not a publicly extensible
hook. RFC-0001's `registerHooks` remains reserved for v2.0 internal
use and is not stable for community plugins.

**Implementation status (Phase 6)**: mention extraction is implemented
and persisted to `Revision.metadata.mentions[]`. The dispatcher is
deferred to Phase 8.

## Phase: render

MDAST → AST artifacts. Core renderers handle the standard CommonMark +
GFM node types. Plugins can override or extend via `addNodeRenderer`.

Renderer plugins for code blocks (`addCodeBlockRenderer`), embed tags
(`addEmbedTag`), and inline URL expansion (`addUrlInlineExpander`) are
the most common; raw `addNodeRenderer` is reserved for advanced cases.

The render phase's output is the **finalised mdast** stored in
`Revision.renderedAst`. Plugin-emitted HTML fragments are stored as
`html` nodes within the AST; the Web tier handles them via
`hast-util-raw` during view-phase rendering.

## Cache contract

For any renderer that does I/O (network fetch, subprocess, large CPU
work), the result MUST be cached by core. Plugins do not implement
caching themselves; they declare TTL and provide `render` / `renderBatch`,
and core handles storage, eviction, and stale-while-revalidate.

### Storage backend

Cache entries are stored in a dedicated MongoDB collection
(`PluginRenderCache`). Justification for choosing MongoDB over Redis,
despite Redis already being in the stack for sessions and config cache:

- **Persistence**: render cache loss triggers re-fetches against
  external APIs, easily exhausting rate limits across the whole
  instance. MongoDB durability is appropriate; Redis AOF
  `appendfsync everysec` leaves a 1-second loss window.
- **Compound queries**: "invalidate all entries for `pageId=X`" and
  "invalidate all entries for `pluginName=Y`" are frequent operations.
  MongoDB indexes handle these directly; Redis requires either `SCAN`
  (production-unsafe at scale) or a parallel Set-based index structure.
- **Memory pressure isolation**: render cache can grow into the GB
  range (5KB × tens of thousands of entries). Co-tenanting with
  session/config in Redis risks LRU eviction conflicts where session
  data gets evicted to make room for render cache, or vice versa.
- **TTL granularity**: per-entry TTLs vary widely (KaTeX: forever,
  GitHub PR: hours, weather widget: minutes). MongoDB TTL indexes
  handle this naturally per-document.

The interface is abstracted (see `CacheStorage` below), so a future
two-tier implementation (Redis hot layer + MongoDB cold storage) can
be introduced if measurements show it's needed.

### Cache key shape

```ts
export interface CacheKey {
  pluginName: string;
  pluginCacheVersion: number;
  pageId: string;
  embedKey: string;
}
```

The 4-tuple is the compound unique index on `PluginRenderCache`.

**Why page-scoped?** Naively keying only by `(plugin, input)` shares
cache entries across pages. Pros: memory savings if the same URL is
embedded in many pages. Cons: cleanup on page deletion requires a
reverse-index lookup. Page-scoped keys mean page deletion →
straightforward `deleteMany({pageId})`.

The downside (duplicate cache entries when the same URL appears in
many pages) is acceptable: realistic worst case ~100 duplicates,
~500KB of duplication, negligible vs. the simplicity gain.

### Cache entry shape

```ts
export interface CacheEntry {
  html: string;
  htmlBytes: number;       // denormalised for fast quota queries
  fetchedAt: Date;
  expiresAt: Date;
  result: RenderResult;
}
```

The `htmlBytes` field is denormalised so per-page quota checks can
use `$sum: '$htmlBytes'` rather than the much more expensive
`$strLenBytes` aggregation over `html`.

Failed fetches ARE cached, with a shorter `expiresAt`, so a flapping
upstream doesn't get hammered every render. Error placeholder HTML is
stored alongside.

### `CacheStorage` interface

```ts
export interface CacheStorage {
  get(key: CacheKey): Promise<CacheEntry | null>;
  set(key: CacheKey, entry: CacheEntry, ttlSec: number): Promise<void>;
  invalidatePage(pageId: string): Promise<void>;
  invalidatePlugin(pluginName: string): Promise<void>;
  invalidateAll(): Promise<void>;
}
```

Plugins receive this via `RenderContext.cache` but rarely call it
directly — typical render code only returns a `RenderResult` and lets
core handle the cache write.

### MongoDB collection

```ts
PluginRenderCache: {
  _id: ObjectId,
  pluginName: string,
  pluginCacheVersion: number,
  pageId: ObjectId,
  embedKey: string,
  html: string,
  htmlBytes: number,
  fetchedAt: Date,
  expiresAt: Date,          // ← TTL index drives auto-eviction
  result: RenderResult,
}

// Indexes
{ pageId: 1, pluginName: 1, embedKey: 1, pluginCacheVersion: 1 } unique
{ expiresAt: 1 }, expireAfterSeconds: 0  // TTL eviction
{ pluginName: 1 }                         // plugin uninstall / version bump
{ pageId: 1 }                             // page deletion
```

### Size limits

- Single cache entry: 100KB HTML (warn over 50KB, reject over 100KB)
- Per-page cumulative cache: 10MB (prevents runaway plugins)
- Global: bounded naturally by TTL eviction

Reject events are logged with `pluginName` so operators can identify
misbehaving plugins.

### Stale-while-revalidate

When a `'read'` mode render hits a cache entry past `cacheTtlSec` but
within `staleAfterSec`:

1. Return the cached HTML immediately.
2. Spawn a background task to re-render with `mode: 'read'` and
   write the new result.
3. Next viewer gets fresh HTML.

When past `staleAfterSec`:

1. Return cached HTML with a `data-stale="true"` attribute.
2. Block on re-render for the next request.

When cache miss:

1. Invoke `render` (or `renderBatch`) synchronously, await result.
2. Cache the output.
3. Return.

### In-flight de-duplication

Concurrent reads of the same cache key (e.g. many viewers hitting a
page at once after a deploy) MUST NOT trigger N parallel calls to the
plugin's `render`. The core maintains an in-flight map:

```ts
inFlightRender: Map<CacheKey-as-string, Promise<RenderResult>>
```

The first request invokes `render` and stores the in-flight promise;
subsequent requests await the same promise. This prevents thundering
herd against external APIs.

### Cache invalidation triggers

| Trigger | Effect |
|---|---|
| Page save | All cache entries for `pageId` are re-rendered (synchronously, in the save transaction) |
| Page delete (via `pageEvent.emit('delete')`) | `invalidatePage(pageId)` |
| Page update (via `pageEvent.emit('update')`) | `invalidatePage(pageId)` |
| Plugin uninstall (regardless of `--purge`) | `invalidatePlugin(pluginName)` |
| Plugin upgrade with `cacheVersion` bump | Entries with old `pluginCacheVersion` ignored on read; TTL eventually evicts them |
| Admin "Clear render cache" button | `invalidateAll()` |
| TTL expiry | Background eviction by MongoDB TTL index |

**Note on plugin uninstall**: cache is derived data (not user data),
so it is always cleared on uninstall. The `--purge` flag from RFC-0001
governs only user-facing data (plugin config rows). Render cache
cleanup is unconditional.

### Error handling

Plugin renders fail in well-defined ways. Each error code has a
default core behaviour:

| Code | Default cache TTL | Default behaviour |
|---|---|---|
| `auth` | 60s | Surface in admin UI as "Plugin authentication failed" |
| `rate_limit` | `retryAfterSec` if provided, else 5 min | Pause renders for that plugin until retry-after |
| `not_found` | 1 hour | Show "resource not found" placeholder |
| `network` / `timeout` | 5 min | Show "temporarily unavailable" placeholder |
| `unknown` | 5 min | Log full error, show generic placeholder |

In all cases, the plugin's reservation is honoured — the placeholder
fills the same space as a successful render would.

### Bundled core renderers

The following ship in core (or as bundled, default-on plugins —
decision deferred to implementation, same as RFC-0001's question 2 for
`@crowi/plugin-storage-local` etc.):

| Renderer | Type | Notes |
|---|---|---|
| Syntax highlight | code-block | Shiki, server-side. Bundled language set restricted to 24 languages — see Implementation Notes. |
| GFM tables | unified plugin | `remark-gfm` |
| Task lists | unified plugin | `remark-gfm` |
| Heading anchors | transform | `github-slugger`, also extracts to `Revision.metadata.toc` |
| Wikilinks | transform | `[[Page]]` resolution |
| Mentions | transform | `@user` extraction (notifier dispatch in Phase 8) |
| Emoji | transform | `:smile:` → 😀 via `node-emoji` |
| Bare URL → autolink | transform | CommonMark autolink, no embed |

### Optional plugins (separate npm packages)

| Plugin | Provides | Auth required? | Phase |
|---|---|---|---|
| `@crowi/plugin-renderer-katex` | `$inline$` and `$$block$$` math via KaTeX (server-side) | No | Landed (Phase 6) |
| `@crowi/plugin-renderer-mermaid` | ` ```mermaid ` server-side rendered to SVG | No | Phase 6.1 |
| `@crowi/plugin-renderer-plantuml` | ` ```plantuml ` rendered via PlantUML server (configurable URL) | Optional (PlantUML server) | Landed (Phase 6) |
| `@crowi/plugin-renderer-github-embed` | `@[github-pr](url)`, `@[github-issue](url)`, plus inline URL expansion for `github.com/*` URLs | GitHub PAT (owner-provided) | Phase 7 |
| `@crowi/plugin-renderer-slack-embed` | `@[slack](url)` thread expansion | Slack token (owner-provided) | Deferred |
| `@crowi/plugin-renderer-crowi-legacy` | Bundled but default-off. Re-enables Crowi v1 rendering quirks (Markdown Fixer, line break handling). Migration users turn on via admin UI | No | Landed (Phase 6) |

## Phase: hydrate

Most rendered content needs no client-side JS — syntax-highlighted code
is already styled HTML, Mermaid is already an inlined SVG, math is
already laid out. The hydrate phase exists for the small set of
embeds that need interactivity (e.g. a "refresh" button on a stale
GitHub PR card).

```ts
export interface NodeRenderer<T> {
  render(node: MdastNode<T>, ctx: RenderContext): void | Promise<void>;
  /**
   * Optional. Selector + script reference for client-side hydration.
   * The script is loaded only on pages that contain this node type.
   */
  hydrate?: {
    selector: string;     // e.g. '.embed-github-pr'
    scriptUrl: string;    // bundled by the plugin's build
  };
}
```

Hydrate scripts are loaded lazily, only on pages that actually contain
the corresponding node type. The core injects `<script>` tags for
matching hydrate entries during page response generation.

## Revision metadata extraction

Render phases produce `renderedAst`, but they ALSO produce structured
metadata as a side effect, persisted on the `Revision` document:

```ts
interface RevisionMetadata {
  /** Generated by the heading-anchor transform. Used for in-page TOC,
      backlink anchor targets, search facet. */
  toc: Array<{
    level: number;
    text: string;
    anchorId: string;
    children?: TocEntry[];
  }>;

  /** Generated by the wikilink transform. Used to compute backlinks
      (the "what links here" view) without re-parsing every page. */
  wikiLinks: Array<{
    target: string;
    displayText?: string;
  }>;

  /** Generated by the mention transform. Consumed by the internal
      mention dispatcher (Phase 8) which forwards to RFC-0001's
      notifier registry. */
  mentions: Array<{ username: string }>;

  /** Generated by code block parsing. Used for search filters and
      analytics. */
  codeBlockLanguages: string[];

  /** Per-plugin metadata namespace, same shape as RFC-0001's
      pageMetadataSchema. Renderer plugins can write here too. */
  plugins: Record<string, unknown>;
}
```

This metadata is regenerated on every page save, in the same
transaction as the body update.

### Save-time vs view-time pipeline

The split between save and view is critical:

| Phase | Triggered by | What happens |
|---|---|---|
| Edit (Yjs sync) | Every keystroke (debounced inside CodeMirror) | Y.Text update propagates to peers. No render, no cache, no metadata extraction. |
| Save | Explicit save (RFC-0003) | Markdown → AST → render → `Revision.renderedAst` + `Revision.metadata` persisted. Cache for embeds populated/refreshed. All in one transaction. |
| View | Reader opens page | `Revision.renderedAst` → hast → JSX runtime. Cached embed HTML inlined. Stale-while-revalidate may fire background refreshes. |

This is what allows real-time collaborative editing without thrashing
external APIs: editors only see placeholders, and renders only happen
on save boundaries. See RFC-0003 for the editing side.

### Save transaction contract (for RFC-0003)

Page save must run the renderer pipeline **synchronously, in the same
transaction as the body update**. The contract:

```
beginTransaction:
  1. Page.body = newMarkdown
  2. Create Revision with body = newMarkdown
  3. Run parse → transform → render pipeline
  4. Revision.renderedAst = output
  5. Revision.metadata = extracted metadata
  6. Revision.rendererVersion = current pipeline semver
  7. Update PluginRenderCache for embeds (mode='save')
commitTransaction
```

If any step fails, the transaction rolls back; no partial state.

RFC-0003 must wire its save flow to invoke this pipeline. The
Hocuspocus `onStoreDocument` hook (or whichever save trigger) calls
the core's `Revision.prepareRevision()` helper, which encapsulates
this transaction.

## v1.x → v2.1 migration

### Internal link syntax

Crowi v1 supported `</path/to/page>` as an internal link. This is
NOT supported by `@crowi/plugin-renderer-crowi-legacy`. Instead, a
migration command rewrites all occurrences in the page body:

```
</docs/api> → [[/docs/api]]
```

Command:

```bash
crowi-admin wikilink-migrate --dry-run
crowi-admin wikilink-migrate
```

Detection rule (to avoid false positives with HTML self-closing tags):
- Starts with `</`
- Followed by `/` (path-style)
- No whitespace until `>`
- The "tag name" doesn't match a known HTML element

The command framework that registers and orchestrates this (and
`renderer:rebuild`, and future migrations) is **deferred to RFC-0008**.

### Renderer rebuild

After v1.x → v2.1 upgrade, existing revisions have no `renderedAst`.
Run `crowi-admin renderer rebuild` to populate it. Until rebuild
completes, pages fall back to a runtime parse-on-read path (slower
but functional). Once rebuilt, views serve from `renderedAst`.

### Markdown Fixer

`@crowi/plugin-renderer-crowi-legacy` re-enables:

- Crowi v1's specific line-break interpretation.
- Title extraction from the first H1.
- Other quirks documented in `LEGACY.md` of that plugin.

Default state:
- **Migrated install**: plugin is enabled.
- **Fresh install**: plugin is disabled.
- Operators can toggle from admin UI.

### MathJax → KaTeX

The MathJax-based math renderer in v1 had global-namespace pollution
issues. v2.1 ships `@crowi/plugin-renderer-katex`. Math syntax
unchanged. No data migration required.

### PlantUML / Mermaid coexistence

v1 supported PlantUML via a configured PlantUML server. v2.1 splits
this into two plugins so operators can pick:

- `@crowi/plugin-renderer-plantuml`: requires PlantUML server URL.
- `@crowi/plugin-renderer-mermaid`: zero-dependency, server-renders
  to SVG.

Both can be enabled simultaneously.

## Resolved decisions

1. **URL handling** → Auto-link is core/always-on. Inline expansion
   is plugin-driven (no syntax change). Card embed requires explicit
   `@[card](url)` syntax.
2. **Mention as core, not plugin** → `@username` is fundamental Wiki
   concept. Lives in core.
3. **Cache backend** → MongoDB `PluginRenderCache` collection.
4. **Cache key shape** → 4-tuple page-scoped.
5. **Authentication context** → Owner-provided tokens for v2.1,
   per-user deferred.
6. **Crowi v1 `</path>` syntax** → Migration command rewrites to
   `[[/path]]`. Not preserved by legacy plugin.
7. **Heading anchors** → Slug-based via `github-slugger`. Stability
   across renames not solved.
8. **Render artifact persistence** → `Revision.renderedAst` (mdast
   JSON, per-revision). Trade-off: historical fidelity preserved at
   cost of needing `renderer:rebuild` to apply fixes retroactively.
9. **Render mode enum** → `'save' | 'read' | 'view' | 'edit'`.
10. **Reservation optional** → Required only for I/O-bound plugins.
11. **Code block renderer return union** → `EmbedFragment | RenderResult`.
12. **Cache cleanup on uninstall** → Unconditional, not gated by `--purge`.
13. **Migration command framework** → Deferred to RFC-0008. v2.1 ships
    individual commands.

## Open questions

1. **Mention permission model.** When `@user` mentions a user the
   page-saver doesn't have permission to notify, do we silently drop,
   render but don't notify, or block the save? Likely "render but
   don't notify, log a warning". Defer to a sub-section of the
   notifier RFC.

2. **Heading anchor stability.** Slug-based IDs change when heading
   text changes, breaking external links. Options for a future RFC:
   - (a) Pure slug (current). Accept breakage; document it.
   - (b) Slug + alias table: store `{old-slug: new-slug}` per page.
   - (c) Stable UUIDs in heading metadata, slug as display.
   v2.1 ships (a).

3. **Bundled vs separate npm package for crowi-legacy.** Same
   structural question as RFC-0001's question 2.

4. **Autocomplete scope.** RFC-0004 will define autocomplete for
   `@user` and `[[Page` triggers. Should renderer plugins be able to
   contribute autocomplete sources? Lean no for v2.1.

5. **PlantUML SVG sanitization rigor.** Currently uses regex stripping
   (script / on*= / javascript: / foreignObject). DOMPurify-based
   sanitization is planned for Phase 6.1+. Open question: is
   regex-level rigor sufficient for v2.1 release, or should DOMPurify
   be a v2.1 blocker?

6. **Admin reconfigure of code-block renderers.** Currently the
   PlantUML server URL is closure-bound at registration time;
   admin reconfigure requires re-invoking `addCodeBlockRenderer` with
   last-wins + boot warning. Acceptable for v2.1 but worth revisiting
   if admin reconfigure becomes common.

## v2.1 release scope

In scope:

- `registerRenderer` extension on `@crowi/plugin-api`
- `RendererRegistry` interface with parse / transform / render / hydrate phases
- Reservation API + cache contract (MongoDB `PluginRenderCache`)
- `AuthContext` interface (stub in Phase 6, full impl in Phase 7)
- `Revision.renderedAst` + `Revision.metadata` persistence
- Bundled core renderers (syntax highlight, GFM, anchors, wikilinks, mentions, emoji, autolinks)
- `@crowi/plugin-renderer-katex` (Phase 6, landed)
- `@crowi/plugin-renderer-mermaid` (Phase 6.1)
- `@crowi/plugin-renderer-plantuml` (Phase 6, landed)
- `@crowi/plugin-renderer-github-embed` (Phase 7)
- `@crowi/plugin-renderer-crowi-legacy` (Phase 6, landed)
- `crowi-admin wikilink-migrate` command
- `crowi-admin renderer rebuild` command
- Page-save transaction contract
- Mention extraction (Phase 6); mention notifier dispatch (Phase 8)

Out of scope (deferred to later RFCs):

- `@crowi/plugin-renderer-slack-embed`
- `@crowi/plugin-renderer-d2`, `excalidraw`
- Per-user OAuth token forwarding to renderers
- Per-user renderer preferences
- Editor-side preview of async embeds
- Anchor stability via UUIDs or alias tables
- Two-tier cache (Redis hot + Mongo cold)
- Real-time co-editing concerns (see RFC-0003)
- **Generic migration command framework (RFC-0008)**

## Implementation notes

These are recorded for posterity — they describe the current
implementation rather than the contract. Future implementations are
free to deviate, provided the contract above is honoured.

### Dependency loading: jiti

The renderer pipeline depends on several ESM-only packages: `unified`,
`remark-*`, `shiki`, `remark-breaks`, `remark-emoji`, `remark-math`,
etc. The Crowi server runs as CommonJS (Express + Jest), so these
modules are loaded via [`jiti`](https://github.com/unjs/jiti) at
runtime. Both the api server and individual plugins use jiti to load
ESM dependencies synchronously where needed.

### Shiki bundled language set

Shiki ships with ~150 languages by default. Loading the full set via
jiti triggers a `_html.default is not iterable` error in Jest, causing
140+ tests to fail. The implementation restricts the bundled set to
24 commonly-used languages (TypeScript, JavaScript, Python, Go, Rust,
Ruby, Java, Kotlin, Swift, C/C++, C#, PHP, Shell, JSON, YAML, TOML,
Markdown, HTML, CSS, SQL, Dockerfile, Nginx, Terraform, GraphQL).
Adding a language requires a code change.

### `hast-util-raw` requirement

Plugins emit raw HTML (shiki's syntax-highlighted output, embed cards,
KaTeX output) as `html` nodes inside the mdast tree. Without
`hast-util-raw` in the view-time pipeline, `allowDangerousHtml: true`
alone causes these nodes to be stripped silently. The Web tier MUST
invoke `mdast-util-to-hast` → `hast-util-raw` → `hast-util-to-jsx-runtime`
in that order.

### `passNode: false` on `hast-util-to-jsx-runtime`

The default `passNode: true` leaks `node="[object Object]"` attributes
into the DOM via React. Setting `passNode: false` is required.

### PlantUML SVG sanitization

Phase 6 implementation uses regex stripping for `<script>`,
`on*=` event handlers, `javascript:` URIs, and `<foreignObject>`.
A DOMPurify-based replacement is planned for Phase 6.1+. The regex
implementation is documented as a deliberate temporary measure.

### Code block renderer return type

`addCodeBlockRenderer` returns `EmbedFragment | RenderResult` (union):

- `EmbedFragment`: simple synchronous result, inlined into the
  revision's `renderedAst`. Used by KaTeX, emoji-style renderers.
- `RenderResult`: cache-aware, supports error states. Used by
  PlantUML (server fetch), future Mermaid (CPU-bound).

The renderer chooses based on whether the operation does I/O or has
failure modes worth caching.

### Inline code styling

Inline code (` `code` `) renders with `font-mono + text-foreground`
only (no `bg-muted/70 pill` background). This is a deliberate UX
choice for visual quietness, set per user feedback during Phase 4.

### Shiki output Tailwind integration

Shiki produces `<pre class="shiki ...">` with inline color styles.
The Web tier applies `@apply bg-muted/60! border ...` via
`.crowi-prose pre.shiki` to harmonise with the surrounding "normal
codeblock" appearance. PHP's `meta.embedded.block.php` pink band is
suppressed via `span { background-color: transparent !important; }`
under `.crowi-prose pre.shiki`.

### Shiki cold-load warmup

The first shiki invocation is slow (loading themes + languages). The
implementation calls a no-op highlight in `Crowi.init()` as a
fire-and-forget warmup so the first user-triggered render is fast.

## Implementation plan (informational, reflects Phase 1–6 status)

1. **Phase 1 (done)**: `registerRenderer` + `RendererRegistry`
   interfaces, parse/transform skeleton, stale revision detection.
2. **Phase 2 (done)**: 4 bundled core transforms (toc, wikilinks,
   mentions, codeBlockLanguages). Mention extraction lands here; the
   dispatcher itself is Phase 8.
3. **Phase 3 (done)**: SSR HTML generation with shiki, mdast → hast
   → JSX pipeline, `Revision.renderedAst` persistence.
4. **Phase 4 (done)**: Cache contract (MongoDB), reservation API,
   stale-while-revalidate, in-flight de-dup, error caching.
   `addEmbedTag` / `addUrlInlineExpander` / `addCodeBlockRenderer`
   registry plumbing.
5. **Phase 5 (done)**: crowi-legacy plugin + wikilink migrator.
6. **Phase 5.1 (done)**: `renderer:rebuild` batch command for
   populating missing `renderedAst`.
7. **Phase 6 (done)**: PlantUML, emoji, KaTeX plugins.
8. **Phase 6.1**: Mermaid plugin (server-side SVG SSR, heavier
   dependency). Split from Phase 6 because of dependency weight.
   DOMPurify upgrade for PlantUML SVG sanitization.
9. **Phase 7**: `AuthContext` full implementation. GitHub Embed
   plugin (cache + auth + reservation end-to-end). Admin UI
   token-scope guidance.
10. **Phase 8**: Mention notifier dispatch — wire `Revision.metadata.mentions[]`
    extraction to RFC-0001's `registerNotifier` via internal
    dispatcher. Coordinate with RFC-0001's notifier RFC reopening if
    needed.

### Currently out of release scope (per Phase plan)

- Slack embed plugin
- Per-user OAuth tokens
- Migration command framework (→ RFC-0008)
