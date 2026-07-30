import { createHash } from 'node:crypto';
import type { CodeBlockInfo, CodeBlockRenderer, CrowiPlugin, RenderResult } from '@crowi/plugin-api';
import { escapeHtml } from '@crowi/plugin-api';
import { encodeSvgToDataUrl } from './encode-svg';
import { detectRejectedSource } from './reject-patterns';
import { MermaidSyntaxError, renderMermaidSvg } from './render-engine';
import { sanitizeMermaidSvg } from './sanitize-svg';
import { extractSvgDimensions } from './svg-dimensions';

/**
 * Test-only escape hatch, re-exported at the package's public entry so
 * consumers OUTSIDE this package (e.g. `@crowi/api`'s
 * `mermaid.e2e.test.ts`, which only ever imports the built
 * `dist/index.js` — it has no path to this package's internal
 * `render-engine.ts`) can shut down the lazily-spawned child-process pool
 * singleton after a test run. Without this, a test file that exercises
 * the real plugin (any real `render()` call spawns the pool on first use)
 * leaves forked `render-worker` processes attached to the Jest worker,
 * which then fails to exit gracefully. Production code never calls this
 * — see `render-engine.ts`'s own doc comment on the export.
 */
export { _shutdownSingletonForTest } from './render-engine';

/**
 * @crowi/plugin-renderer-mermaid
 *
 * Renders ```mermaid fenced code blocks entirely server-side —
 * browserless (a `fork()`ed child-process pool running `mermaid` +
 * `jsdom`, `render-engine.ts` / `render-worker.ts`), no client-side
 * Mermaid JS ever ships to the browser. Layered defense (spec §2):
 * layer 1 host-forced Mermaid config (`render-worker.ts`), layer 2
 * shared DOM-based SVG sanitizer (`sanitize-svg.ts`, delegating to
 * `@crowi/svg-sanitize`), layer 3 base64 `data:` URL `<img>` embedding
 * (`encode-svg.ts`) so no raw Mermaid SVG DOM ever
 * reaches the page. `reject-patterns.ts` closes the 4th, input-side gap
 * (spec §3/§背景): flowchart image-shape constructs reach for a network
 * image mid-render, before any SVG exists to sanitize.
 *
 * No admin config — there is nothing an operator can tune (spec's
 * "やらないこと"). Enable by listing this plugin in `crowi.config.json`
 * (Phase 4).
 */

/** spec §6 — source-size gate, checked before admission control / the render engine. */
const MAX_SOURCE_BYTES = 20 * 1024;
/** spec §5 classification A — explicit, non-default TTL (see `code-block-dispatch.ts`'s `isRenderResult` doc comment for why omitting this would silently become 1h instead of 5min). */
const CLASS_A_ERROR_TTL_SEC = 5 * 60;
/** Success TTL — Mermaid output is deterministic per source (same source ⇒ same SVG), so a longer freshness window (mirrors PlantUML's 1h) avoids needless re-renders without risking staleness. */
const SUCCESS_TTL_SEC = 60 * 60;

/**
 * spec §5 classification A — fixed, accessible error markup. No
 * `diagram-embed` marker (spec §9 — keeps it out of the
 * click-to-enlarge / white-canvas dialog treatment). No parse-error
 * detail or raw source ever included. feature-renderer-plugin-boundary
 * Phase 2 (§3.1) adds `data-crowi-renderer-presentation="diagram"
 * data-crowi-renderer-state="error"` alongside the existing classes —
 * core's `renderer-presentation.tsx` reads the new attribute pair as
 * authoritative once present, so `state="error"` (not `"ready"`) is what
 * keeps this excluded from the zoom-dialog treatment on the new
 * contract, mirroring the legacy no-`diagram-embed`-class exclusion.
 */
const ERROR_HTML =
  '<div class="mermaid-embed mermaid-error" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="error" role="status"><span>Mermaid diagram could not be rendered</span></div>';

function classAErrorResult(): RenderResult {
  return { html: ERROR_HTML, ttlSec: CLASS_A_ERROR_TTL_SEC };
}

/**
 * Build the `CodeBlockRenderer`. Exported (not just registered inside
 * the default-exported `CrowiPlugin`) so unit tests can construct and
 * exercise it directly — same pattern as
 * `@crowi/plugin-renderer-plantuml`'s `createPlantUmlRenderer`.
 */
export function createMermaidRenderer(): CodeBlockRenderer {
  return {
    // feature-renderer-plugin-boundary Phase 2 (§3.1) — bumped from 1 to
    // 2: success + error output now additionally carry
    // `data-crowi-renderer-presentation="diagram"
    // data-crowi-renderer-state="ready"|"error"` (the `diagram-embed`/
    // `mermaid-embed`/`mermaid-error` classes stay, unchanged, for
    // plugin-owned CSS / downstream compatibility). Only invalidates
    // `PluginRenderCache` lookups (`mongodb-cache.ts`'s
    // `pluginCacheVersion` mismatch = miss) — does NOT bump
    // `RENDERER_PIPELINE_VERSION`, so already-saved `Revision.renderedAst`
    // blobs (written with the old shape) keep serving verbatim, dual-
    // accepted by the legacy `.diagram-embed`/no-marker branch, until
    // their page is next saved.
    //
    // Bumped 2 to 3: success output now also carries `width`/`height`
    // attributes (0-height <img> regression fix, see `svg-dimensions.ts`).
    // Same caveat as above — an already-saved page's `Revision.renderedAst`
    // still serves the old, size-less markup until it is next saved; only
    // this plugin's own `PluginRenderCache` entry (keyed on diagram
    // source, independent of any one page) is invalidated immediately.
    //
    // Bumped 3 to 4 (RFC-0023 §13): success results now additionally
    // carry `structured` (the `crowiDiagram` sidecar payload — html
    // output unchanged byte-for-byte). Without the bump, pre-RFC-0023
    // cache hits (no `structured`) would keep serving sidecar-less
    // results to the backfill / save paths until natural TTL expiry.
    cacheVersion: 4,
    reservation: { variant: 'aspect', aspectRatio: 16 / 9 },
    // spec §6 — sized to the fixed 4-worker child-process pool
    // (`render-engine.ts`); §7's preview dispatch is the only other
    // consumer, always at `priority: 'low'`.
    admissionControl: { maxConcurrentGlobal: 4, maxConcurrentPerUser: 2, queueDepth: 200 },
    // spec §7 — the only renderer that opts into editor live-preview
    // server-rendering; it is no-I/O + deterministic (§2/§6), satisfying
    // the contract `previewPolicy: 'server-render'` requires.
    previewPolicy: 'server-render',
    computeEmbedKey: (info: CodeBlockInfo) => createHash('sha256').update(info.source).digest('hex'),
    async render(info): Promise<RenderResult> {
      // Cheap checks gate the expensive resource (spec §6): the O(1)
      // byte-size gate first, then the §3 full-source regex scan —
      // both class-A rejects, so order only affects cost.
      if (Buffer.byteLength(info.source, 'utf8') > MAX_SOURCE_BYTES) return classAErrorResult();
      if (detectRejectedSource(info.source)) return classAErrorResult();

      let rawSvg: string;
      try {
        rawSvg = await renderMermaidSvg(info.source);
      } catch (err) {
        if (err instanceof MermaidSyntaxError) return classAErrorResult();
        // Anything else (child-process timeout / crash) is spec §5
        // classification B — propagate so `cachedRenderOrPending`
        // (`packages/api/src/renderer/cache/index.ts`) treats it as an
        // infra failure and never caches it.
        throw err;
      }

      const sanitized = sanitizeMermaidSvg(rawSvg);
      if (!sanitized.ok) return classAErrorResult();

      const encoded = encodeSvgToDataUrl(sanitized.svg);
      if (!encoded.ok) return classAErrorResult();

      const alt = buildAltText(info.source);
      // Mermaid's SVG declares `width="100%"` with no absolute height, so
      // a bare `<img>` has no resolvable intrinsic size once base64-
      // embedded — inside `RendererPresentation`'s `inline-block` wrapper
      // (whose own width is itself `auto`, sized from its content) the
      // two collapse to 0×0 in the browser. `width`/`height` attributes,
      // derived from the sanitized SVG's own `viewBox`, give the browser
      // an intrinsic size independent of the `data:` payload; CSS
      // `max-width: 100%; height: auto` then scales it proportionally.
      const dims = extractSvgDimensions(sanitized.svg);
      const sizeAttrs = dims ? ` width="${dims.width}" height="${dims.height}"` : '';
      // RFC-0023 §10 — the `crowiDiagram` structured payload: the SAME
      // sanitized SVG (Mermaid's sanitizer is already the strict
      // `allowSafeHref: false` policy, so no second pass is needed),
      // base64 re-used from the data URL. Intrinsic dimensions are
      // REQUIRED on the typed node — when the `viewBox` derivation
      // fails or falls outside the wire schema's 1..16384 range, we
      // fall back to html-only (no `structured`), never an undefined-
      // dimension node.
      const diagramType = detectDiagramType(info.source);
      const structured =
        dims && dims.width >= 1 && dims.width <= 16_384 && dims.height >= 1 && dims.height <= 16_384
          ? {
              node: {
                type: 'crowiDiagram',
                kind: 'mermaid',
                ...(diagramType !== undefined ? { diagramType } : {}),
                alt,
                image: {
                  mediaType: 'image/svg+xml',
                  base64: encoded.dataUrl.slice(SVG_DATA_URL_PREFIX.length),
                  width: dims.width,
                  height: dims.height,
                },
              },
            }
          : undefined;
      return {
        html: `<img class="diagram-embed mermaid-embed" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready" alt="${escapeHtml(alt)}" src="${encoded.dataUrl}"${sizeAttrs}>`,
        ttlSec: SUCCESS_TTL_SEC,
        ...(structured !== undefined ? { structured } : {}),
      };
    },
  };
}

/** Prefix `encodeSvgToDataUrl` always emits — sliced off to recover the raw base64 for the sidecar. */
const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;base64,';

/**
 * spec §9 — closed-enum diagram-type keywords for the `alt` text. A
 * pure first-line keyword match (mirrors what Mermaid's own
 * `detectType()` does, WITHOUT actually calling into `mermaid` — that
 * package only loads inside the isolated `render-worker.ts` child
 * process, never in the main api process). Never derives any part of
 * `alt` from arbitrary source text — only these fixed literal strings
 * are ever interpolated.
 */
const DIAGRAM_TYPE_KEYWORDS: ReadonlyArray<{ re: RegExp; type: string }> = [
  { re: /^flowchart\b/i, type: 'flowchart' },
  { re: /^graph\b/i, type: 'flowchart' },
  { re: /^sequenceDiagram\b/i, type: 'sequence' },
  { re: /^classDiagram\b/i, type: 'class' },
  { re: /^stateDiagram(-v2)?\b/i, type: 'state' },
  { re: /^erDiagram\b/i, type: 'entity-relationship' },
  { re: /^journey\b/i, type: 'journey' },
  { re: /^pie\b/i, type: 'pie' },
  { re: /^gitGraph\b/i, type: 'git-graph' },
];

/**
 * The closed-enum diagram-type keyword for `source`, or undefined when
 * the first line matches none. RFC-0023 — also feeds the
 * `crowiDiagram.diagramType` sidecar field (same closed enum, never
 * arbitrary source text).
 */
export function detectDiagramType(source: string): string | undefined {
  const firstLine = (source.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  return DIAGRAM_TYPE_KEYWORDS.find((k) => k.re.test(firstLine))?.type;
}

/**
 * `alt` text for the success `<img>`. `(a)` fixed `"Mermaid diagram"`,
 * or `(b)` `"Mermaid diagram (${type})"` where `type` is a member of the
 * closed enum above — never the source string itself (spec §9's
 * adversarial requirement: a source engineered to break out of the
 * `alt="..."` attribute must never reach it).
 */
export function buildAltText(source: string): string {
  const type = detectDiagramType(source);
  return type !== undefined ? `Mermaid diagram (${type})` : 'Mermaid diagram';
}

const plugin: CrowiPlugin = {
  name: '@crowi/plugin-renderer-mermaid',
  version: '0.1.0-dev',
  // No configSchema / adminPlacement — there is nothing an operator can
  // tune (spec "やらないこと": no Mermaid admin settings).
  registerRenderer: (registry, ctx) => {
    registry.addCodeBlockRenderer('mermaid', createMermaidRenderer());
    ctx.log.debug('registered Mermaid code-block renderer');
  },
};

export default plugin;
