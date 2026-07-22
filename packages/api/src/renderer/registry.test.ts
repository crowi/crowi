/**
 * Unit tests for `RendererRegistryImpl` — no dedicated test file existed
 * before feature-renderer-plugin-boundary Phase 1. Covers baseline
 * coverage of the pre-existing 5 register methods (they were previously
 * only exercised indirectly via `pipeline.test.ts` / `core/*.test.ts`) plus
 * the new `addStylesheet` extension point: API-relative-namespace
 * validation, absolute-origin / protocol-relative / traversal rejection,
 * registration-order dedupe, and the pending→route-success commit
 * snapshot.
 *
 * The final describe block additionally drives `addStylesheet` through the
 * REAL `mountPluginRoutes` (via `buildHonoApp`) with synthetic plugins to
 * prove the end-to-end "route registration failure drops only that
 * plugin's stylesheets" isolation contract — same
 * stub-`getLoadedPlugins()` + throwaway-`buildHonoApp(crowi)` harness
 * pattern as `plugin/plugin-router-smoke.test.ts`.
 */
import type { CodeBlockRenderer, CrowiPlugin, EmbedRenderer, PluginLogger, UrlInlineExpansionRule } from '@crowi/plugin-api';
import { getRequestListener } from '@hono/node-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import request from 'supertest';

import { crowi } from 'src/test/setup';
import { buildHonoApp } from 'src/hono';
import { stripApiV2Prefix } from 'src/hono/path-rewrite';
import { CORE_RENDERER_IDENTITY, makeRendererScope, RendererRegistryImpl } from './registry';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const buildEmbedRenderer = (): EmbedRenderer => ({
  cacheVersion: 1,
  render: async (input) => ({ html: `<div>${input.url}</div>` }),
});

const buildCodeBlockRenderer = (): CodeBlockRenderer => ({
  cacheVersion: 1,
  render: async () => ({ html: '<pre>code</pre>' }),
});

describe('RendererRegistryImpl', () => {
  describe('baseline coverage of the pre-existing 5 register methods', () => {
    it('addUnifiedPlugin: registration order, transform-phase only', () => {
      const reg = new RendererRegistryImpl();
      reg.addUnifiedPlugin('plugin-a', 'a', silentLogger, { phase: 'transform' });
      reg.addUnifiedPlugin('plugin-b', 'b', silentLogger);
      expect(reg.getTransformPlugins()).toEqual(['plugin-a', 'plugin-b']);
    });

    it('addUnifiedPlugin: a non-transform phase warns and is discarded', () => {
      const reg = new RendererRegistryImpl();
      const warn = jest.fn();
      reg.addUnifiedPlugin('pre-plugin', 'a', { ...silentLogger, warn }, { phase: 'pre' });
      expect(reg.getTransformPlugins()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('addNodeRenderer: multiple renderers for the same type accumulate in registration order', () => {
      const reg = new RendererRegistryImpl();
      const first = () => undefined;
      const second = () => undefined;
      reg.addNodeRenderer('heading', first, 'a');
      reg.addNodeRenderer('heading', second, 'b');
      expect(reg.getNodeRenderers('heading')).toEqual([first, second]);
      expect(reg.getRegisteredNodeTypes()).toEqual(['heading']);
    });

    it('addEmbedTag: last-wins on collision, with a boot warn', () => {
      const reg = new RendererRegistryImpl();
      const warn = jest.fn();
      const first = buildEmbedRenderer();
      const second = buildEmbedRenderer();
      reg.addEmbedTag('card', first, 'plugin-a', { ...silentLogger, warn });
      reg.addEmbedTag('card', second, 'plugin-b', { ...silentLogger, warn });
      expect(reg.getEmbedTag('card')).toEqual({ plugin: 'plugin-b', renderer: second });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('addCodeBlockRenderer: last-wins on collision, with a boot warn; hasCodeBlockRenderers reflects registration', () => {
      const reg = new RendererRegistryImpl();
      expect(reg.hasCodeBlockRenderers()).toBe(false);
      const warn = jest.fn();
      const first = buildCodeBlockRenderer();
      const second = buildCodeBlockRenderer();
      reg.addCodeBlockRenderer('mermaid', first, 'plugin-a', { ...silentLogger, warn });
      reg.addCodeBlockRenderer('mermaid', second, 'plugin-b', { ...silentLogger, warn });
      expect(reg.getCodeBlockRenderer('mermaid')).toEqual({ plugin: 'plugin-b', renderer: second });
      expect(reg.hasCodeBlockRenderers()).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('addCodeBlockRenderer: a plugin re-registering over its OWN prior registration (e.g. a reconfigure hook) is a silent self-update, not a collision', () => {
      const reg = new RendererRegistryImpl();
      const warn = jest.fn();
      const first = buildCodeBlockRenderer();
      const second = buildCodeBlockRenderer();
      reg.addCodeBlockRenderer('plantuml', first, 'plugin-a', { ...silentLogger, warn });
      reg.addCodeBlockRenderer('plantuml', second, 'plugin-a', { ...silentLogger, warn });
      expect(reg.getCodeBlockRenderer('plantuml')).toEqual({ plugin: 'plugin-a', renderer: second });
      expect(warn).not.toHaveBeenCalled();
    });

    it('addCoreEmbedTag: seeds a tag under the reserved CORE_RENDERER_IDENTITY, bypassing the per-plugin scope', () => {
      const reg = new RendererRegistryImpl();
      const renderer = buildEmbedRenderer();
      reg.addCoreEmbedTag('card', renderer);
      expect(reg.getEmbedTag('card')).toEqual({ plugin: CORE_RENDERER_IDENTITY, renderer });
    });

    it('addEmbedTag: a plugin registering over a core-reserved tag THROWS instead of warn-and-override', () => {
      const reg = new RendererRegistryImpl();
      const coreRenderer = buildEmbedRenderer();
      const pluginRenderer = buildEmbedRenderer();
      const warn = jest.fn();
      reg.addCoreEmbedTag('card', coreRenderer);
      expect(() => reg.addEmbedTag('card', pluginRenderer, 'some-plugin', { ...silentLogger, warn })).toThrow(/reserved/);
      // The core registration is untouched by the failed attempt.
      expect(reg.getEmbedTag('card')).toEqual({ plugin: CORE_RENDERER_IDENTITY, renderer: coreRenderer });
      expect(warn).not.toHaveBeenCalled();
    });

    it('addEmbedTag: an UNRESERVED tag still last-wins + warns as before (addCoreEmbedTag does not widen the guard to every tag)', () => {
      const reg = new RendererRegistryImpl();
      const warn = jest.fn();
      const first = buildEmbedRenderer();
      const second = buildEmbedRenderer();
      reg.addEmbedTag('mermaid-card', first, 'plugin-a', { ...silentLogger, warn });
      expect(() => reg.addEmbedTag('mermaid-card', second, 'plugin-b', { ...silentLogger, warn })).not.toThrow();
      expect(reg.getEmbedTag('mermaid-card')).toEqual({ plugin: 'plugin-b', renderer: second });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('addUrlInlineExpander: registration-order list', () => {
      const reg = new RendererRegistryImpl();
      const ruleA: UrlInlineExpansionRule = { cacheVersion: 1, match: /a/, expand: async () => ({ kind: 'unchanged' }) };
      const ruleB: UrlInlineExpansionRule = { cacheVersion: 1, match: /b/, expand: async () => ({ kind: 'unchanged' }) };
      reg.addUrlInlineExpander(ruleA, 'plugin-a');
      reg.addUrlInlineExpander(ruleB, 'plugin-b');
      expect(reg.getUrlInlineExpanders()).toEqual([
        { plugin: 'plugin-a', rule: ruleA },
        { plugin: 'plugin-b', rule: ruleB },
      ]);
    });
  });

  describe('addStylesheet — API-relative namespace validation', () => {
    it("accepts a path within the registering plugin's own namespace", () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('/api/v2/plugins/@crowi/plugin-renderer-katex/katex.css', '@crowi/plugin-renderer-katex')).not.toThrow();
    });

    it('accepts a query string / fragment on an otherwise-valid path', () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('/api/v2/plugins/my-plugin/style.css?v=2', 'my-plugin')).not.toThrow();
      expect(() => reg.addStylesheet('/api/v2/plugins/my-plugin/style.css#section', 'my-plugin')).not.toThrow();
    });

    it('rejects an absolute-origin URL (has a scheme)', () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('https://cdn.example.com/api/v2/plugins/my-plugin/style.css', 'my-plugin')).toThrow(/URL scheme/);
    });

    it('rejects a protocol-relative URL (//host)', () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('//evil.example.com/api/v2/plugins/my-plugin/style.css', 'my-plugin')).toThrow(/protocol-relative/);
    });

    it('rejects a path containing a backslash', () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('/api/v2/plugins/my-plugin/..\\style.css', 'my-plugin')).toThrow(/backslash/);
    });

    it("rejects a path with a '..' traversal segment", () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('/api/v2/plugins/my-plugin/../other-plugin/style.css', 'my-plugin')).toThrow(/traversal/);
    });

    it("rejects a percent-encoded '..' traversal segment (lowercase %2e%2e) that would escape the namespace once decoded", () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('/api/v2/plugins/my-plugin/%2e%2e/other-plugin/style.css', 'my-plugin')).toThrow(/traversal/);
    });

    it("rejects a percent-encoded '..' traversal segment (uppercase %2E%2E)", () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('/api/v2/plugins/my-plugin/%2E%2E/other-plugin/style.css', 'my-plugin')).toThrow(/traversal/);
    });

    it('rejects malformed percent-encoding rather than silently falling back to the raw path', () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('/api/v2/plugins/my-plugin/%E0%A4%A/style.css', 'my-plugin')).toThrow(/percent-encoding/);
    });

    it("rejects a path outside the registering plugin's own namespace (a different plugin name)", () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('/api/v2/plugins/other-plugin/style.css', 'my-plugin')).toThrow(/own route namespace/);
    });

    it('rejects a bare relative path with no /api/v2/plugins/<plugin>/ prefix at all', () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.addStylesheet('style.css', 'my-plugin')).toThrow(/own route namespace/);
    });
  });

  describe('addStylesheet — dedupe + pending→commit snapshot', () => {
    it('dedupes duplicate addStylesheet calls with the exact same path (same plugin)', () => {
      const reg = new RendererRegistryImpl();
      reg.addStylesheet('/api/v2/plugins/my-plugin/style.css', 'my-plugin');
      reg.addStylesheet('/api/v2/plugins/my-plugin/style.css', 'my-plugin');
      reg.commitStylesheets('my-plugin');
      expect(reg.getStylesheets()).toEqual(['/api/v2/plugins/my-plugin/style.css']);
    });

    it('getStylesheets() is empty until commitStylesheets runs', () => {
      const reg = new RendererRegistryImpl();
      reg.addStylesheet('/api/v2/plugins/my-plugin/style.css', 'my-plugin');
      expect(reg.getStylesheets()).toEqual([]);
    });

    it("commitStylesheets publishes only the named plugin's pending set, in registration order", () => {
      const reg = new RendererRegistryImpl();
      reg.addStylesheet('/api/v2/plugins/plugin-a/one.css', 'plugin-a');
      reg.addStylesheet('/api/v2/plugins/plugin-a/two.css', 'plugin-a');
      reg.addStylesheet('/api/v2/plugins/plugin-b/only.css', 'plugin-b');

      reg.commitStylesheets('plugin-a');
      expect(reg.getStylesheets()).toEqual(['/api/v2/plugins/plugin-a/one.css', '/api/v2/plugins/plugin-a/two.css']);

      reg.commitStylesheets('plugin-b');
      expect(reg.getStylesheets()).toEqual(['/api/v2/plugins/plugin-a/one.css', '/api/v2/plugins/plugin-a/two.css', '/api/v2/plugins/plugin-b/only.css']);
    });

    it('dropPendingStylesheets discards the whole pending set — a later commitStylesheets call is then a no-op', () => {
      const reg = new RendererRegistryImpl();
      reg.addStylesheet('/api/v2/plugins/my-plugin/one.css', 'my-plugin');
      reg.addStylesheet('/api/v2/plugins/my-plugin/two.css', 'my-plugin');

      reg.dropPendingStylesheets('my-plugin');
      reg.commitStylesheets('my-plugin');

      expect(reg.getStylesheets()).toEqual([]);
    });

    it('a plugin that never called addStylesheet is a no-op for both commit and drop', () => {
      const reg = new RendererRegistryImpl();
      expect(() => reg.commitStylesheets('no-op-plugin')).not.toThrow();
      expect(() => reg.dropPendingStylesheets('no-op-plugin')).not.toThrow();
      expect(reg.getStylesheets()).toEqual([]);
    });

    it('committing twice for the same plugin does not duplicate entries (pending is consumed on first commit)', () => {
      const reg = new RendererRegistryImpl();
      reg.addStylesheet('/api/v2/plugins/my-plugin/style.css', 'my-plugin');
      reg.commitStylesheets('my-plugin');
      reg.commitStylesheets('my-plugin');
      expect(reg.getStylesheets()).toEqual(['/api/v2/plugins/my-plugin/style.css']);
    });
  });

  describe('makeRendererScope — addStylesheet forwards to the registry under the closed-over plugin name', () => {
    it("registers under the scope's own plugin name and validates against it", () => {
      const reg = new RendererRegistryImpl();
      const scope = makeRendererScope(reg, '@crowi/plugin-renderer-katex', silentLogger);
      scope.addStylesheet('/api/v2/plugins/@crowi/plugin-renderer-katex/katex.css');
      reg.commitStylesheets('@crowi/plugin-renderer-katex');
      expect(reg.getStylesheets()).toEqual(['/api/v2/plugins/@crowi/plugin-renderer-katex/katex.css']);
    });

    it("a path outside the scope's own namespace still throws (scope does not widen the check)", () => {
      const reg = new RendererRegistryImpl();
      const scope = makeRendererScope(reg, 'plugin-a', silentLogger);
      expect(() => scope.addStylesheet('/api/v2/plugins/plugin-b/style.css')).toThrow(/own route namespace/);
    });
  });

  /**
   * End-to-end isolation contract: `mountPluginRoutes`
   * (`packages/api/src/hono/index.ts`) commits a plugin's pending
   * stylesheets only after that SAME plugin's `registerRoutes` succeeds,
   * and drops them wholesale on a throw — a sibling plugin's success is
   * unaffected either way. Drives the real `buildHonoApp(crowi)` with a
   * stubbed `getLoadedPlugins()`, same harness pattern as
   * `plugin/plugin-router-smoke.test.ts`.
   */
  describe("feature-renderer-plugin-boundary AC: route registration failure drops only that plugin's stylesheets", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const buildAppFromPlugins = (plugins: CrowiPlugin[]): ((req: IncomingMessage, res: ServerResponse) => void) => {
      const manager = crowi.pluginManager;
      if (!manager) throw new Error('PluginManager not bootstrapped in harness');
      const spy = jest.spyOn(manager, 'getLoadedPlugins').mockReturnValue(plugins);
      try {
        const honoApp = buildHonoApp(crowi);
        return getRequestListener((req: Request) => honoApp.fetch(stripApiV2Prefix(req)));
      } finally {
        spy.mockRestore();
      }
    };

    it("publishes the healthy plugin's stylesheet and omits the broken plugin's, while both plugins' other routes/state are unaffected", async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const registry = crowi.getRenderer().registry;

      const okName = '@crowi/plugin-stylesheet-isolation-ok';
      const brokenName = '@crowi/plugin-stylesheet-isolation-broken';
      const okPath = `/api/v2/plugins/${okName}/style.css`;
      const brokenPath = `/api/v2/plugins/${brokenName}/style.css`;

      // Simulates what `PluginManager.activate()` does at `registerRenderer`
      // time — stage the stylesheet BEFORE `buildHonoApp` (and therefore
      // `mountPluginRoutes`) ever runs, same as production boot order
      // (`setupPlugins` activates before `buildHonoApp` mounts routes).
      makeRendererScope(registry, okName, silentLogger).addStylesheet(okPath);
      makeRendererScope(registry, brokenName, silentLogger).addStylesheet(brokenPath);

      const okPlugin: CrowiPlugin = {
        name: okName,
        version: '0.0.0',
        registerRoutes: (scope) => {
          scope.route('GET', '/style.css', (c) => c.text('body { color: red; }'), { auth: 'public' });
        },
      };
      const brokenPlugin: CrowiPlugin = {
        name: brokenName,
        version: '0.0.0',
        registerRoutes: () => {
          throw new Error('registerRoutes exploded');
        },
      };

      const app = buildAppFromPlugins([okPlugin, brokenPlugin]);

      // The healthy plugin's route still mounts...
      const styleRes = await request(app).get(`/api/v2/plugins/${okName}/style.css`);
      expect(styleRes.status).toBe(200);

      // ...and the manifest carries its stylesheet but not the broken
      // plugin's — proving the drop is scoped to the ONE plugin whose
      // registerRoutes threw, not a blanket rollback.
      const infoRes = await request(app).get('/api/v2/app/info');
      expect(infoRes.status).toBe(200);
      expect(infoRes.body.rendererStylesheets).toContain(okPath);
      expect(infoRes.body.rendererStylesheets).not.toContain(brokenPath);

      expect(consoleSpy).toHaveBeenCalledWith(
        `[crowi:plugin:${brokenName}] registerRoutes failed; this plugin's HTTP routes are not mounted: registerRoutes exploded`,
      );
    });

    it('a plugin with no registerRoutes at all never gets its pending stylesheet published', async () => {
      const registry = crowi.getRenderer().registry;
      const name = '@crowi/plugin-stylesheet-no-routes';
      const path = `/api/v2/plugins/${name}/style.css`;
      makeRendererScope(registry, name, silentLogger).addStylesheet(path);

      const plugin: CrowiPlugin = { name, version: '0.0.0' };
      const app = buildAppFromPlugins([plugin]);

      const infoRes = await request(app).get('/api/v2/app/info');
      expect(infoRes.status).toBe(200);
      expect(infoRes.body.rendererStylesheets).not.toContain(path);
    });
  });
});
