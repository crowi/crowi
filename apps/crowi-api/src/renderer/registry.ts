import type { CodeBlockRenderer, EmbedRenderer, NodeRenderer, PluginLogger, RenderPhase, RendererRegistry, UrlInlineExpansionRule } from '@crowi/plugin-api';

/**
 * Registry implementation that backs the unified.js pipeline. The
 * runtime constructs **one** of these per Crowi instance:
 *   - the bundled core renderer registers its 4 transforms first;
 *   - then `PluginManager.activate()` calls every plugin's
 *     `registerRenderer(scope, ctx)` with a per-plugin scope that
 *     forwards into this same impl.
 *
 * Phase 2 honours `addUnifiedPlugin({ phase: 'transform' })` (the only
 * supported phase) and `addNodeRenderer`. Other registrations log a
 * warning through the plugin's logger and discard the input — Phase 3
 * lights them up without contract surface change.
 */
export class RendererRegistryImpl {
  private unifiedTransform: { plugin: unknown; registeringPlugin: string }[] = [];
  private nodeRenderers = new Map<string, { renderer: NodeRenderer; registeringPlugin: string }[]>();

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

  addUnifiedPlugin(plugin: unknown, registeringPlugin: string, log: PluginLogger, options?: { phase?: RenderPhase }): void {
    const phase = options?.phase ?? 'transform';
    if (phase !== 'transform') {
      log.warn(`addUnifiedPlugin phase='${phase}' is not yet implemented in v2.1 phase 2 — discarding registration`);
      return;
    }
    this.unifiedTransform.push({ plugin, registeringPlugin });
  }

  addNodeRenderer(type: string, renderer: NodeRenderer, registeringPlugin: string): void {
    const list = this.nodeRenderers.get(type) ?? [];
    list.push({ renderer, registeringPlugin });
    this.nodeRenderers.set(type, list);
  }
}

/**
 * Per-plugin scope handed to `registerRenderer(scope, ctx)`. Closes
 * over the registering plugin's name and logger so the impl can
 * attribute warnings without the plugin threading them on every call.
 */
export const makeRendererScope = (registry: RendererRegistryImpl, plugin: string, log: PluginLogger): RendererRegistry => ({
  addUnifiedPlugin: (plugin_, options) => registry.addUnifiedPlugin(plugin_, plugin, log, options),

  addNodeRenderer: (type, renderer) => registry.addNodeRenderer(type, renderer, plugin),

  // Phase 2 stubs — interface is exposed so Phase 3 plugins type-check
  // against the final shape, but registrations are dropped with a
  // warning until the implementation lands.
  addCodeBlockRenderer: (lang: string, _renderer: CodeBlockRenderer) => {
    log.warn(`addCodeBlockRenderer('${lang}') is not yet implemented in v2.1 phase 2 — discarding registration`);
  },
  addEmbedTag: (name: string, _renderer: EmbedRenderer) => {
    log.warn(`addEmbedTag('${name}') is not yet implemented in v2.1 phase 2 — discarding registration`);
  },
  addUrlInlineExpander: (_rule: UrlInlineExpansionRule) => {
    log.warn('addUrlInlineExpander is not yet implemented in v2.1 phase 2 — discarding registration');
  },
});
