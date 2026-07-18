import { createHash } from 'node:crypto';
import type { CodeBlockInfo, CodeBlockRenderer, CrowiPlugin, RenderResult } from '@crowi/plugin-api';
import { encodeSvgToDataUrl } from './encode-svg';
import { detectRejectedSource } from './reject-patterns';
import { MermaidSyntaxError, renderMermaidSvg } from './render-engine';
import { sanitizeMermaidSvg } from './sanitize-svg';

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
 * `@crowi/plugin-renderer-svg-sanitize`), layer 3 base64 `data:` URL
 * `<img>` embedding (`encode-svg.ts`) so no raw Mermaid SVG DOM ever
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

/** spec §5 classification A — fixed, accessible error markup. No `diagram-embed` marker (spec §9 — keeps it out of the click-to-enlarge / white-canvas dialog treatment). No parse-error detail or raw source ever included. */
const ERROR_HTML = '<div class="mermaid-embed mermaid-error" role="status"><span>Mermaid diagram could not be rendered</span></div>';

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
    cacheVersion: 1,
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
      // §3 — full-source scan, before anything touches the render
      // engine / admission control (cheap check gates the expensive
      // resource, spec §6).
      if (detectRejectedSource(info.source)) return classAErrorResult();

      if (Buffer.byteLength(info.source, 'utf8') > MAX_SOURCE_BYTES) return classAErrorResult();

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
      return {
        html: `<img class="diagram-embed mermaid-embed" alt="${escapeHtmlAttr(alt)}" src="${encoded.dataUrl}">`,
        ttlSec: SUCCESS_TTL_SEC,
      };
    },
  };
}

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
 * `alt` text for the success `<img>`. `(a)` fixed `"Mermaid diagram"`,
 * or `(b)` `"Mermaid diagram (${type})"` where `type` is a member of the
 * closed enum above — never the source string itself (spec §9's
 * adversarial requirement: a source engineered to break out of the
 * `alt="..."` attribute must never reach it).
 */
export function buildAltText(source: string): string {
  const firstLine = (source.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  const match = DIAGRAM_TYPE_KEYWORDS.find((k) => k.re.test(firstLine));
  return match ? `Mermaid diagram (${match.type})` : 'Mermaid diagram';
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
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
