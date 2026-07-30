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
 * `/api/plugins/<registeringPlugin>/…`, the exact prefix
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
 * `/api/plugins/my-plugin/%2e%2e/other-plugin/style.css` through: it
 * has no literal `..` segment and satisfies the raw prefix check, but a
 * consumer that percent-decodes the path (as browsers / HTTP servers
 * routinely do) resolves it to `/api/plugins/other-plugin/style.css`,
 * escaping the registering plugin's own namespace. Malformed percent-
 * encoding (a decode that throws) is rejected outright rather than
 * silently falling back to the raw form.
 *
 * feature-api-v2-path-removal §6: the namespace check *dual-accepts*
 * both the canonical `/api/plugins/<registeringPlugin>/` prefix and the
 * legacy `/api/v2/plugins/<registeringPlugin>/` one a not-yet-bumped
 * plugin package may still be passing in. When the legacy prefix
 * matches, the returned path has that prefix substring rewritten to
 * canonical BEFORE it ever enters the pending/published stylesheet
 * manifest — the manifest (served by `GET /api/app/info` and rendered
 * verbatim into `<link href>` by `RendererStylesheets`, which does no
 * normalization of its own) must never carry a `/api/v2/...` entry once
 * the listener stops accepting that prefix. This dual-accept is a
 * migration-period allowance ONLY — unlike the attachment URL reader's
 * permanent dual-accept regexes, it exists solely to decouple an
 * installed plugin's own bump timing from the listener cutover, and may
 * be narrowed back to canonical-only once installed plugins have caught
 * up.
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
  const canonicalPrefix = `/api/plugins/${registeringPlugin}/`;
  const legacyPrefix = `/api/v2/plugins/${registeringPlugin}/`;
  const matchesCanonical = pathname.startsWith(canonicalPrefix) && decodedPathname.startsWith(canonicalPrefix);
  const matchesLegacy = pathname.startsWith(legacyPrefix) && decodedPathname.startsWith(legacyPrefix);
  if (!matchesCanonical && !matchesLegacy) {
    throw new Error(`Plugin '${registeringPlugin}' registered a stylesheet path outside its own route namespace ('${canonicalPrefix}'): '${path}'`);
  }
  if (matchesLegacy) {
    // Migration-period normalization (see the doc comment above) — never
    // let the legacy-prefixed string itself reach the pending/published
    // manifest.
    return canonicalPrefix + path.slice(legacyPrefix.length);
  }
  return path;
}

/**
 * Reserved `EmbedRenderer` registrant identity for CORE-owned embed
 * tags (feature-renderer-plugin-boundary Phase 3 — `addCoreEmbedTag`).
 * Never a real plugin name (plugin names are npm package identifiers,
 * which never start with `@crowi/core`), so it can't collide with an
 * installed plugin's own identity.
 */
export const CORE_RENDERER_IDENTITY = '@crowi/core';

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
 *
 * feature-renderer-plugin-boundary Phase 3 adds:
 *   - `addCoreEmbedTag` — core-internal-only seed for a reserved embed
 *     tag (today: link-card's `card`), called once from
 *     `createRenderer()` before any plugin activates. `addEmbedTag`
 *     throws (never warn-and-override) when a plugin tries to register
 *     over a core-reserved tag.
 */
export class RendererRegistryImpl {
  private unifiedTransform: { plugin: unknown; registeringPlugin: string }[] = [];
  private nodeRenderers = new Map<string, { renderer: NodeRenderer; registeringPlugin: string }[]>();
  private embedTags = new Map<string, { plugin: string; renderer: EmbedRenderer }>();
  private codeBlockRenderers = new Map<string, { plugin: string; renderer: CodeBlockRenderer }>();
  private urlExpanders: { plugin: string; rule: UrlInlineExpansionRule }[] = [];
  /** Per-plugin staged stylesheet paths, not yet published — see the class doc comment. */
  private pendingStylesheets = new Map<string, string[]>();
  /** Published stylesheet manifest, in commit order, deduped. Read by `GET /api/app/info`. */
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
   *
   * feature-renderer-plugin-boundary Phase 3: a CORE-reserved tag
   * (seeded via `addCoreEmbedTag`, `plugin === CORE_RENDERER_IDENTITY`)
   * is the ONE exception — a third-party plugin trying to register over
   * it throws instead of warn-and-override, so core features (e.g. the
   * `card` link-card embed) can never be silently shadowed by an
   * installed plugin.
   */
  addEmbedTag(name: string, renderer: EmbedRenderer, registeringPlugin: string, log: PluginLogger): void {
    const existing = this.embedTags.get(name);
    if (existing?.plugin === CORE_RENDERER_IDENTITY) {
      throw new Error(`Plugin '${registeringPlugin}' cannot register embed tag '${name}': it is reserved by ${CORE_RENDERER_IDENTITY}`);
    }
    if (existing) {
      log.warn(`[renderer] embed-tag collision on '${name}': plugin '${existing.plugin}' is being overridden by '${registeringPlugin}' (last-wins)`);
    }
    this.embedTags.set(name, { plugin: registeringPlugin, renderer });
  }

  /**
   * Seed a CORE-reserved embed tag — bypasses the per-plugin
   * `makeRendererScope` closure entirely (this is core-internal, never
   * exposed through `@crowi/plugin-api`'s public `RendererRegistry`
   * interface) and stamps the registration with the reserved
   * `CORE_RENDERER_IDENTITY` plugin identity. That identity flows
   * unchanged through the existing per-registrant cache-scoping path
   * (`scopeForPlugin(cache, registration.plugin)` /
   * `cachedRender(cache, registration.plugin, …)`,
   * `core/embed-tags.ts`), so a core embed tag gets its own cache
   * namespace exactly like a plugin's would. Called once, at
   * `createRenderer()` boot time, BEFORE `setupPlugins()` activates any
   * plugin — this ordering is what makes a later cross-plugin
   * `addEmbedTag` collision on the same name a hard boot-time throw
   * (above) rather than a race.
   */
  addCoreEmbedTag(name: string, renderer: EmbedRenderer): void {
    this.embedTags.set(name, { plugin: CORE_RENDERER_IDENTITY, renderer });
  }

  /**
   * Phase 6: last-wins on collision, mirror of `addEmbedTag`. The boot
   * warn surfaces the conflict so an operator can either fix the
   * misnamed lang or accept the override — but only for a genuine
   * CROSS-plugin collision (`existing.plugin !== registeringPlugin`). A
   * plugin re-registering over its OWN prior registration (e.g.
   * PlantUML's `reconfigure()` hook re-calling `addCodeBlockRenderer` for
   * the same lang after an admin config save,
   * feature-renderer-plugin-boundary Phase 2) is an intentional
   * self-update, not a conflict — every admin-initiated config save would
   * otherwise log a spurious "collision" warning.
   */
  addCodeBlockRenderer(lang: string, renderer: CodeBlockRenderer, registeringPlugin: string, log: PluginLogger): void {
    const existing = this.codeBlockRenderers.get(lang);
    if (existing && existing.plugin !== registeringPlugin) {
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

  /** Published stylesheet manifest, in commit order, deduped — read by `GET /api/app/info`. */
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
