# RFC-0002: Renderer Plugin Architecture

- **Status**: Draft (round 2 — review feedback integrated)
- **Target**: Crowi 2.1 release
- **Owner**: TBD
- **Last updated**: 2026-05-10
- **Depends on**: RFC-0001 (Plugin Architecture)

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
- **Stable plugin API across the v2.x line**. Renderer plugins authored
  against `@crowi/plugin-api@2.x` keep working through every v2 minor.

## Non-goals (this RFC)

- WYSIWYG editor extensibility. The editor uses a single core engine
  (CodeMirror 6 + Markdown decorations, per RFC-0003) that is not
  pluggable.
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

## Overview

```
┌──────────────── Markdown source (Yjs Y.Text) ───────┐
│   # Title                                           │
│   Some text with @[card](https://github.com/...)    │
│   ```mermaid ... ```                                │
└──────────┬──────────────────────────────────────────┘
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
           │  render phase  (server-side, produces HTML)
           │  - core node renderers
           │  - plugin node renderers
           │  - embed renderers (with cache lookup)
           │  - reservation API for async embeds
           ▼
┌─────────────────── HTML + metadata ────────────────┐
│   stored in Page.renderedHtml + Page.metadata      │
│   embed cache stored in PluginRenderCache          │
└──────────┬─────────────────────────────────────────┘
           │
           │  hydrate phase  (client-side, optional)
           │  - syntax highlight is already done (no hydrate)
           │  - mermaid is already SVG (no hydrate)
           │  - GitHub card "refresh" button (hydrate yes)
           ▼
┌──────────────── Rendered page in browser ──────────┐
```

The four phases — **parse**, **transform**, **render**, **hydrate** —
are the only extension points. Plugins declare which phases they
participate in.

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
   * Render a specific MDAST node type to HTML.
   * If multiple plugins register for the same node type, the last
   * registration wins (with a boot-time warning).
   */
  addNodeRenderer<T extends MdastNodeType>(
    nodeType: T,
    renderer: NodeRenderer<T>
  ): void;

  /**
   * Render a fenced code block with a specific language tag.
   * e.g. ```mermaid, ```plantuml, ```math
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
```

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

### Reservation API

Async-data renderers (anything that fetches over the network) MUST
declare a layout reservation, and the core uses it during the render
phase to emit a stable-sized placeholder.

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
   * Layout reservation. The placeholder rendered during editing,
   * and the server-rendered output if cache is empty, both honour
   * this reservation.
   */
  reservation:
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
      /** Custom placeholder. Core provides a generic one if omitted. */
      placeholderHtml?: string;
    };

export interface RenderContext {
  /** Per-page cache. Scoped to (pluginName, pageId, cacheKey). */
  cache: CacheStorage;
  /** Whether this render is for editing (placeholders only) or viewing. */
  mode: 'edit' | 'view';
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

### Edit mode vs view mode

The core invokes the renderer differently depending on mode:

- **`mode: 'edit'`** — The render call returns immediately with a
  placeholder of the declared `reservation` size. No `render` callback
  is invoked. The placeholder is interactive: clicking it triggers
  a one-shot `mode: 'view'` render for that specific embed.
- **`mode: 'view'`** — Cache is consulted first. On hit, cached HTML
  is returned immediately and (if past `cacheTtlSec`) a background
  refresh kicks off. On miss, `render` (or `renderBatch`) is awaited;
  result is cached.

This split is what eliminates layout shift during real-time editing
and on page view.

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
   */
  config: <S extends z.ZodTypeAny>() => z.infer<S>;
}
```

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
  add to `Page.metadata.mentions[]` for the notifier hook. Implemented
  in core, NOT as a plugin (mention is a fundamental Wiki concept,
  per RFC-0001's reasoning for keeping local-password auth in core).
- **Heading anchor IDs**: every `heading` node gets an `id` attribute
  via `github-slugger`. Duplicates get `-1`, `-2` suffixes.

Transform plugins receive the parsed MDAST and return a new MDAST.

## Phase: render

MDAST → HTML. Core renderers handle the standard CommonMark + GFM node
types. Plugins can override or extend via `addNodeRenderer`.

Renderer plugins for code blocks (`addCodeBlockRenderer`), embed tags
(`addEmbedTag`), and inline URL expansion (`addUrlInlineExpander`) are
the most common; raw `addNodeRenderer` is reserved for advanced cases.

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
  pluginName: string;       // e.g. "@crowi/plugin-renderer-github-embed"
  pluginCacheVersion: number; // EmbedRenderer.cacheVersion at time of write
  pageId: string;           // page-scoped: page deletion → cleanup
  embedKey: string;         // sha256 of input (default) or plugin-supplied
}
```

**Why page-scoped?** Naively keying only by `(plugin, input)` shares
cache entries across pages. Pros: memory savings if the same URL is
embedded in many pages. Cons: cleanup on page deletion requires a
reverse-index lookup ("does any other page still reference this?").
Page-scoped keys mean page deletion → straightforward `deleteMany({pageId})`.

The downside (duplicate cache entries when the same URL appears in
many pages) is acceptable: realistic worst case ~100 duplicates,
~500KB of duplication, negligible vs. the simplicity gain.

### Cache entry shape

```ts
export interface CacheEntry {
  html: string;
  fetchedAt: Date;
  expiresAt: Date;          // TTL index field
  result: RenderResult;     // includes error code if failed (kind: 'error')
}
```

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
  embedKey: string,         // sha256 hex
  html: string,
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

When a view-mode render hits a cache entry past `cacheTtlSec` but
within `staleAfterSec`:

1. Return the cached HTML immediately.
2. Spawn a background task to re-render with `mode: 'view'` and
   write the new result.
3. Next viewer gets fresh HTML.

When past `staleAfterSec`:

1. Return cached HTML with a `data-stale="true"` attribute (CSS can
   show a small indicator).
2. Block on re-render for the next request — better to wait than
   to keep serving truly stale data.

When cache miss:

1. Invoke `render` (or `renderBatch`) synchronously, await result.
2. Cache the output.
3. Return.

### Cache invalidation triggers

| Trigger | Effect |
|---|---|
| Page save | All cache entries for `pageId` are re-rendered (synchronously, in the save transaction) |
| Page delete | `invalidatePage(pageId)` |
| Plugin uninstall (RFC-0001's `--purge` flag) | `invalidatePlugin(pluginName)` |
| Plugin upgrade with `cacheVersion` bump | Entries with old `pluginCacheVersion` ignored on read; TTL eventually evicts them |
| Admin "Clear render cache" button | `invalidateAll()` |
| TTL expiry | Background eviction by MongoDB TTL index |

### Error handling

Plugin renders fail in well-defined ways. Each error code has a
default core behaviour:

| Code | Default cache TTL | Default behaviour |
|---|---|---|
| `auth` | 60s (avoid hammering during misconfiguration) | Surface in admin UI as "Plugin authentication failed" |
| `rate_limit` | `retryAfterSec` if provided, else 5 min | Pause all renders for that plugin until retry-after |
| `not_found` | 1 hour (resource unlikely to come back soon) | Show "resource not found" placeholder |
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
| Syntax highlight | code-block | Shiki, server-side, no hydrate |
| GFM tables | unified plugin | `remark-gfm` |
| Task lists | unified plugin | `remark-gfm` |
| Heading anchors | transform | `github-slugger`, also extracts to `Page.metadata.toc` |
| Wikilinks | transform | `[[Page]]` resolution |
| Mentions | transform | `@user` extraction, hooks notifier |
| Emoji | transform | `:smile:` → 😀 via `node-emoji` |
| Bare URL → autolink | transform | CommonMark autolink, no embed |

### Optional plugins (separate npm packages)

| Plugin | Provides | Auth required? |
|---|---|---|
| `@crowi/plugin-renderer-katex` | `$inline$` and `$$block$$` math via KaTeX (server-side) | No |
| `@crowi/plugin-renderer-mermaid` | ` ```mermaid ` server-side rendered to SVG | No |
| `@crowi/plugin-renderer-plantuml` | ` ```plantuml ` rendered via PlantUML server (configurable URL) | Optional (PlantUML server) |
| `@crowi/plugin-renderer-github-embed` | `@[github-pr](url)`, `@[github-issue](url)`, plus inline URL expansion for `github.com/*` URLs | GitHub PAT (owner-provided) |
| `@crowi/plugin-renderer-slack-embed` | `@[slack](url)` thread expansion | Slack token (owner-provided) |
| `@crowi/plugin-renderer-crowi-legacy` | Bundled but default-off. Re-enables Crowi v1 rendering quirks (Markdown Fixer, line break handling). Migration users turn on via admin UI | No |

## Phase: hydrate

Most rendered content needs no client-side JS — syntax-highlighted code
is already styled HTML, Mermaid is already an inlined SVG, math is
already laid out. The hydrate phase exists for the small set of
embeds that need interactivity (e.g. a "refresh" button on a stale
GitHub PR card).

```ts
export interface NodeRenderer<T> {
  render(node: MdastNode<T>, ctx: RenderContext): Promise<RenderResult>;
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

## Page metadata extraction

Renderer phases produce HTML, but they ALSO produce structured
metadata as a side effect, persisted on the `Page` document:

```ts
interface PageMetadata {
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
    target: string;       // resolved page path
    displayText?: string;
  }>;

  /** Generated by the mention transform. Consumed by the notifier
      registry from RFC-0001 to send notifications. */
  mentions: Array<{ username: string }>;

  /** Generated by code block parsing. Used for search filters and
      analytics ("how many pages use Mermaid?"). */
  codeBlockLanguages: string[];

  /** Per-plugin metadata namespace, same shape as RFC-0001's
      pageMetadataSchema. Renderer plugins can write here too. */
  plugins: Record<string, unknown>;
}
```

This metadata is regenerated on every page save, in the same
transaction as the page body update. Render-phase output (HTML) is
ALSO regenerated and persisted at save time, so view-mode requests
never have to re-render from scratch.

### Edit-time vs save-time work

The split between edit and save is critical:

| Phase | Triggered by | What happens |
|---|---|---|
| Edit (Yjs sync) | Every keystroke (debounced inside CodeMirror) | Y.Text update propagates to peers. No render, no cache, no metadata extraction. |
| Save | Debounced idle (~30s) or explicit save | Markdown → AST → render → HTML + metadata persisted. Cache for embeds populated/refreshed. `PageHtmlUpdated` event emitted to viewers. |
| View | Reader opens page | Cached HTML served. Stale-while-revalidate may fire background refreshes. |

This is what allows real-time collaborative editing without thrashing
external APIs: editors only see placeholders, and renders only happen
on save boundaries. See RFC-0003 for the editing side of this contract.

## v1.x → v2.1 migration

### Internal link syntax

Crowi v1 supported `</path/to/page>` as an internal link. This is
NOT supported by `@crowi/plugin-renderer-crowi-legacy`. Instead,
`crowi-admin migrate --only=wikilink` rewrites all occurrences in
the page body:

```
</docs/api> → [[/docs/api]]
```

Migration steps:

1. Run `crowi-admin migrate --dry-run --only=wikilink` to preview.
2. Inspect output (which pages, how many occurrences).
3. Run `crowi-admin migrate --only=wikilink` to apply.

Detection rule (to avoid false positives with HTML self-closing tags):
- Starts with `</`
- Followed by `/` (path-style)
- No whitespace until `>`
- The "tag name" doesn't match a known HTML element

### Markdown Fixer

`@crowi/plugin-renderer-crowi-legacy` re-enables:

- Crowi v1's specific line-break interpretation (single newlines
  become `<br>`, GFM-incompatible).
- Title extraction from the first H1.
- Other quirks documented in `LEGACY.md` of that plugin.

Default state:
- **Migrated install** (v1.x → v2.x → v2.1): plugin is enabled.
- **Fresh install**: plugin is disabled.
- Operators can toggle from admin UI.

### MathJax → KaTeX

The MathJax-based math renderer in v1 had global-namespace pollution
issues. v2.1 ships `@crowi/plugin-renderer-katex` (no global state,
SSR-capable). Math syntax (`$...$`, `$$...$$`) is unchanged. No data
migration required; existing math content renders identically.

### PlantUML / Mermaid coexistence

v1 supported PlantUML via a configured PlantUML server. v2.1 splits
this into two plugins so operators can pick:

- `@crowi/plugin-renderer-plantuml`: requires PlantUML server URL,
  same shape as v1.
- `@crowi/plugin-renderer-mermaid`: zero-dependency, server-renders
  to SVG.

Both can be enabled simultaneously; they handle different code-block
languages.

## Resolved decisions (round 2 review)

1. **URL handling** → Auto-link is core/always-on. Inline expansion
   is plugin-driven (no syntax change). Card embed requires explicit
   `@[card](url)` or `@[<plugin-tag>](url)` syntax. No auto-card-on-
   standalone-URL behaviour, by deliberate departure from
   Slack/Discord/Zenn — surprise rendering is hostile in a Wiki context.
2. **Mention as core, not plugin** → `@username` is a fundamental Wiki
   concept (cross-cutting render + notify + autocomplete) and lives in
   core, parallel to RFC-0001's decision to keep local-password auth
   in core.
3. **Cache backend** → MongoDB `PluginRenderCache` collection.
   Persistence and compound-query needs make Redis a poor fit despite
   already being in the stack. Two-tier (Redis hot + Mongo cold) is
   left as a future extension, behind the `CacheStorage` interface.
4. **Cache key shape** → Page-scoped: `(pluginName, pluginCacheVersion,
   pageId, embedKey)`. Cross-page sharing is rejected for the
   simplicity gain on page-deletion cleanup.
5. **Authentication context** → Owner-provided tokens for v2.1, with
   explicit operator warnings about the Wiki-permission-as-security-
   boundary implication. Per-user OAuth token forwarding is deferred
   to a v2.2+ RFC.
6. **Crowi v1 `</path>` syntax** → No legacy plugin support. Handled by
   one-shot `crowi-admin migrate --only=wikilink` data rewrite to
   `[[/path]]`.
7. **Heading anchors** → Slug-based via `github-slugger`. Stability
   across renames is not solved in v2.1; revisit if reports of broken
   external anchor links accumulate.

## Open questions

1. **Mention permission model.** When `@user` mentions a user the
   page-saver doesn't have permission to notify (e.g. a private user,
   or cross-tenant), do we silently drop, render but don't notify,
   or block the save? Likely "render but don't notify, log a
   warning". Defer to a sub-section of the notifier RFC.

2. **Heading anchor stability.** Slug-based IDs change when heading
   text changes, breaking external links. Options for a future RFC:
   - (a) Pure slug (current). Accept breakage; document it.
   - (b) Slug + alias table: store `{old-slug: new-slug}` per page,
     redirect old anchors. Adds complexity to the metadata pipeline.
   - (c) Stable UUIDs in heading metadata, slug as display.
     Best UX, but requires Markdown source to carry the UUID.
     Hostile to source-of-truth principle.
   v2.1 ships (a). Revisit if pain reports accumulate.

3. **Bundled vs separate npm package for crowi-legacy.** Same
   structural question as RFC-0001's question 2 (storage-local /
   search-mongo): bundled in `@crowi/server`, or a separate npm
   package that's just always installed by the runner? Lean
   "separate package, default-installed" for consistency with
   RFC-0001's eventual choice.

4. **Autocomplete scope.** RFC-0003 will define autocomplete for
   `@user` and `[[Page` triggers. Question: should renderer plugins
   be able to contribute autocomplete sources (e.g.
   `@crowi/plugin-renderer-github-embed` offering PR completion when
   the user types `@[github-pr](`)? Lean no for v2.1 — fixed core
   completions only — to avoid coupling RFC-0002 and RFC-0003.

## v2.1 release scope

In scope:

- `registerRenderer` extension on `@crowi/plugin-api`
- `RendererRegistry` interface and the four phases
- Reservation API + cache contract (MongoDB `PluginRenderCache`)
- `AuthContext` for owner-provided credentials
- Bundled core renderers (syntax highlight, GFM, anchors, wikilinks,
  mentions, emoji, autolinks)
- `@crowi/plugin-renderer-katex`
- `@crowi/plugin-renderer-mermaid`
- `@crowi/plugin-renderer-plantuml`
- `@crowi/plugin-renderer-github-embed` (with admin-UI scope guidance)
- `@crowi/plugin-renderer-crowi-legacy` (default-off for fresh, on for
  migrated)
- `crowi-admin migrate --only=wikilink` for `</...>` → `[[...]]`
- `Page.metadata` schema additions: `toc`, `wikiLinks`, `mentions`,
  `codeBlockLanguages`
- Page-save pipeline integration (HTML + metadata + embed cache
  regenerated together)

Out of scope (deferred to later RFCs):

- `@crowi/plugin-renderer-slack-embed` (deferred until Slack plugin
  is itself redesigned, see RFC-0001 open question 1)
- `@crowi/plugin-renderer-d2`, `excalidraw` (community demand
  hasn't emerged yet)
- Per-user OAuth token forwarding to renderers
- Per-user renderer preferences
- Editor-side preview of async embeds
- Anchor stability via UUIDs or alias tables
- Two-tier cache (Redis hot + Mongo cold)
- Real-time co-editing concerns (see RFC-0003)

## Implementation plan (informational, not part of the contract)

1. Ship `registerRenderer` and `RendererRegistry` interfaces in
   `@crowi/plugin-api`.
2. Build the core render pipeline in `@crowi/server`: parse →
   transform → render, with the cache contract and `CacheStorage`
   abstraction (MongoDB implementation).
3. Convert existing v1 syntax-highlight + GFM + emoji to use the
   new pipeline. Validate output parity with v1 on the test corpus.
4. Implement `Page.metadata` extraction; persist in the same
   transaction as the body update.
5. Build wikilink + mention transforms in core. Wire mentions into
   the notifier hook (RFC-0001).
6. Build inline URL expansion machinery in core (no-op without
   plugins).
7. Ship `@crowi/plugin-renderer-katex` + `@crowi/plugin-renderer-mermaid`
   (no I/O, simplest plugins to validate the contract).
8. Ship `@crowi/plugin-renderer-plantuml` (validates configurable
   external server contract).
9. Ship `@crowi/plugin-renderer-github-embed` (validates the cache +
   reservation API + AuthContext end-to-end).
10. Ship `@crowi/plugin-renderer-crowi-legacy`.
11. Ship the `crowi-admin migrate --only=wikilink` migrator.
12. Documentation: plugin author guide, migration notes for v1.x,
    operator guidance on token scopes.

Steps 7–10 can run in parallel after step 6 lands.
