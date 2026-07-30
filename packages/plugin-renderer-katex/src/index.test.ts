import fs from 'node:fs';

import type { NodeRenderer, PluginLogger, PluginRouterScope, RenderContext, RendererRegistry, RenderPhase } from '@crowi/plugin-api';
import { Hono } from 'hono';
import { createJiti } from 'jiti';
import type { Root } from 'mdast';
import katexPlugin, { _internal, _renderers, loadRemarkMath } from './index';

/**
 * Minimal RendererRegistry capture stub. Captures unified-plugin
 * registrations + node-renderer registrations so we can assert the
 * exact shape `registerRenderer` produces.
 */
interface CapturedUnified {
  plugin: unknown;
  phase: RenderPhase;
}
interface CapturedNodeRenderer {
  type: string;
  renderer: NodeRenderer;
}

function makeRegistry(): {
  scope: RendererRegistry;
  unifiedCaptured: CapturedUnified[];
  nodeCaptured: CapturedNodeRenderer[];
  stylesheetCaptured: string[];
} {
  const unifiedCaptured: CapturedUnified[] = [];
  const nodeCaptured: CapturedNodeRenderer[] = [];
  const stylesheetCaptured: string[] = [];
  const scope: RendererRegistry = {
    addUnifiedPlugin: (plugin, options) => {
      unifiedCaptured.push({ plugin, phase: options?.phase ?? 'transform' });
    },
    addNodeRenderer: (type, renderer) => {
      nodeCaptured.push({ type, renderer });
    },
    addCodeBlockRenderer: () => undefined,
    addEmbedTag: () => undefined,
    addUrlInlineExpander: () => undefined,
    addStylesheet: (path) => {
      stylesheetCaptured.push(path);
    },
  };
  return { scope, unifiedCaptured, nodeCaptured, stylesheetCaptured };
}

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * `actor` became a required `RenderContext` field in
 * feature-plugin-renderer-mermaid Phase 1 (spec §6, admission
 * control) — KaTeX never reads it (it declares no
 * `admissionControl`), so a fixed `'system'` actor is fine here.
 */
const stubCtx: RenderContext = {
  mode: 'view',
  actor: { kind: 'system' },
  log: silentLogger,
};

interface UnifiedProcessor {
  use(plugin: unknown, options?: unknown): UnifiedProcessor;
  parse(input: string): Root;
  runSync(tree: Root): Root;
}

/**
 * Build a unified+remark-parse processor with remark-math applied so
 * the e2e tests can walk the parsed tree and confirm math /
 * inlineMath nodes appear before the node renderers run.
 */
function buildMathProcessor(): UnifiedProcessor {
  const jiti = createJiti(__filename, { interopDefault: true });
  const unifiedMod = jiti('unified') as { unified: () => UnifiedProcessor };
  const remarkParseMod = jiti('remark-parse') as { default: unknown };
  const remarkMath = loadRemarkMath();
  return unifiedMod
    .unified()
    .use(remarkParseMod.default)
    .use(remarkMath as never);
}

interface MathNode {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: unknown[];
}

describe('@crowi/plugin-renderer-katex', () => {
  it('exports a CrowiPlugin with the expected name + version', () => {
    expect(katexPlugin.name).toBe('@crowi/plugin-renderer-katex');
    expect(katexPlugin.version).toBe('0.1.0-dev');
    expect(typeof katexPlugin.registerRenderer).toBe('function');
  });

  it('registers exactly 1 unified plugin (transform) and 2 node renderers (math + inlineMath)', () => {
    const { scope, unifiedCaptured, nodeCaptured } = makeRegistry();
    katexPlugin.registerRenderer?.(scope, { log: silentLogger } as never);

    expect(unifiedCaptured).toHaveLength(1);
    expect(unifiedCaptured[0].phase).toBe('transform');

    expect(nodeCaptured).toHaveLength(2);
    expect(nodeCaptured.map((c) => c.type).sort()).toEqual(['inlineMath', 'math']);
  });

  it('caches the remark-math load across loadRemarkMath calls', () => {
    const first = loadRemarkMath();
    const second = loadRemarkMath();
    expect(first).toBe(second);
  });

  it('end-to-end: `$x^2$` parses to an inlineMath mdast node', () => {
    const processor = buildMathProcessor();
    const tree = processor.runSync(processor.parse('see $x^2$ inline')) as {
      children: Array<{ type: string; children?: Array<{ type: string; value?: string }> }>;
    };
    // The paragraph children are [text, inlineMath, text].
    const para = tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const inline = para.children.find((c) => c.type === 'inlineMath');
    expect(inline).toBeDefined();
    expect(inline?.value).toBe('x^2');
  });

  it('end-to-end: multi-line `$$ ... $$` parses to a top-level math mdast node', () => {
    const processor = buildMathProcessor();
    // remark-math only emits the block-level `math` type when the
    // delimiters are on their own lines; an inline `$$...$$` stays
    // `inlineMath` (CommonMark phrasing default).
    const md = ['display', '', '$$', '\\int_0^1 x\\,dx', '$$', '', 'end'].join('\n');
    const tree = processor.runSync(processor.parse(md)) as { children: Array<{ type: string; value?: string }> };
    const mathNode = tree.children.find((c) => c.type === 'math');
    expect(mathNode).toBeDefined();
    expect(mathNode?.value).toContain('\\int');
  });

  it('renderMathBlock mutates a math node to type=html with katex-block wrapper + displayMode HTML', () => {
    const node: MathNode = { type: 'math', value: '\\int_0^1 x' };
    _renderers.renderMathBlock(node, stubCtx);
    expect(node.type).toBe('html');
    expect(node.value).toContain('katex-block');
    // KaTeX displayMode emits `<span class="katex-display"><span class="katex">…`.
    expect(node.value).toContain('katex-display');
    expect(node.value).toContain('class="katex"');
  });

  it('renderMathInline mutates an inlineMath node to type=html with katex-inline wrapper + non-display HTML', () => {
    const node: MathNode = { type: 'inlineMath', value: 'x^2' };
    _renderers.renderMathInline(node, stubCtx);
    expect(node.type).toBe('html');
    expect(node.value).toContain('katex-inline');
    expect(node.value).toContain('class="katex"');
    // Non-display mode → no katex-display wrapper.
    expect(node.value).not.toContain('katex-display');
  });

  it('drops children and replaces data with the crowiMath sidecar (RFC-0023 — TeX source preserved for the v1 projection)', () => {
    const node: MathNode = {
      type: 'math',
      value: 'a',
      data: { foo: 'bar' },
      children: [{ irrelevant: true }],
    };
    _renderers.renderMathBlock(node, stubCtx);
    expect(node.type).toBe('html');
    // Prior data is still dropped (no `foo` leak) — replaced wholesale
    // by the sidecar carrying the ORIGINAL TeX source.
    expect(node.data).toEqual({ crowiMath: { tex: 'a', display: true } });
    expect(node.children).toBeUndefined();
  });

  it('renderMathInline stamps a display:false crowiMath sidecar with the original TeX source', () => {
    const node: MathNode = { type: 'inlineMath', value: 'y_1' };
    _renderers.renderMathInline(node, stubCtx);
    expect(node.type).toBe('html');
    expect(node.data).toEqual({ crowiMath: { tex: 'y_1', display: false } });
  });

  it('the html value is byte-identical to the pre-sidecar output (sidecar rides on data only — no katexHtml duplicate field)', () => {
    const node: MathNode = { type: 'math', value: 'x^2' };
    _renderers.renderMathBlock(node, stubCtx);
    expect(node.value).toMatch(/^<div class="katex-block">/);
    expect(JSON.stringify(node.data)).not.toContain('katexHtml');
  });

  it('malformed LaTeX does NOT throw — strict:ignore + throwOnError:false renders an error frame', () => {
    const node: MathNode = { type: 'inlineMath', value: '\\zzz' };
    expect(() => _renderers.renderMathInline(node, stubCtx)).not.toThrow();
    expect(node.type).toBe('html');
    expect(typeof node.value).toBe('string');
    expect((node.value as string).length).toBeGreaterThan(0);
  });

  it('renderMathBlock returns nothing (renders via mutation only)', () => {
    const node: MathNode = { type: 'math', value: 'a' };
    const result = _renderers.renderMathBlock(node, stubCtx);
    // The NodeRenderer contract returns void | Promise<void> — we
    // assert the function returns undefined explicitly so the
    // mutation contract is the only effect channel.
    expect(result).toBeUndefined();
  });
});

/**
 * feature-renderer-plugin-boundary Phase 2 (§2.1, §9 "KaTeX" bullet) —
 * `registerRenderer` stages the CSS path via `addStylesheet`, and
 * `registerRoutes` self-serves it + the referenced fonts. Publishing to
 * the public app-info manifest only after `registerRoutes` succeeds is
 * `RendererRegistryImpl.commitStylesheets` / `mountPluginRoutes`'s job
 * (`packages/api/src/renderer/registry.ts`, `packages/api/src/hono/index.ts`)
 * — already covered generically by `registry.test.ts`'s isolation test;
 * this file only proves KaTeX's own two halves of that contract.
 */
describe('registerRenderer — addStylesheet', () => {
  it("stages exactly the CSS route path, confined to this plugin's own /api/v2/plugins/ namespace", () => {
    const { scope, stylesheetCaptured } = makeRegistry();
    katexPlugin.registerRenderer?.(scope, { log: silentLogger } as never);

    expect(stylesheetCaptured).toEqual([_internal.STYLESHEET_MANIFEST_PATH]);
    expect(_internal.STYLESHEET_MANIFEST_PATH).toBe('/api/v2/plugins/@crowi/plugin-renderer-katex/katex.min.css');
  });
});

/** A live `Hono` app + a `PluginRouterScope` that mounts straight onto it — same technique `@crowi/plugin-slack`'s `index.test.ts` uses to drive a plugin's routes end-to-end without the full API harness. */
function makeRoutesScope(): { app: Hono; scope: PluginRouterScope } {
  const app = new Hono();
  const scope: PluginRouterScope = {
    route: (method, routePath, handler) => {
      app.on(method, routePath, handler);
    },
  };
  return { app, scope };
}

function buildRoutesApp(): Hono {
  const { app, scope } = makeRoutesScope();
  katexPlugin.registerRoutes?.(scope, { log: silentLogger } as never);
  return app;
}

describe('registerRoutes — CSS / font asset routes', () => {
  it('serves katex.min.css with a text/css content-type + cache header', async () => {
    const app = buildRoutesApp();
    const res = await app.request(_internal.CSS_ROUTE_PATH);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    const body = await res.text();
    expect(body).toContain('.katex{');
  });

  it('serves an allowlisted font file with its matching content-type', async () => {
    const app = buildRoutesApp();
    const woff2 = await app.request('/fonts/KaTeX_Main-Regular.woff2');
    expect(woff2.status).toBe(200);
    expect(woff2.headers.get('content-type')).toBe('font/woff2');
    expect(woff2.headers.get('cache-control')).toBe('public, max-age=86400');

    const woff = await app.request('/fonts/KaTeX_Main-Regular.woff');
    expect(woff.headers.get('content-type')).toBe('font/woff');

    const ttf = await app.request('/fonts/KaTeX_Main-Regular.ttf');
    expect(ttf.headers.get('content-type')).toBe('font/ttf');
  });

  it('404s an unknown font filename (not on the allowlist)', async () => {
    const app = buildRoutesApp();
    const res = await app.request('/fonts/does-not-exist.woff2');
    expect(res.status).toBe(404);
  });

  it('404s a traversal attempt instead of resolving outside the assets dir — the handler does an exact-match lookup, never builds a filesystem path from the request', async () => {
    const app = buildRoutesApp();
    const res = await app.request('/fonts/..%2F..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(404);
  });

  it('every font URL the served CSS references resolves to a filename on the allowlist (same plugin namespace, no dangling reference)', () => {
    const assets = _internal.loadKatexAssets();
    const css = assets.css.body.toString('utf8');
    const fontUrls = [...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]);
    expect(fontUrls.length).toBeGreaterThan(0);
    for (const url of fontUrls) {
      const filename = url.replace(/^fonts\//, '');
      expect(assets.fontsByFilename.has(filename)).toBe(true);
    }
  });
});

describe('registerRoutes — missing assets fails the whole route mount', () => {
  it('resolveAssetsDir throws a descriptive error when neither candidate directory has katex.min.css', () => {
    const spy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      expect(() => _internal.resolveAssetsDir()).toThrow(/KaTeX CSS\/font assets not found/);
    } finally {
      spy.mockRestore();
    }
  });

  it('registerRoutes propagates the failure synchronously — mountPluginRoutes (packages/api/src/hono/index.ts) relies on this to drop the pending stylesheet and skip mounting any route for this plugin', () => {
    const spy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      const { scope } = makeRoutesScope();
      expect(() => katexPlugin.registerRoutes?.(scope, { log: silentLogger } as never)).toThrow(/KaTeX CSS\/font assets not found/);
    } finally {
      spy.mockRestore();
    }
  });
});
