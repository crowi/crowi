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
 * Phase 4 honours:
 *   - `addUnifiedPlugin({ phase: 'transform' })`
 *   - `addNodeRenderer`
 *   - `addEmbedTag` (last-wins + boot warn on collision)
 *   - `addUrlInlineExpander` (registration-order list)
 *
 * Phase 4 stubs (warn-noop):
 *   - `addCodeBlockRenderer` (Phase 6 lights this up)
 */
export class RendererRegistryImpl {
  private unifiedTransform: { plugin: unknown; registeringPlugin: string }[] = [];
  private nodeRenderers = new Map<string, { renderer: NodeRenderer; registeringPlugin: string }[]>();
  private embedTags = new Map<string, { plugin: string; renderer: EmbedRenderer }>();
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

  // Phase 4 stub — Phase 6 lights this up alongside the bundled
  // PlantUML / KaTeX / Mermaid plugins.
  addCodeBlockRenderer: (lang: string, _renderer: CodeBlockRenderer) => {
    log.warn(`addCodeBlockRenderer('${lang}') is not yet implemented in v2.1 phase 4 — discarding registration (Phase 6)`);
  },

  addEmbedTag: (name: string, renderer: EmbedRenderer) => registry.addEmbedTag(name, renderer, plugin, log),

  addUrlInlineExpander: (rule: UrlInlineExpansionRule) => registry.addUrlInlineExpander(rule, plugin),
});
