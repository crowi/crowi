import type { CodeBlockRenderer, RenderResult } from '@crowi/plugin-api';
import { DOMParser } from '@xmldom/xmldom';
import sharp from 'sharp';
import { DIAGNOSTIC_IMAGE_SHAPE_SOURCE, DIAGRAM_CORPUS } from './__fixtures__/diagram-corpus';
import { silentCtx } from './__fixtures__/silent-ctx';
// Imported as a namespace (not a destructured `{ encodeSvgToDataUrl }`)
// so the "output size exceeded" describe block below can `jest.spyOn`
// this exact property — `index.ts`'s own `import { encodeSvgToDataUrl }
// from './encode-svg'` compiles (ts-jest, CommonJS target) to a
// property access on this SAME required module object, so replacing
// the property here is observed there too. Deliberately NOT
// `jest.mock('./encode-svg', ...)` (module-level, file-scoped,
// hoisted) — that would also silently defang every OTHER describe
// block in this file that needs the REAL encoder (the 8-diagram-type
// success-path assertions above decode and parse the actual base64
// SVG payload).
import * as encodeSvgModule from './encode-svg';
import { buildAltText, createMermaidRenderer } from './index';
// Same namespace-import rationale as `encodeSvgModule` above — the
// "rasterization failed" describe block spies on this exact property.
import * as rasterizePngModule from './rasterize-png';
import { MAX_PNG_OUTPUT_BYTES } from './rasterize-png';
import { _shutdownSingletonForTest } from './render-engine';

// All `createMermaidRenderer()` instances in this file share the
// process-wide `render-engine.ts` singleton pool (forked worker
// processes) — shut it down once after every test in this file has run
// so no worker outlives the test file.
afterAll(async () => {
  await _shutdownSingletonForTest();
});

/** `createMermaidRenderer()` always returns a `RenderResult` (never a bare `EmbedFragment`) — narrow once, here. */
const render = (renderer: CodeBlockRenderer, source: string): Promise<RenderResult> =>
  Promise.resolve(renderer.render({ lang: 'mermaid', source }, silentCtx)).then((r) => r as RenderResult);

const SVG_NAMESPACE_URI = 'http://www.w3.org/2000/svg';

/** Decode the base64 `data:image/svg+xml;base64,...` payload embedded in a generated `<img src="...">`. */
function decodeSvgDataUrl(html: string): string {
  const match = /src="data:image\/svg\+xml;base64,([^"]+)"/.exec(html);
  if (!match) throw new Error('no data URL src found in the generated HTML');
  return Buffer.from(match[1], 'base64').toString('utf8');
}

/**
 * AC1/AC14 (spec §2 layer 2 / §9): proves the FINAL `<img>` src actually
 * decodes to sanitizer-shaped output — a well-formed, strictly single-root
 * document whose root is the literal, unprefixed `svg` element in the SVG
 * namespace — not merely that `src="data:image/svg+xml;base64,"` is
 * present as a substring (the pre-existing per-type test above already
 * checks that, but never parses the payload). Uses `@xmldom/xmldom` — the
 * exact same parser `@crowi/svg-sanitize` uses internally — rather than a
 * second, independent parser implementation, so this assertion reasons about
 * namespace/prefix resolution identically to the sanitizer itself.
 */
function expectWellFormedUnprefixedSvgRoot(svg: string): void {
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(svg, 'image/svg+xml');
  expect(doc.childNodes).toHaveLength(1); // single root — nothing else at document level
  const root = doc.documentElement;
  expect(root).not.toBeNull();
  if (!root) return;
  expect(root.localName).toBe('svg');
  expect(root.namespaceURI).toBe(SVG_NAMESPACE_URI);
  expect(root.prefix).toBeNull();
}

/**
 * The `crowiDiagram` sidecar's shape. Restated locally (not imported)
 * because this package deliberately does not depend on
 * `@crowi/api-contract` — the wire schema is a downstream consumer of
 * what the plugin produces, not a build-time dependency of it.
 */
interface DiagramSidecarNode {
  type: string;
  kind: string;
  diagramType?: string;
  alt: string;
  image: { mediaType: string; base64: string; width: number; height: number };
}

/**
 * Wire / storage caps the sidecar must fit, restated from their
 * authorities (same no-dependency reason as above):
 *   - `AST_MAX_IMAGE_BASE64_CHARS` (`packages/api-contract/src/schemas/rendered-ast.ts`)
 *     — a longer base64 string fails `CrowiImagePayloadSchema` outright.
 *   - `SINGLE_ENTRY_REJECT_BYTES` (`packages/api/src/renderer/cache/mongodb-cache.ts`)
 *     — applies TWICE and differently: to the DECODED image bytes in the
 *       §10 deep validation (`sanitize-ast.ts`, mirrored by the iOS
 *       decoder's `maxDecodedImageBytes`), and to the SERIALISED
 *       structured payload in `setOrReject`, which silently strips the
 *       sidecar (html still written) when it is exceeded. The second one
 *       is the binding constraint — base64 inflates the PNG by 4/3, so
 *       it is what `MAX_PNG_OUTPUT_BYTES` is derived from.
 */
const AST_MAX_IMAGE_BASE64_CHARS = 140_000;
const SINGLE_ENTRY_REJECT_BYTES = 100 * 1024;
const CANONICAL_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sidecarNodeOf(result: RenderResult): DiagramSidecarNode | undefined {
  return (result as { structured?: { node: DiagramSidecarNode } }).structured?.node;
}

/**
 * The assertion that would have caught the shipped bug: the sidecar's
 * bytes must be an image a native client can actually decode, at
 * plausible dimensions, within every cap it has to survive on the way
 * out. The golden corpus normalises diagram base64 to a placeholder, so
 * NOTHING downstream ever exercised a real Mermaid payload — the SVG
 * sidecar looked correct at every layer and still could not be drawn by
 * the iOS rasterizer.
 *
 * `intrinsic` is the SVG `viewBox`'s own size: the PNG must be a raster
 * OF THAT DIAGRAM, i.e. the same aspect ratio and never below 1:1.
 */
async function expectDecodablePngSidecar(node: DiagramSidecarNode | undefined, intrinsic: { width: number; height: number }): Promise<void> {
  expect(node).toBeDefined();
  if (!node) return;
  expect(node.type).toBe('crowiDiagram');
  expect(node.kind).toBe('mermaid');
  expect(node.image.mediaType).toBe('image/png');

  // Canonical base64 (the §10 deep validation rejects anything else) and
  // within the schema's character cap.
  expect(node.image.base64).toMatch(CANONICAL_BASE64_RE);
  expect(node.image.base64.length).toBeLessThanOrEqual(AST_MAX_IMAGE_BASE64_CHARS);

  const png = Buffer.from(node.image.base64, 'base64');
  expect(png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)).toBe(true);
  expect(png.byteLength).toBeLessThanOrEqual(MAX_PNG_OUTPUT_BYTES);
  expect(png.byteLength).toBeLessThanOrEqual(SINGLE_ENTRY_REJECT_BYTES); // §10 decoded-size cap / iOS maxDecodedImageBytes
  // The serialised sidecar must also stay under the render cache's
  // strip threshold — exceeding it costs native clients the payload
  // silently, with the html write succeeding as if nothing happened.
  expect(Buffer.byteLength(JSON.stringify({ node }), 'utf8')).toBeLessThan(SINGLE_ENTRY_REJECT_BYTES);

  // Fully DECODE the payload (not just its header): a truncated or
  // half-written PNG passes a signature/metadata check and still fails
  // on the client. `channels × width × height` raw bytes coming back is
  // proof every scanline was there.
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  expect(data.byteLength).toBe(info.width * info.height * info.channels);

  // The reported dimensions are the diagram's LAYOUT size (SVG user
  // units), NOT the raster's pixel count — the same quantity the html's
  // viewBox-derived `width`/`height` attributes carry, which is what
  // keeps a native client laying the diagram out at web's size instead
  // of at the oversampled raster's. `intrinsic` here IS the html's pair.
  expect(node.image.width).toBe(intrinsic.width);
  expect(node.image.height).toBe(intrinsic.height);

  // ...and the raster behind it is oversampled, never downsampled: at
  // the ladder's top step it is ~2x on each axis, at the 72-DPI floor
  // exactly 1x. Both axes scale together, so the shape is preserved.
  expect(info.width).toBeGreaterThanOrEqual(node.image.width);
  expect(info.height).toBeGreaterThanOrEqual(node.image.height);
  expect(info.width / info.height).toBeCloseTo(node.image.width / node.image.height, 1);

  // Inside the wire schema's closed interval.
  expect(node.image.width).toBeGreaterThanOrEqual(1);
  expect(node.image.height).toBeGreaterThanOrEqual(1);
  expect(node.image.width).toBeLessThanOrEqual(16_384);
  expect(node.image.height).toBeLessThanOrEqual(16_384);
}

describe('@crowi/plugin-renderer-mermaid — success path (8 diagram types)', () => {
  const renderer = createMermaidRenderer();

  it.each(DIAGRAM_CORPUS.map((entry) => [entry.name, entry.source] as const))(
    '%s renders to a self-contained <img> with a meaningful, closed-enum alt text',
    async (_name, source) => {
      const result = await render(renderer, source);
      expect(result.error).toBeUndefined();
      expect(result.html).toContain('<img');
      expect(result.html).toContain('class="diagram-embed mermaid-embed"');
      expect(result.html).toContain('data-crowi-renderer-presentation="diagram"');
      expect(result.html).toContain('data-crowi-renderer-state="ready"');
      expect(result.html).toContain('src="data:image/svg+xml;base64,');
      // alt must be present and non-empty (spec §2 layer 3 — never empty, never omitted).
      const altMatch = /alt="([^"]*)"/.exec(result.html);
      expect(altMatch).toBeTruthy();
      expect(altMatch?.[1]).toBeTruthy();
      expect(altMatch?.[1]).toMatch(/^Mermaid diagram(\s\([a-z-]+\))?$/);
      // AC1/AC14 — decode the base64 payload and verify the sanitizer's
      // own structural invariant (single, unprefixed SVG-namespace root)
      // holds all the way through the real plugin pipeline, not just at
      // the sanitizer's own unit-test level.
      const decodedSvg = decodeSvgDataUrl(result.html);
      expectWellFormedUnprefixedSvgRoot(decodedSvg);
      // Regression: Mermaid's SVG declares `width="100%"` with no
      // absolute height, so a bare `<img src="data:...">` has no
      // resolvable intrinsic size inside RendererPresentation's
      // `inline-block` wrapper (whose own width is itself `auto`) — the
      // two collapse to 0×0 in the browser (confirmed via a live DOM
      // inspection: `naturalWidth`/`naturalHeight` decode fine, but
      // `offsetHeight` is 0). The `<img>` tag must carry explicit
      // `width`/`height` attributes, independently of the `data:`
      // payload, matching the decoded SVG's own `viewBox` dimensions.
      const dimsMatch = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*["']/.exec(decodedSvg);
      expect(dimsMatch).toBeTruthy();
      const expectedWidth = Math.round(Number(dimsMatch?.[1]));
      const expectedHeight = Math.round(Number(dimsMatch?.[2]));
      expect(result.html).toContain(`width="${expectedWidth}"`);
      expect(result.html).toContain(`height="${expectedHeight}"`);
      // RFC-0023 §10 — the crowiDiagram structured sidecar: a PNG
      // raster of the SAME sanitized SVG the html embeds. Native
      // clients cannot draw Mermaid's SVG (`rasterize-png.ts` documents
      // the per-diagram-type failures), so the sidecar carries pixels
      // and the html above keeps the vector.
      const node = sidecarNodeOf(result);
      expect(node?.alt).toBe(altMatch?.[1]);
      await expectDecodablePngSidecar(node, { width: expectedWidth, height: expectedHeight });
    },
    30_000,
  );

  it('computeEmbedKey hashes the source deterministically (sha256) — same source ⇒ same key, different source ⇒ different key', () => {
    expect(renderer.computeEmbedKey).toBeDefined();
    const a = renderer.computeEmbedKey?.({ lang: 'mermaid', source: 'flowchart TD\n  A --> B' });
    const aAgain = renderer.computeEmbedKey?.({ lang: 'mermaid', source: 'flowchart TD\n  A --> B' });
    const b = renderer.computeEmbedKey?.({ lang: 'mermaid', source: 'flowchart TD\n  A --> C' });
    expect(a).toBe(aAgain);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('declares admissionControl / previewPolicy / cacheVersion / reservation per spec §6/§7 (cacheVersion 5 — PNG sidecar bump)', () => {
    expect(renderer.cacheVersion).toBe(5);
    expect(renderer.admissionControl).toEqual({ maxConcurrentGlobal: 4, maxConcurrentPerUser: 2, queueDepth: 200 });
    expect(renderer.previewPolicy).toBe('server-render');
    expect(renderer.reservation).toEqual({ variant: 'aspect', aspectRatio: 16 / 9 });
  });
});

describe('@crowi/plugin-renderer-mermaid — gantt charts (regression: jsdom offsetWidth always 0, not undefined)', () => {
  const renderer = createMermaidRenderer();

  it("renders a gantt chart with a positive, non-degenerate viewBox width (not the 0-width/negative-bar layout jsdom's unpolyfilled offsetWidth used to produce)", async () => {
    const source = [
      'gantt',
      '  title Release schedule',
      '  dateFormat YYYY-MM-DD',
      '  section Phase1',
      '  Design :a1, 2026-07-01, 5d',
      '  Build  :a2, after a1, 10d',
    ].join('\n');
    const result = await render(renderer, source);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('<img');

    const decodedSvg = decodeSvgDataUrl(result.html);
    expectWellFormedUnprefixedSvgRoot(decodedSvg);
    const viewBoxMatch = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*["']/.exec(decodedSvg);
    expect(viewBoxMatch).toBeTruthy();
    const viewBoxWidth = Number(viewBoxMatch?.[1]);
    expect(viewBoxWidth).toBeGreaterThan(0);

    // The regression's signature wasn't limited to the viewBox — every
    // bar/section `<rect>` mermaid emits also carried a negative `width`
    // attribute (the same 0px layout budget propagated through the whole
    // chart), so a plain substring check pins that too.
    expect(decodedSvg).not.toMatch(/\bwidth="-/);

    expect(result.html).toContain(`width="${Math.round(viewBoxWidth)}"`);

    // gantt is one of the types whose SVG the native rasterizer chokes
    // on (d3's axis `<line y2="-111"/>` has no `x1`/`y1`), so it gets
    // the same decodable-PNG sidecar guarantee as the 8 corpus types.
    const viewBoxHeight = Number(viewBoxMatch?.[2]);
    await expectDecodablePngSidecar(sidecarNodeOf(result), { width: Math.round(viewBoxWidth), height: Math.round(viewBoxHeight) });
  }, 30_000);
});

describe('@crowi/plugin-renderer-mermaid — PNG sidecar: html non-regression + failure fallback', () => {
  const renderer = createMermaidRenderer();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(DIAGRAM_CORPUS.map((entry) => [entry.name, entry.source] as const))(
    '%s: the web-facing html still embeds the SVG data URL (the PNG lives ONLY in the sidecar)',
    async (_name, source) => {
      const result = await render(renderer, source);
      expect(result.html).toContain('src="data:image/svg+xml;base64,');
      expect(result.html).not.toContain('data:image/png');
      // The two payloads are independent renderings of the same
      // diagram: the html's base64 must decode back to SVG text, not to
      // the sidecar's pixels.
      expect(decodeSvgDataUrl(result.html).trimStart().startsWith('<svg')).toBe(true);
      const node = sidecarNodeOf(result);
      expect(node?.image.base64).toBeDefined();
      expect(result.html).not.toContain(node?.image.base64 ?? ' ');
    },
    30_000,
  );

  it('a rasterization failure degrades to html-only (no structured) — never a broken sidecar, never a render error', async () => {
    jest.spyOn(rasterizePngModule, 'rasterizeSvgToPng').mockResolvedValue({ ok: false });
    const result = await render(renderer, 'flowchart TD\n  A --> B');
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('src="data:image/svg+xml;base64,');
    expect(result.html).toContain('data-crowi-renderer-state="ready"');
    expect(result.ttlSec).toBe(60 * 60);
    expect((result as { structured?: unknown }).structured).toBeUndefined();
  }, 30_000);

  it('a rasterizer that throws is NOT swallowed into a half-built sidecar — the rasterizer itself owns the never-throw contract', async () => {
    // Guards the seam the other way round: `index.ts` deliberately does
    // not wrap the call in its own try/catch, so if `rasterize-png.ts`
    // ever stopped absorbing librsvg failures, the render would surface
    // as a classification-B infra error (uncached, retried) rather than
    // silently emitting a sidecar-less-but-successful result.
    jest.spyOn(rasterizePngModule, 'rasterizeSvgToPng').mockRejectedValue(new Error('librsvg exploded'));
    await expect(render(renderer, 'flowchart TD\n  A --> B')).rejects.toThrow('librsvg exploded');
  }, 30_000);
});

describe('@crowi/plugin-renderer-mermaid — classification A: notation errors', () => {
  const renderer = createMermaidRenderer();

  it('a malformed diagram returns the fixed error HTML as a normal success (not RenderResult.error), with the explicit 5-minute TTL', async () => {
    const result = await render(renderer, 'this is not @@@ valid ### mermaid at all');
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('class="mermaid-embed mermaid-error"');
    expect(result.html).toContain('role="status"');
    expect(result.html).not.toContain('diagram-embed'); // spec §9 — error placeholder deliberately excluded from the click-to-enlarge / white-canvas class (legacy dual-accept path)
    expect(result.html).toContain('data-crowi-renderer-presentation="diagram"');
    expect(result.html).toContain('data-crowi-renderer-state="error"'); // new contract path — state="error" (not "ready") is what excludes it, spec §3.1
    expect(result.ttlSec).toBe(5 * 60);
  });

  it.each(DIAGRAM_CORPUS.map((entry) => [entry.name, entry.malformedSource] as const))(
    '%s: a source recognized as this diagram type but with broken syntax returns the fixed error HTML (spec §1 AC: per-type notation-error coverage)',
    async (_name, malformedSource) => {
      const result = await render(renderer, malformedSource);
      expect(result.error).toBeUndefined();
      expect(result.html).toContain('class="mermaid-embed mermaid-error"');
      expect(result.html).not.toContain('diagram-embed');
      expect(result.html).toContain('data-crowi-renderer-state="error"');
      expect(result.ttlSec).toBe(5 * 60);
    },
    30_000,
  );

  it('never leaks the raw source or a parse-error message into the error HTML', async () => {
    const secretLookingSource = 'totally-invalid-mermaid-syntax-CONFIDENTIAL-TOKEN-xyz123';
    const result = await render(renderer, secretLookingSource);
    expect(result.html).not.toContain('CONFIDENTIAL-TOKEN');
    expect(result.html).not.toContain(secretLookingSource);
  });

  it('a source over the 20KB limit is rejected without ever reaching the render engine', async () => {
    // Not valid Mermaid syntax either way — the point is the size check
    // (checked BEFORE the render engine / admission control, spec §6)
    // rejects it regardless of validity, so this never depends on
    // whether the content would have parsed.
    const oversized = 'x'.repeat(20 * 1024 + 1);
    const result = await render(renderer, oversized);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('mermaid-error');
    expect(result.ttlSec).toBe(5 * 60);
  });
});

describe('@crowi/plugin-renderer-mermaid — §3 input-side rejection (config directives + external resource shapes)', () => {
  const renderer = createMermaidRenderer();

  it('rejects a %%{init:...}%% directive anywhere in the source (not just the first line)', async () => {
    const source = ['flowchart TD', '  A --> B', '  %%{init: {"theme": "dark", "securityLevel": "loose"}}%%'].join('\n');
    const result = await render(renderer, source);
    expect(result.html).toContain('mermaid-error');
    expect(result.ttlSec).toBe(5 * 60);
  });

  it('rejects a frontmatter config block', async () => {
    const source = ['---', 'config:', '  theme: forest', '---', 'flowchart TD', '  A --> B'].join('\n');
    const result = await render(renderer, source);
    expect(result.html).toContain('mermaid-error');
  });

  it('rejects the image-shape (`@{ img: ... }`) diagnostic source Phase 0 confirmed reaches for a network image mid-render', async () => {
    const result = await render(renderer, DIAGNOSTIC_IMAGE_SHAPE_SOURCE);
    expect(result.html).toContain('mermaid-error');
    // Rejected at the input-side scan — the render engine (and therefore
    // the network boundary) is never even reached for this source.
  });

  it('does not reject a benign source that merely mentions "img" outside a shape-data block', async () => {
    const source = ['flowchart TD', '  A[This node mentions img in its label] --> B'].join('\n');
    const result = await render(renderer, source);
    expect(result.html).toContain('<img');
    expect(result.html).not.toContain('mermaid-error');
  }, 30_000);
});

describe('@crowi/plugin-renderer-mermaid — alt-attribute adversarial test (spec §9)', () => {
  it('never includes attacker-controlled source text in the alt attribute, even when the source is crafted to break out of the attribute', () => {
    const adversarial = '" onerror=alert(1) x="\nflowchart TD\n  A --> B';
    const alt = buildAltText(adversarial);
    expect(alt).not.toContain('onerror');
    expect(alt).not.toContain('"');
    expect(alt).not.toContain(adversarial);
    // Falls back to the fixed string — the adversarial first line matches none of the closed-enum diagram-type keywords.
    expect(alt).toBe('Mermaid diagram');
  });

  it('a legitimate flowchart first line still resolves to the closed-enum value', () => {
    expect(buildAltText('flowchart TD\n  A --> B')).toBe('Mermaid diagram (flowchart)');
  });

  // AC (adversarial alt test) requires checking the actual `alt` attribute
  // on the FINAL RENDERED `<img>` — not just `buildAltText`'s isolated
  // return value (which the two tests above already cover). This
  // exercises the full `createMermaidRenderer().render()` pipeline
  // (§3 scan → render engine → sanitize → encode → HTML assembly) with
  // the attribute-breaking string on the source's first non-blank line,
  // wrapped in a `%%` Mermaid comment (stripped by Mermaid's own
  // preprocessor, NOT `%%{...}%%` so `reject-patterns.ts` §3(a) does not
  // reject it) so the diagram still renders successfully to an `<img>`
  // rather than falling into the classification-A error-HTML path (which
  // has no `alt` attribute at all — that path is already covered above
  // via `buildAltText`, but only a real success render proves the value
  // that `buildAltText` returns is what actually lands, HTML-escaped, in
  // the generated markup).
  const renderer = createMermaidRenderer();

  it('a real render() call with the adversarial string on the first source line never leaks it into the generated <img alt="...">', async () => {
    const adversarial = ['%% " onerror=alert(1) x="', 'flowchart TD', '  A --> B'].join('\n');
    const result = await render(renderer, adversarial);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('<img');
    const altMatch = /alt="([^"]*)"/.exec(result.html);
    expect(altMatch).toBeTruthy();
    const alt = altMatch?.[1] ?? '';
    expect(alt).not.toContain('onerror');
    expect(alt).not.toContain(adversarial);
    // First non-blank line is the `%%` comment, which matches none of the
    // closed-enum diagram-type keywords ⇒ falls back to the fixed string.
    expect(alt).toBe('Mermaid diagram');
  }, 30_000);
});

describe('@crowi/plugin-renderer-mermaid — classification A: output size exceeded, per diagram type (spec §1 AC: "8種それぞれについて...出力サイズ超過系...をカバーする")', () => {
  const renderer = createMermaidRenderer();

  afterEach(() => {
    // Restore the real `encodeSvgToDataUrl` after every test in this
    // block — this describe runs AFTER the real-encoding describes
    // above in file-declaration order (Jest executes `it`s in that
    // order), so those already ran unmocked; this cleanup only matters
    // for tests declared after this block (none today) and for
    // isolating each `it.each` iteration from the next.
    jest.restoreAllMocks();
  });

  it('an oversized sanitized SVG (encodeSvgToDataUrl rejects) returns the fixed error HTML, not RenderResult.error', async () => {
    jest.spyOn(encodeSvgModule, 'encodeSvgToDataUrl').mockReturnValue({ ok: false });
    const result = await render(renderer, 'flowchart TD\n  A --> B');
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('class="mermaid-embed mermaid-error"');
    expect(result.html).toContain('data-crowi-renderer-state="error"');
    expect(result.ttlSec).toBe(5 * 60);
  }, 30_000);

  it.each(DIAGRAM_CORPUS.map((entry) => [entry.name, entry.source] as const))(
    '%s: an oversized sanitized SVG returns the fixed error HTML',
    async (_name, source) => {
      jest.spyOn(encodeSvgModule, 'encodeSvgToDataUrl').mockReturnValue({ ok: false });
      const result = await render(renderer, source);
      expect(result.error).toBeUndefined();
      expect(result.html).toContain('class="mermaid-embed mermaid-error"');
      expect(result.html).not.toContain('diagram-embed');
      expect(result.html).toContain('data-crowi-renderer-state="error"');
      expect(result.ttlSec).toBe(5 * 60);
    },
    30_000,
  );
});
