import fs from 'node:fs';
import path from 'node:path';

import type { Context } from 'hono';
import type { CrowiPlugin, NodeRenderer } from '@crowi/plugin-api';
import { escapeHtml } from '@crowi/plugin-api';
import { createJiti } from 'jiti';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import katex from 'katex';

/**
 * @crowi/plugin-renderer-katex
 *
 * Parses `$inline$` and `$$display$$` LaTeX via `remark-math`, then
 * renders each math node to HTML via `katex.renderToString` and
 * replaces the node in-place with an `html` node.
 *
 * `remark-math` is ESM-only and loaded via `jiti`. `katex` is dual
 * CJS/ESM and can be statically imported from CJS without jiti.
 *
 * Phase 6 ships vanilla KaTeX standard commands only. Macros /
 * `\newcommand` customisation are Phase 7+.
 *
 * feature-renderer-plugin-boundary Phase 2 (§2.1) — the resulting
 * markup's CSS/fonts are no longer a Web-side `katex/dist/katex.min.css`
 * import. This plugin self-serves them from its own `dist/assets/`
 * (copied from the installed `katex` package at build time by
 * `scripts/copy-katex-assets.mjs`) via `registerRoutes`, and advertises
 * the CSS path through `registerRenderer`'s `addStylesheet(...)` call —
 * see `STYLESHEET_MANIFEST_PATH` below.
 */

/**
 * Cached factory closure. Same pattern as `loadRemarkEmoji` /
 * `loadRemarkBreaks` — first call jiti-loads the module, subsequent
 * boots reuse the cached reference. Test-only export.
 */
type RemarkMathFn = (...args: unknown[]) => (...inner: unknown[]) => void;
let remarkMathCache: RemarkMathFn | null = null;

export function loadRemarkMath(): RemarkMathFn {
  if (remarkMathCache !== null) return remarkMathCache;
  const jiti = createJiti(__filename, { interopDefault: true });
  const mod = jiti('remark-math') as { default: RemarkMathFn };
  remarkMathCache = mod.default;
  return remarkMathCache;
}

/**
 * The unified-plugin factory we hand to `registry.addUnifiedPlugin`.
 * unified's `.use(plugin, opts)` calls `plugin.call(processor, opts)`,
 * so we MUST pass the loaded `remark-math` reference directly rather
 * than invoking it ourselves — `remark-math` reads `this.data()` from
 * the unified processor and would crash if invoked detached.
 *
 * The api's `addUnifiedPlugin` path passes `PipelineMetadata` as the
 * second argument; `remark-math` ignores arguments (no options), so
 * the metadata pass-through is harmless.
 */
function remarkMathUnifiedPlugin(this: unknown, ...args: unknown[]): unknown {
  const remarkMath = loadRemarkMath();
  return (remarkMath as (...inner: unknown[]) => unknown).apply(this, args);
}

/**
 * Render KaTeX HTML for a math / inlineMath node, mutating the node
 * in place. The runtime's `runNodeRenderers` (pipeline.ts:287-303)
 * walks every node of the registered type and invokes each renderer;
 * we mutate the node directly because runNodeRenderers does NOT
 * capture return values.
 *
 * Wrapper:
 *   - display math → `<div class="katex-block">…</div>`
 *   - inline math  → `<span class="katex-inline">…</span>`
 *
 * The KaTeX-emitted HTML already contains its own `<span class="katex">`
 * top-level wrapper, so the extra Crowi wrapper provides a stable
 * hook for our own CSS without depending on KaTeX's internal class
 * names.
 *
 * `strict: 'ignore'` + `throwOnError: false` ensure malformed LaTeX
 * never crashes a page render — KaTeX falls back to a red error frame
 * in the output.
 */
function renderMathToHtml(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value, {
      displayMode,
      strict: 'ignore',
      throwOnError: false,
      output: 'html',
    });
  } catch (err) {
    // strict:'ignore' + throwOnError:false should never escape here,
    // but defence-in-depth: an internal KaTeX assertion would otherwise
    // crash the whole page render.
    const message = err instanceof Error ? err.message : String(err);
    return `<span class="katex-error" title="KaTeX render failed">${escapeHtml(value)}</span><!-- ${escapeHtml(message)} -->`;
  }
}

interface MutableMathNode {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: unknown[];
}

const renderMathBlock: NodeRenderer = (node, _ctx) => {
  const mathNode = node as MutableMathNode;
  const html = renderMathToHtml(mathNode.value ?? '', true);
  mathNode.type = 'html';
  mathNode.value = `<div class="katex-block">${html}</div>`;
  // Drop any node-renderer-irrelevant fields so downstream serialisers
  // see a clean `html` shape.
  delete mathNode.children;
  delete mathNode.data;
};

const renderMathInline: NodeRenderer = (node, _ctx) => {
  const mathNode = node as MutableMathNode;
  const html = renderMathToHtml(mathNode.value ?? '', false);
  mathNode.type = 'html';
  mathNode.value = `<span class="katex-inline">${html}</span>`;
  delete mathNode.children;
  delete mathNode.data;
};

const PLUGIN_NAME = '@crowi/plugin-renderer-katex';
/** Route sub-paths, relative to `/api/plugins/${PLUGIN_NAME}` (`PluginRouterScope.route`'s `path`). */
const CSS_ROUTE_PATH = '/katex.min.css';
const FONTS_ROUTE_PATH = '/fonts/:filename';
/**
 * The API-relative absolute path handed to `registry.addStylesheet(...)`
 * in `registerRenderer` — must match `CSS_ROUTE_PATH`'s mounted location
 * exactly (`makePluginRouterScope` mounts every `registerRoutes` path
 * under `/api/plugins/${PLUGIN_NAME}/...`).
 */
const STYLESHEET_MANIFEST_PATH = `/api/plugins/${PLUGIN_NAME}${CSS_ROUTE_PATH}`;

const FONT_CONTENT_TYPES: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** A CSS/font asset ready to serve, plus its resolved `Content-Type`. */
interface ServableAsset {
  body: Buffer;
  contentType: string;
}

interface KatexAssets {
  css: ServableAsset;
  /** Keyed by exact filename (e.g. `KaTeX_AMS-Regular.woff2`) — see `resolveAssetsDir` doc comment for why this doubles as the traversal-proof allowlist. */
  fontsByFilename: Map<string, ServableAsset>;
}

/**
 * Locate the directory `katex.min.css` + `fonts/` were copied into.
 *
 * Production / dev (`@crowi/runner` `require()`s the built package, or
 * `tsup --watch` has run at least once): `__dirname` is `dist/`, and
 * `scripts/copy-katex-assets.mjs` (the `tsup` `onSuccess` hook) already
 * placed the files at its `assets/` sibling.
 *
 * `ts-jest` (this package's own unit test, `index.test.ts`) transforms
 * `src/index.ts` directly — `__dirname` is `src/` there, one level
 * above `dist/`. The `turbo.json` `@crowi/plugin-renderer-katex#test`
 * override runs this package's own `build` first (mirroring the
 * established `@crowi/plugin-renderer-mermaid#test` precedent for a
 * plugin whose test needs its own built output), so `../dist/assets`
 * is populated by the time the test runs.
 */
function resolveAssetsDir(): string {
  const builtSibling = path.join(__dirname, 'assets');
  if (fs.existsSync(path.join(builtSibling, 'katex.min.css'))) {
    return builtSibling;
  }
  const distFromSrc = path.join(__dirname, '..', 'dist', 'assets');
  if (fs.existsSync(path.join(distFromSrc, 'katex.min.css'))) {
    return distFromSrc;
  }
  throw new Error(
    `@crowi/plugin-renderer-katex: KaTeX CSS/font assets not found (looked in '${builtSibling}' and '${distFromSrc}') — run 'pnpm --filter @crowi/plugin-renderer-katex build' first.`,
  );
}

/**
 * Read `katex.min.css` + every font file in `assetsDir/fonts/` into
 * memory once, at `registerRoutes` call time (boot). ~1.1MB total —
 * cheap to hold for the process lifetime and avoids a filesystem read
 * per request. Throws (synchronously, propagating out of
 * `registerRoutes`) if the assets directory is missing/incomplete —
 * `mountPluginRoutes` (`packages/api/src/hono/index.ts`) treats that as
 * a route-mount failure and drops this plugin's pending
 * `addStylesheet(...)` path instead of publishing an unreachable
 * manifest entry (feature-renderer-plugin-boundary Phase 1 contract).
 */
function loadKatexAssets(): KatexAssets {
  const assetsDir = resolveAssetsDir();
  const css: ServableAsset = {
    body: fs.readFileSync(path.join(assetsDir, 'katex.min.css')),
    contentType: 'text/css; charset=utf-8',
  };
  const fontsDir = path.join(assetsDir, 'fonts');
  const fontsByFilename = new Map<string, ServableAsset>();
  for (const filename of fs.readdirSync(fontsDir)) {
    const ext = path.extname(filename);
    const contentType = FONT_CONTENT_TYPES[ext];
    if (!contentType) continue; // defence-in-depth: only serve the 3 known font formats KaTeX ships.
    fontsByFilename.set(filename, { body: fs.readFileSync(path.join(fontsDir, filename)), contentType });
  }
  return { css, fontsByFilename };
}

/** Assets bundled with `katex.min.css` change on a `katex` version bump only — safe to cache aggressively. */
const ASSET_CACHE_CONTROL = 'public, max-age=86400';

const buildAssetResponse = (asset: ServableAsset): Response =>
  new Response(new Uint8Array(asset.body), {
    status: 200,
    headers: { 'Content-Type': asset.contentType, 'Cache-Control': ASSET_CACHE_CONTROL },
  });

/**
 * `GET /api/plugins/${PLUGIN_NAME}/fonts/:filename` handler. Looks
 * `filename` up in the exact-match `fontsByFilename` map built from
 * what's actually on disk (`loadKatexAssets`) — there is no
 * filesystem path built from the request at all, so a `../` /
 * percent-encoded traversal attempt simply misses the map (404)
 * instead of resolving anywhere on disk.
 */
const buildFontsHandler =
  (assets: KatexAssets) =>
  (c: Context): Response => {
    const filename = c.req.param('filename');
    const asset = filename != null ? assets.fontsByFilename.get(filename) : undefined;
    if (!asset) {
      return new Response('Not Found', { status: 404 });
    }
    return buildAssetResponse(asset);
  };

const plugin: CrowiPlugin = {
  name: PLUGIN_NAME,
  version: '0.1.0-dev',
  adminPlacement: {
    section: 'renderer',
    label: 'KaTeX math',
    icon: 'function-square',
  },
  registerRenderer: (registry, ctx) => {
    registry.addUnifiedPlugin(remarkMathUnifiedPlugin, { phase: 'transform' });
    registry.addNodeRenderer('math', renderMathBlock);
    registry.addNodeRenderer('inlineMath', renderMathInline);
    // feature-renderer-plugin-boundary Phase 2 — staged here (registerRenderer
    // time); only published to the public app-info manifest once THIS
    // plugin's own `registerRoutes` below succeeds (see registry doc
    // comment, `packages/api/src/renderer/registry.ts`).
    registry.addStylesheet(STYLESHEET_MANIFEST_PATH);
    ctx.log.debug('registered remark-math (transform) + katex node renderers (math/inlineMath) + katex.min.css stylesheet');
  },
  registerRoutes: (scope, ctx) => {
    // Throws synchronously when assets are missing — `mountPluginRoutes`
    // catches it, drops this plugin's pending stylesheet, and this
    // plugin simply mounts no HTTP routes (same isolation as any other
    // plugin's `registerRoutes` failure).
    const assets = loadKatexAssets();
    scope.route('GET', CSS_ROUTE_PATH, () => buildAssetResponse(assets.css), { auth: 'public' });
    scope.route('GET', FONTS_ROUTE_PATH, buildFontsHandler(assets), { auth: 'public' });
    ctx.log.debug(`registered KaTeX asset routes (katex.min.css + ${assets.fontsByFilename.size} fonts)`);
  },
};

export default plugin;

// Internal renderers exported for unit-tests.
export const _renderers = { renderMathBlock, renderMathInline };

// Test-only exports.
export const _internal = { resolveAssetsDir, loadKatexAssets, STYLESHEET_MANIFEST_PATH, CSS_ROUTE_PATH, FONTS_ROUTE_PATH };
