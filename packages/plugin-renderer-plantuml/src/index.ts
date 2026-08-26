import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import type { CodeBlockInfo, CodeBlockRenderer, CrowiPlugin, RenderError, RendererRegistry, RenderResult, StructuredRenderPayload } from '@crowi/plugin-api';
import { extractSvgDimensions, sanitizeSvg as sanitizeSvgShared } from '@crowi/plugin-api';
import { encode as encodePlantUml } from './encoder';
import { extractPngDimensions } from './png-dimensions';
import { sanitizeSvg } from './sanitize';

/**
 * @crowi/plugin-renderer-plantuml
 *
 * Renders ```plantuml fenced code blocks via an operator-configured
 * PlantUML server. The diagram source is deflate+base64-encoded
 * (`plantuml-encoder`) and fetched from `${serverUrl}/${format}/${encoded}`,
 * then either inlined as SVG (sanitized) or embedded as a base64 PNG.
 *
 * Phase 6 ships this as the first user of `addCodeBlockRenderer`
 * and the cache contract (Phase 4 PluginRenderCache). Failures are
 * cached as `RenderError` for 5 minutes (network / timeout); the
 * placeholder is rendered through `crowi-embed-placeholder-error-*`.
 *
 * Operator install:
 *   1. Run the official PlantUML server yourself — Crowi's compose file
 *      does not ship one.
 *   2. List this plugin in `crowi.config.json:plugins`.
 *   3. In the admin UI, fill in `serverUrl` if your server isn't at
 *      the default hostname.
 */

/**
 * Schema-driven config. The admin UI in `/admin/plugins` builds the
 * form by walking this object. The `serverUrl` default is a
 * compose-internal hostname, which only resolves for an operator who
 * runs their own PlantUML service on the same compose network.
 */
export const plantumlConfigSchema = z.object({
  serverUrl: z.string().url().default('http://plantuml:8080').describe('Base URL of the PlantUML server.'),
  outputFormat: z
    .enum(['svg', 'png'])
    .default('svg')
    .describe('Image format the server returns. SVG is preferred (smaller, interactive); PNG is a fallback for installs whose server only serves PNG.'),
});

export type PlantUmlConfig = z.infer<typeof plantumlConfigSchema>;

/** Render-side timeout for the PlantUML server fetch. */
const FETCH_TIMEOUT_MS = 10_000;
/** Fresh cache TTL — 1 hour. SWR window = 4h via cachedRender default. */
const CACHE_TTL_SEC = 60 * 60;

/**
 * Build the CodeBlockRenderer instance, bound to a resolved config.
 * Exported so unit tests can construct a renderer without going through
 * the full plugin registration flow.
 */
export function createPlantUmlRenderer(config: PlantUmlConfig): CodeBlockRenderer {
  return {
    // Phase 3 (feature-plugin-renderer-mermaid spec §9): bumped from 1 to
    // 2 when the sanitizer switched from the regex-based implementation
    // to the shared svg-sanitize package (bundled into this dist, not a
    // runtime dependency — see `sanitize.ts`) and the output class changed
    // from `plantuml-embed` to `diagram-embed plantuml-embed`.
    // feature-renderer-plugin-boundary Phase 2 (§3.1)
    // bumps 2 → 3: success output additionally carries the generic
    // `data-crowi-renderer-presentation="diagram"
    // data-crowi-renderer-state="ready"` contract Web's
    // `renderer-presentation.tsx` reads (the `diagram-embed`/
    // `plantuml-embed` classes stay, unchanged, for plugin-owned CSS /
    // downstream compatibility). Each bump only invalidates
    // `PluginRenderCache` lookups (an operational escape hatch,
    // `mongodb-cache.ts`'s `pluginCacheVersion` mismatch = miss) — it
    // does NOT bump `RENDERER_PIPELINE_VERSION`, so already-saved
    // `Revision.renderedAst` blobs (written with the old shape) keep
    // serving verbatim, dual-accepted by the legacy `.diagram-embed`
    // branch, until their page is next saved (spec §9 "next-save-only").
    //
    // RFC-0023 §13 bumps 3 → 4: success results now additionally carry
    // `structured` (the `crowiDiagram` sidecar payload — html output
    // unchanged byte-for-byte). Without the bump, pre-RFC-0023 cache
    // hits (no `structured`) would keep serving sidecar-less results
    // until natural TTL expiry.
    cacheVersion: 4,
    reservation: { variant: 'aspect', aspectRatio: 16 / 9 },
    computeEmbedKey: (info: CodeBlockInfo) => {
      // Hash the diagram source only — operator changing serverUrl /
      // outputFormat invalidates implicitly via the 1h TTL rather than
      // explicit invalidation. cacheVersion bump is the operator's
      // escape hatch when they need immediate invalidation.
      return createHash('sha256').update(info.source).digest('hex');
    },
    async render(info, _ctx): Promise<RenderResult> {
      const encoded = encodePlantUml(info.source);
      const url = `${trimTrailingSlash(config.serverUrl)}/${config.outputFormat}/${encoded}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        // AbortController fired → timeout. Otherwise → network.
        const isAbort = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
        const code: RenderError['code'] = isAbort ? 'timeout' : 'network';
        return {
          html: '',
          error: { code, message: stringifyError(err) },
        };
      }
      clearTimeout(timer);

      if (!response.ok) {
        const code: RenderError['code'] = response.status === 404 ? 'not_found' : 'network';
        return {
          html: '',
          error: { code, message: `PlantUML server responded with HTTP ${response.status}` },
        };
      }

      if (config.outputFormat === 'svg') {
        const svg = await response.text();
        const sanitized = sanitizeSvg(svg);
        if (!sanitized.ok) {
          // The server-supplied SVG failed the shared sanitizer's
          // structural checks (malformed XML, non-svg root, ...) — treat
          // it the same as any other bad-response failure rather than
          // ever falling back to unsanitized output.
          return {
            html: '',
            error: { code: 'unknown', message: `PlantUML server returned an SVG document rejected by the sanitizer (${sanitized.reason})` },
          };
        }
        return {
          // `data-crowi-renderer-presentation="diagram"
          // data-crowi-renderer-state="ready"` (feature-renderer-plugin-
          // boundary Phase 2 §3.1) is the producer-agnostic contract
          // Web's `renderer-presentation.tsx` reads for the
          // click-to-enlarge / dark-mode-neutral-face treatment;
          // `diagram-embed plantuml-embed` stay alongside it, unchanged,
          // for legacy-AST dual-accept + renderer-specific CSS.
          html: `<div class="diagram-embed plantuml-embed" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready">${sanitized.svg}</div>`,
          ttlSec: CACHE_TTL_SEC,
          ...buildSvgStructured(svg),
        };
      }

      // PNG path — base64 the binary body. The plugin returns a
      // self-contained `<img>` tag with a data: URL. Cache entries
      // get larger for PNGs, but the per-entry size cap from Phase 4
      // (cache/mongodb-cache.ts) caps that automatically.
      const buf = Buffer.from(await response.arrayBuffer());
      const b64 = buf.toString('base64');
      return {
        html: `<img class="diagram-embed plantuml-embed" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready" alt="" src="data:image/png;base64,${b64}">`,
        ttlSec: CACHE_TTL_SEC,
        ...buildPngStructured(buf, b64),
      };
    },
  };
}

/** Fixed accessible alt for the sidecar — never derived from diagram source (same adversarial rule as Mermaid's alt). */
const SIDECAR_ALT = 'PlantUML diagram';
/** Wire-schema intrinsic dimension bounds (`CrowiDimensionSchema`, RFC-0023 §7). */
const MAX_SIDECAR_DIMENSION = 16_384;

/**
 * RFC-0023 §1/§10 — the SVG branch's `crowiDiagram` sidecar. The
 * sidecar SVG runs through an INDEPENDENT second sanitisation pass with
 * `allowSafeHref: false` (unlike the html branch's `allowSafeHref:
 * true` pass): declared clients render the typed node natively and must
 * never receive live foreign links. The two passes fail independently —
 * this helper failing (strict sanitize reject / underivable dimensions)
 * only drops `structured` (html-only fallback), never the html; and it
 * never reuses the html branch's sanitised output.
 */
function buildSvgStructured(rawSvg: string): { structured?: StructuredRenderPayload } {
  const strict = sanitizeSvgShared(rawSvg, { allowSafeHref: false });
  if (!strict.ok) return {};
  const dims = extractSvgDimensions(strict.svg);
  if (!dims || !dimsWithinWire(dims)) return {};
  return {
    structured: {
      node: {
        type: 'crowiDiagram',
        kind: 'plantuml',
        alt: SIDECAR_ALT,
        image: {
          mediaType: 'image/svg+xml',
          base64: Buffer.from(strict.svg, 'utf8').toString('base64'),
          width: dims.width,
          height: dims.height,
        },
      },
    },
  };
}

/** RFC-0023 §10 — the PNG branch's sidecar; dimensions from the IHDR chunk, html-only fallback when underivable. */
function buildPngStructured(png: Buffer, base64: string): { structured?: StructuredRenderPayload } {
  const dims = extractPngDimensions(png);
  if (!dims || !dimsWithinWire(dims)) return {};
  return {
    structured: {
      node: {
        type: 'crowiDiagram',
        kind: 'plantuml',
        alt: SIDECAR_ALT,
        image: { mediaType: 'image/png', base64, width: dims.width, height: dims.height },
      },
    },
  };
}

function dimsWithinWire(dims: { width: number; height: number }): boolean {
  return dims.width >= 1 && dims.width <= MAX_SIDECAR_DIMENSION && dims.height >= 1 && dims.height <= MAX_SIDECAR_DIMENSION;
}

/**
 * Captured at `registerRenderer` time so `reconfigure` can re-register
 * against the SAME live registry without `PluginContext` needing to
 * expose it (by design — `PluginContext` is deliberately a thin,
 * registry-free conduit, `packages/plugin-api/src/context.ts`'s own doc
 * comment). Module-level is safe here: one Crowi process loads one
 * instance of this plugin module (require-cache singleton), matching the
 * same pattern KaTeX/emoji already use for their own lazy-load caches.
 */
let liveRegistry: RendererRegistry | undefined;

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-renderer-plantuml',
  version: '0.1.0-dev',
  configSchema: plantumlConfigSchema,
  adminPlacement: {
    section: 'renderer',
    label: 'PlantUML diagrams',
    icon: 'diagram-3',
  },
  configI18n: {
    ja: {
      serverUrl: { label: 'サーバー URL', description: 'PlantUML サーバーのベース URL。' },
      format: {
        label: '画像形式',
        description: 'サーバーが返す画像形式。SVG 推奨（軽量で対話的）。PNG は SVG を返せないサーバー向けのフォールバックです。',
      },
    },
  },
  registerRenderer: (registry, ctx) => {
    // PluginContext.config<T>() parses the configSchema-typed config
    // row and returns it. The plantuml plugin closes over the config
    // here; admin edits trigger `reconfigure(ctx)` (below) which
    // re-registers against `liveRegistry` to refresh the cached renderer.
    liveRegistry = registry;
    const config = ctx.config<PlantUmlConfig>();
    registry.addCodeBlockRenderer('plantuml', createPlantUmlRenderer(config));
    ctx.log.debug(`registered PlantUML code-block renderer (serverUrl=${config.serverUrl}, format=${config.outputFormat})`);
  },
  // When admin saves new config, re-register so the renderer closure
  // picks up the new serverUrl / outputFormat. The registry's last-wins
  // collision warning only fires on a cross-plugin conflict (a
  // DIFFERENT plugin overwriting this entry) — a plugin re-registering
  // over its own prior entry, as this reconfigure path does every time,
  // is silent.
  reconfigure: (ctx) => {
    if (!liveRegistry) return; // reconfigure fired before registerRenderer ever ran — nothing to refresh yet.
    const config = ctx.config<PlantUmlConfig>();
    liveRegistry.addCodeBlockRenderer('plantuml', createPlantUmlRenderer(config));
    ctx.log.debug(`reconfigured PlantUML code-block renderer (serverUrl=${config.serverUrl}, format=${config.outputFormat})`);
  },
};

export default plugin;

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
