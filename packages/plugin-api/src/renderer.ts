import type { PluginLogger } from './context';

/**
 * Renderer extension contract — type-only. Plugins contribute parse /
 * transform behaviour to the server-side markdown pipeline through
 * `registerRenderer(scope, ctx)`. The runtime owns the unified.js
 * pipeline; plugins push unified plugins, node renderers, code-block
 * renderers, embed renderers, and URL inline-expansion rules into the
 * passed `RendererRegistry`.
 *
 * Phase 2 of RFC-0002 covers `addUnifiedPlugin` + `addNodeRenderer`
 * (consumed by the bundled core renderer). `addCodeBlockRenderer`,
 * `addEmbedTag`, and `addUrlInlineExpander` are interface-exposed but
 * the v2.1 phase 2 implementation is a warn-noop — Phase 3 lights
 * them up.
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
 * `katex`). Phase 3 lights this up; Phase 2 stub-warns and discards
 * registrations.
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
 * Embed-tag renderer — invoked for legacy `[plugin-name:args]` /
 * `<plugin-name args>` style embeds. Phase 3 lights this up; Phase 2
 * stub-warns and discards registrations.
 */
export interface EmbedRenderer {
  (args: string, ctx: RenderContext): EmbedFragment | Promise<EmbedFragment>;
}

/**
 * URL inline-expansion rule — when an inline link target matches the
 * registered host / pattern, the plugin can inline-expand the link to
 * a richer fragment (e.g. GitHub issue card). Phase 3 lights this up;
 * Phase 2 stub-warns and discards registrations.
 */
export interface UrlInlineExpansionRule {
  /** Pattern the URL must match. RegExp or substring matcher. */
  match: RegExp | ((url: string) => boolean);
  /** Produce the expanded fragment. */
  expand: (url: string, ctx: RenderContext) => EmbedFragment | Promise<EmbedFragment>;
}

/**
 * The fragment a code-block / embed / url-expansion renderer produces.
 * Phase 2 only declares the type; the runtime never inspects it (the
 * stubs discard registrations). Phase 3 will define the SSR semantics.
 */
export interface EmbedFragment {
  /** Pre-sanitised HTML fragment to inline at the source position. */
  html: string;
  /** Optional `<head>`-bound assets (CSS / JS) keyed by URL. */
  assets?: { css?: string[]; js?: string[] };
}

/**
 * Context passed to every renderer callback. Phase 2 exposes only
 * `mode` and `log`; Phase 3 will add `cache` (PluginRenderCache) and
 * `auth` (AuthContext) without breaking the field names already in
 * use here.
 */
export interface RenderContext {
  /**
   * What the pipeline is being run for. `'save'` = persisting a new
   * revision (cache writes are appropriate); `'read'` = on-the-fly
   * fallback for an old revision (read-only). Phase 2 stubs all use
   * `'save'`.
   */
  mode: 'save' | 'read';
  /** Structured logger scoped to the registering plugin. */
  log: PluginLogger;
}

/**
 * The registry handed to every plugin's `registerRenderer(scope, ctx)`.
 * Each method tags the registration with the registering plugin so the
 * runtime can attribute warnings ("plugin X tried to register
 * something the runtime doesn't support yet").
 *
 * Phase 2 honours:
 *   - `addUnifiedPlugin(plugin, { phase: 'transform' })` — appends to
 *     the transform list AFTER the core 4 plugins.
 *   - `addNodeRenderer(type, renderer)` — appends to a per-type list.
 *
 * Phase 2 stubs (warn-noop):
 *   - `addCodeBlockRenderer`, `addEmbedTag`, `addUrlInlineExpander`.
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
   * Register a code-block renderer for a language tag. Phase 2 warns
   * and discards. Phase 3 lights this up.
   */
  addCodeBlockRenderer(lang: string, renderer: CodeBlockRenderer): void;

  /**
   * Register an embed-tag renderer (`[name:args]` / `<name args>`).
   * Phase 2 warns and discards. Phase 3 lights this up.
   */
  addEmbedTag(name: string, renderer: EmbedRenderer): void;

  /**
   * Register a URL inline-expansion rule. Phase 2 warns and discards.
   * Phase 3 lights this up.
   */
  addUrlInlineExpander(rule: UrlInlineExpansionRule): void;
}
