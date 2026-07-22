import type {
  AuthContext,
  CodeBlockRenderer,
  EmbedRenderer,
  NodeRenderer,
  PluginLogger,
  RenderPhase,
  RendererRegistry,
  UrlInlineExpansionRule,
} from '@crowi/plugin-api';

/**
 * Boot-time validation for `addStylesheet(path)` (feature-renderer-
 * plugin-boundary spec §2.1). `path` must be an API-relative absolute
 * path confined to the registering plugin's own route namespace —
 * `/api/v2/plugins/<registeringPlugin>/…`, the exact prefix
 * `makePluginRouterScope` mounts that plugin's HTTP routes under
 * (`packages/api/src/plugin/registries.ts`). Query / fragment are
 * allowed (e.g. a cache-busting `?v=…`); a URL scheme, protocol-relative
 * `//host`, backslash, `..` path segment, or a path outside the
 * plugin's own namespace all throw synchronously — a misbehaving
 * plugin's `registerRenderer` fails at boot instead of silently
 * publishing an unreachable / cross-plugin / off-origin manifest entry.
 *
 * The `..`-segment and namespace-prefix checks run on BOTH the raw
 * pathname AND its percent-decoded form (defense in depth) — checking
 * only the raw form would let a path like
 * `/api/v2/plugins/my-plugin/%2e%2e/other-plugin/style.css` through: it
 * has no literal `..` segment and satisfies the raw prefix check, but a
 * consumer that percent-decodes the path (as browsers / HTTP servers
 * routinely do) resolves it to `/api/v2/plugins/other-plugin/style.css`,
 * escaping the registering plugin's own namespace. Malformed percent-
 * encoding (a decode that throws) is rejected outright rather than
 * silently falling back to the raw form.
 */
function validateStylesheetPath(path: string, registeringPlugin: string): string {
  if (path.includes('\\')) {
    throw new Error(`Plugin '${registeringPlugin}' registered an invalid stylesheet path (contains a backslash): '${path}'`);
  }
  if (path.startsWith('//')) {
    throw new Error(`Plugin '${registeringPlugin}' registered a protocol-relative stylesheet path (must be API-relative): '${path}'`);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    throw new Error(`Plugin '${registeringPlugin}' registered a stylesheet path with a URL scheme (must be API-relative): '${path}'`);
  }
  const [pathname] = path.split(/[?#]/, 1);
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    throw new Error(`Plugin '${registeringPlugin}' registered a stylesheet path with malformed percent-encoding: '${path}'`);
  }
  if (pathname.split('/').includes('..') || decodedPathname.split('/').includes('..')) {
    throw new Error(`Plugin '${registeringPlugin}' registered a stylesheet path with a '..' traversal segment: '${path}'`);
  }
  const requiredPrefix = `/api/v2/plugins/${registeringPlugin}/`;
  if (!pathname.startsWith(requiredPrefix) || !decodedPathname.startsWith(requiredPrefix)) {
    throw new Error(`Plugin '${registeringPlugin}' registered a stylesheet path outside its own route namespace ('${requiredPrefix}'): '${path}'`);
  }
  return path;
}

/**
 * Registry implementation that backs the unified.js pipeline. The
 * runtime constructs **one** of these per Crowi instance:
 *   - the bundled core renderer registers its 5 transforms first;
 *   - then `PluginManager.activate()` calls every plugin's
 *     `registerRenderer(scope, ctx)` with a per-plugin scope that
 *     forwards into this same impl.
 *
 * Phase 4 + 6 honours:
 *   - `addUnifiedPlugin({ phase: 'transform' })`
 *   - `addNodeRenderer`
 *   - `addEmbedTag` (last-wins + boot warn on collision)
 *   - `addUrlInlineExpander` (registration-order list)
 *   - `addCodeBlockRenderer` (last-wins + boot warn on collision —
 *     Phase 6 lit this up alongside the bundled PlantUML plugin)
 *
 * feature-renderer-plugin-boundary Phase 1 adds:
 *   - `addStylesheet` — staged in a per-plugin pending set at
 *     `registerRenderer` time, published to `getStylesheets()` only
 *     once `commitStylesheets(plugin)` runs (called from
 *     `mountPluginRoutes`, `packages/api/src/hono/index.ts`, right
 *     after that SAME plugin's `registerRoutes` returns without
 *     throwing). `dropPendingStylesheets(plugin)` discards the whole
 *     pending set on a `registerRoutes` failure.
 */
export class RendererRegistryImpl {
  private unifiedTransform: { plugin: unknown; registeringPlugin: string }[] = [];
  private nodeRenderers = new Map<string, { renderer: NodeRenderer; registeringPlugin: string }[]>();
  private embedTags = new Map<string, { plugin: string; renderer: EmbedRenderer }>();
  private codeBlockRenderers = new Map<string, { plugin: string; renderer: CodeBlockRenderer }>();
  private urlExpanders: { plugin: string; rule: UrlInlineExpansionRule }[] = [];
  /** Per-plugin staged stylesheet paths, not yet published — see the class doc comment. */
  private pendingStylesheets = new Map<string, string[]>();
  /** Published stylesheet manifest, in commit order, deduped. Read by `GET /api/v2/app/info`. */
  private stylesheets: string[] = [];

  /** Snapshot of registered transform-phase unified plugins, in registration order. */
  getTransformPlugins(): readonly unknown[] {
    return this.unifiedTransform.map((entry) => entry.plugin);
  }

  /** Snapshot of node renderers for a given mdast type, in registration order. */
  getNodeRenderers(type: string): readonly NodeRenderer[] {
    return (this.nodeRenderers.get(type) ?? []).map((entry) => entry.renderer);
  }

  /** All registered node-renderer types — used by the pipeline walker. */
  getRegisteredNodeTypes(): readonly string[] {
    return Array.from(this.nodeRenderers.keys());
  }

  /** Look up an embed-tag renderer by tag. Returns undefined when no plugin registered the tag. */
  getEmbedTag(tag: string): { plugin: string; renderer: EmbedRenderer } | undefined {
    return this.embedTags.get(tag);
  }

  /** Look up a code-block renderer by lang. Returns undefined when no plugin registered the lang. */
  getCodeBlockRenderer(lang: string): { plugin: string; renderer: CodeBlockRenderer } | undefined {
    return this.codeBlockRenderers.get(lang);
  }

  /** True when at least one code-block renderer is registered — dispatch can short-circuit on empty. */
  hasCodeBlockRenderers(): boolean {
    return this.codeBlockRenderers.size > 0;
  }

  /** Snapshot of URL inline-expanders, in registration order. */
  getUrlInlineExpanders(): readonly { plugin: string; rule: UrlInlineExpansionRule }[] {
    return this.urlExpanders;
  }

  addUnifiedPlugin(plugin: unknown, registeringPlugin: string, log: PluginLogger, options?: { phase?: RenderPhase }): void {
    const phase = options?.phase ?? 'transform';
    if (phase !== 'transform') {
      log.warn(`addUnifiedPlugin phase='${phase}' is not yet implemented in v2.0 — discarding registration`);
      return;
    }
    this.unifiedTransform.push({ plugin, registeringPlugin });
  }

  addNodeRenderer(type: string, renderer: NodeRenderer, registeringPlugin: string): void {
    const list = this.nodeRenderers.get(type) ?? [];
    list.push({ renderer, registeringPlugin });
    this.nodeRenderers.set(type, list);
  }

  /**
   * Last-wins on collision. The first registrant's entry is replaced
   * and we emit a boot warn so the operator sees the conflict in the
   * server log. RFC §"Plugin tag collision" — we explicitly chose
   * last-wins over fail-on-collision because plugin install order is
   * resolved by topo sort and an operator's `crowi.config.json`
   * shouldn't have to be re-ordered to recover from a misnamed tag.
   */
  addEmbedTag(name: string, renderer: EmbedRenderer, registeringPlugin: string, log: PluginLogger): void {
    const existing = this.embedTags.get(name);
    if (existing) {
      log.warn(`[renderer] embed-tag collision on '${name}': plugin '${existing.plugin}' is being overridden by '${registeringPlugin}' (last-wins)`);
    }
    this.embedTags.set(name, { plugin: registeringPlugin, renderer });
  }

  /**
   * Phase 6: last-wins on collision, mirror of `addEmbedTag`. The boot
   * warn surfaces the conflict so an operator can either fix the
   * misnamed lang or accept the override.
   */
  addCodeBlockRenderer(lang: string, renderer: CodeBlockRenderer, registeringPlugin: string, log: PluginLogger): void {
    const existing = this.codeBlockRenderers.get(lang);
    if (existing) {
      log.warn(`[renderer] code-block-renderer collision on '${lang}': plugin '${existing.plugin}' is being overridden by '${registeringPlugin}' (last-wins)`);
    }
    this.codeBlockRenderers.set(lang, { plugin: registeringPlugin, renderer });
  }

  addUrlInlineExpander(rule: UrlInlineExpansionRule, registeringPlugin: string): void {
    this.urlExpanders.push({ plugin: registeringPlugin, rule });
  }

  /**
   * Stage a stylesheet path in `registeringPlugin`'s pending set (see
   * class doc comment). Validates + throws synchronously
   * (`validateStylesheetPath`) rather than warn-and-discard: an invalid
   * path is a plugin bug, not an operator-recoverable condition, so it
   * should fail the plugin's `registerRenderer` call the same way a
   * malformed `configSchema` fails `activate()`. Duplicate paths (same
   * plugin, same string) are a silent no-op.
   */
  addStylesheet(path: string, registeringPlugin: string): void {
    const validated = validateStylesheetPath(path, registeringPlugin);
    const pending = this.pendingStylesheets.get(registeringPlugin) ?? [];
    if (!pending.includes(validated)) {
      pending.push(validated);
    }
    this.pendingStylesheets.set(registeringPlugin, pending);
  }

  /**
   * Publish `registeringPlugin`'s pending stylesheets to the public
   * manifest. Called from `mountPluginRoutes` immediately after that
   * plugin's OWN `registerRoutes(scope, ctx)` call returns without
   * throwing — see the class doc comment for why commit is gated on
   * that specific signal. A plugin with nothing pending (never called
   * `addStylesheet`, or already committed) is a no-op.
   */
  commitStylesheets(registeringPlugin: string): void {
    const pending = this.pendingStylesheets.get(registeringPlugin);
    if (!pending) return;
    for (const path of pending) {
      if (!this.stylesheets.includes(path)) {
        this.stylesheets.push(path);
      }
    }
    this.pendingStylesheets.delete(registeringPlugin);
  }

  /**
   * Discard `registeringPlugin`'s ENTIRE pending set (never a partial
   * commit) — called from `mountPluginRoutes` when that plugin's
   * `registerRoutes` throws, so the public manifest never advertises a
   * path whose route failed to mount.
   */
  dropPendingStylesheets(registeringPlugin: string): void {
    this.pendingStylesheets.delete(registeringPlugin);
  }

  /** Published stylesheet manifest, in commit order, deduped — read by `GET /api/v2/app/info`. */
  getStylesheets(): readonly string[] {
    return this.stylesheets;
  }
}

/**
 * Phase 4 stub for `AuthContext`. The interface is finalised in
 * `@crowi/plugin-api`; the implementation lands in Phase 7 alongside
 * encrypted-config plumbing for the GitHub Embed plugin.
 *
 * Phase 6 no-I/O plugins (PlantUML / KaTeX / Mermaid / emoji) must
 * NOT call `config()` — they have no external auth needs. The thrown
 * error here will surface accidental coupling immediately.
 */
export const createAuthContextStub = (): AuthContext => ({
  config: () => {
    throw new Error('AuthContext not yet implemented — Phase 7');
  },
});

/**
 * Per-plugin scope handed to `registerRenderer(scope, ctx)`. Closes
 * over the registering plugin's name and logger so the impl can
 * attribute warnings without the plugin threading them on every call.
 */
export const makeRendererScope = (registry: RendererRegistryImpl, plugin: string, log: PluginLogger): RendererRegistry => ({
  addUnifiedPlugin: (plugin_, options) => registry.addUnifiedPlugin(plugin_, plugin, log, options),

  addNodeRenderer: (type, renderer) => registry.addNodeRenderer(type, renderer, plugin),

  // Phase 6: live. Last-wins + boot warn on collision (mirror of
  // addEmbedTag). PlantUML is the first user; Mermaid (Phase 6.1) and
  // any future code-block plugin will share this path.
  addCodeBlockRenderer: (lang: string, renderer: CodeBlockRenderer) => registry.addCodeBlockRenderer(lang, renderer, plugin, log),

  addEmbedTag: (name: string, renderer: EmbedRenderer) => registry.addEmbedTag(name, renderer, plugin, log),

  addUrlInlineExpander: (rule: UrlInlineExpansionRule) => registry.addUrlInlineExpander(rule, plugin),

  // feature-renderer-plugin-boundary Phase 1 — staged only; committed by
  // `mountPluginRoutes` once this SAME plugin's `registerRoutes` succeeds.
  addStylesheet: (path: string) => registry.addStylesheet(path, plugin),
});
