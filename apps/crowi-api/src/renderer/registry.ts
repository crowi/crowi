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
 */
export class RendererRegistryImpl {
  private unifiedTransform: { plugin: unknown; registeringPlugin: string }[] = [];
  private nodeRenderers = new Map<string, { renderer: NodeRenderer; registeringPlugin: string }[]>();
  private embedTags = new Map<string, { plugin: string; renderer: EmbedRenderer }>();
  private codeBlockRenderers = new Map<string, { plugin: string; renderer: CodeBlockRenderer }>();
  private urlExpanders: { plugin: string; rule: UrlInlineExpansionRule }[] = [];

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
      log.warn(`addUnifiedPlugin phase='${phase}' is not yet implemented in v2.1 — discarding registration`);
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
});
