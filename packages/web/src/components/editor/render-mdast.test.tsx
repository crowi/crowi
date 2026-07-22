import type { RenderContext } from '@crowi/plugin-api';
import { _shutdownSingletonForTest, createMermaidRenderer } from '@crowi/plugin-renderer-mermaid';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { renderMdastToReactNode } from './render-mdast';

describe('renderMdastToReactNode', () => {
  it('forwards data-source-line from mdast.data.hProperties to the rendered DOM attribute', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          data: { hProperties: { 'data-source-line': 3 } },
          children: [{ type: 'text', value: 'hello' }],
        },
        {
          type: 'heading',
          depth: 2,
          data: { hProperties: { 'data-source-line': 7 } },
          children: [{ type: 'text', value: 'world' }],
        },
      ],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);
    expect(html).toContain('data-source-line="3"');
    expect(html).toContain('data-source-line="7"');
  });

  // feature-plugin-renderer-mermaid spec §7 item 6 — a `code` → `html`
  // replacement node (what `renderCodeBlockForPreview`,
  // `packages/api/src/renderer/cache/index.ts`, produces for a
  // `previewPolicy: 'server-render'` fence) carries NO `position` and
  // therefore no `data.hProperties` route for `data-source-line` — the
  // mdast `html` handler always emits `{type:'raw', ...}`, and
  // `mdast-util-to-hast`'s `applyData` only copies `data.hProperties`
  // when the result becomes a hast `element` (never true for `raw`). So
  // `renderCodeBlockForPreview` embeds `data-source-line="N"` directly
  // into the HTML STRING instead. This test proves that string survives
  // the real `toHast → hast-util-raw → toJsxRuntime` pipeline — not a
  // false-positive check of the mdast tree's fields, which this
  // replacement node structurally lacks. The other top-level blocks
  // (heading / paragraph, same mdast alongside it) keep using the
  // existing `data.hProperties` route unmodified, proving the two
  // mechanisms coexist without one clobbering the other.
  it('a code→html replacement node with data-source-line embedded in its HTML string survives toHast→hast-util-raw alongside the existing hProperties route on other top-level blocks', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'heading',
          depth: 1,
          data: { hProperties: { 'data-source-line': 1 } },
          children: [{ type: 'text', value: 'Title' }],
        },
        {
          type: 'paragraph',
          data: { hProperties: { 'data-source-line': 3 } },
          children: [{ type: 'text', value: 'intro' }],
        },
        // No `position` / `data` at all — matches what `rewriteChildren`
        // (`code-block-dispatch.ts`) actually produces: a fresh `{type:
        // 'html', value}` node with the anchor baked into `value` by
        // `renderCodeBlockForPreview`.
        {
          type: 'html',
          value: '<div data-source-line="5"><img class="diagram-embed mermaid-embed" alt="Mermaid diagram" src="data:image/svg+xml;base64,PHN2Zy8+"></div>',
        },
      ],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    // The other top-level blocks' hProperties-driven anchors still work.
    expect(html).toContain('data-source-line="1"');
    expect(html).toContain('data-source-line="3"');
    // The code-block replacement's HTML-string-embedded anchor survives too.
    expect(html).toContain('data-source-line="5"');
    expect(html).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
  });

  it('renders an unknown inline tag as the literal text the author typed', () => {
    // `shows "No <thing> yet" tooltip` — `<thing>` is a documentation
    // placeholder and must stay visible, not vanish into an empty
    // unknown DOM element (which also makes React warn).
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'No ' },
            { type: 'html', value: '<thing>' },
            { type: 'text', value: ' yet' },
          ],
        },
      ],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);
    // The `<` is HTML-escaped in the serialised output, i.e. shown verbatim.
    expect(html).toContain('No &lt;thing&gt; yet');
  });

  it('keeps known HTML tags intact', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'html', value: '<kbd>' },
            { type: 'text', value: 'Ctrl' },
            { type: 'html', value: '</kbd>' },
          ],
        },
      ],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);
    expect(html).toContain('<kbd>Ctrl</kbd>');
  });

  // feature-renderer-plugin-boundary Phase 1, AC "raw HTML の data attribute
  // が stripUnknownElements と JSX conversion を通過する test" — the new
  // `data-crowi-renderer-presentation`/`data-crowi-renderer-state` contract
  // (spec §3.1) is only useful to `page-content.tsx` / `markdown-preview.tsx`
  // if it survives the real `toHast → raw() → stripUnknownElements →
  // toJsxRuntime` pipeline unchanged, on both a `<div>` root (PlantUML's
  // inline SVG shape) and an `<img>` root (PlantUML's PNG fallback / Mermaid's
  // success shape) — `div`/`img` are already known tags (`known-tags.ts`), so
  // `stripUnknownElements` never touches them, but this proves that end to
  // end with literal HTML fixtures rather than trusting the reasoning.
  it('a raw <div>/<img> carrying the new data-crowi-renderer-presentation/-state attributes survives toHast→raw→stripUnknownElements→toJsxRuntime unchanged', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'html',
          value:
            '<div data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready"><svg></svg></div>' +
            '<img data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready" alt="diagram" src="data:image/svg+xml;base64,PHN2Zy8+">' +
            '<div data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="error">boom</div>',
        },
      ],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    expect(html).toContain('<div data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready"><svg');
    expect(html).toContain(
      'data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready" alt="diagram" src="data:image/svg+xml;base64,PHN2Zy8+"',
    );
    expect(html).toContain('<div data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="error">boom</div>');
  });

  // feature-plugin-renderer-mermaid Phase 1, AC "実際の hast-util-raw → JSX
  // 変換後のDOMに実行可能な形で残らないこと" — `hast-util-raw` (the actual
  // module that turns the plugin's `html` mdast node into hast, then
  // `hast-util-to-jsx-runtime` into React elements) only lives in
  // `@crowi/web` (`render-mdast.ts`'s own `toHast → raw → toJsxRuntime`
  // pipeline, RFC-0015's "renderer HTML is a no-sanitize environment" seam
  // — see that file's doc comment). `@crowi/api`'s
  // `renderer/__fixtures__/mermaid.e2e.test.ts` proves the *string* the
  // real `@crowi/plugin-renderer-mermaid` plugin returns for a
  // script/onload/javascript:-laden diagram label never contains those
  // substrings; THIS test proves the complementary half — running that
  // exact `<img class="diagram-embed mermaid-embed" ...>` shape (spec §2
  // layer 3: opaque base64 `data:image/svg+xml;base64,...` `src`, the
  // ONLY thing this package ever receives from the plugin) through the
  // real production `hast-util-raw` → `hast-util-to-jsx-runtime` pipeline
  // still produces markup with no executable script/handler/URL-scheme —
  // even in the worst case where an adversarial payload made it into the
  // pre-base64 SVG bytes (a data: URI `src` is inert image data to the
  // browser regardless of what its decoded bytes contain; this test
  // proves the web-side conversion step doesn't accidentally undo that).
  it('a Mermaid <img> whose base64 payload embeds script/onerror/javascript: bytes never resurfaces them as executable markup after hast-util-raw/JSX', () => {
    const maliciousSvgBytes = '<svg><text><script>alert(1)</script> onerror=alert(2) javascript:alert(3)</text></svg>';
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(maliciousSvgBytes).toString('base64')}`;
    const mermaidImgHtml = `<img class="diagram-embed mermaid-embed" alt="Mermaid diagram" src="${dataUrl}">`;
    const mdast = { type: 'root', children: [{ type: 'html', value: mermaidImgHtml }] };

    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  // feature-plugin-renderer-mermaid Phase 1 (round-4 re-review): the test
  // above proves the DEFENSE-IN-DEPTH property (even if the sanitizer were
  // ever bypassed, the base64 `src` stays inert through hast-util-raw/JSX).
  // This test proves the actual end-to-end claim the AC asks for — the
  // REAL `@crowi/plugin-renderer-mermaid` renderer (real mermaid + jsdom +
  // `@crowi/plugin-renderer-svg-sanitize`, forked child-process worker,
  // same code path `mermaid.e2e.test.ts` drives from `@crowi/api`) is
  // fed the same sanitize-target diagram label, and the `<img>` HTML it
  // genuinely returns — not a hand-built string — is what gets pushed
  // through `hast-util-raw` → `hast-util-to-jsx-runtime`. `@crowi/web` has
  // no dependency on `@crowi/api`/`@crowi/plugin-renderer-mermaid` in
  // production code; this import is test-only (`package.json`
  // devDependencies) precisely so this seam can be verified for real
  // without creating a production layering violation — see `render-
  // mdast.ts`'s own doc comment for why the conversion pipeline lives
  // only here.
  describe('a genuine @crowi/plugin-renderer-mermaid render() output, run through the real pipeline', () => {
    afterAll(async () => {
      await _shutdownSingletonForTest();
    });

    it('never resurfaces script/onload/javascript: bytes from the diagram label as executable markup', async () => {
      const ctx: RenderContext = {
        mode: 'save',
        log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        actor: { kind: 'system' },
      };
      const source = ['flowchart TD', '  A["<script>alert(1)</script> onerror=alert(2) javascript:alert(3)"] --> B'].join('\n');

      const result = await createMermaidRenderer().render({ lang: 'mermaid', source }, ctx);
      if ('error' in result && result.error) throw new Error(`expected a successful render, got error=${JSON.stringify(result.error)}`);
      const mermaidImgHtml = result.html;

      // Sanity: this really is the plugin's real self-contained <img>
      // shape, not an error placeholder — otherwise the assertions below
      // would trivially pass against an unrelated `<div>`.
      expect(mermaidImgHtml).toContain('<img');
      expect(mermaidImgHtml).toContain('class="diagram-embed mermaid-embed"');
      expect(mermaidImgHtml).toContain('src="data:image/svg+xml;base64,');

      const mdast = { type: 'root', children: [{ type: 'html', value: mermaidImgHtml }] };
      const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
      const html = renderToStaticMarkup(node);

      expect(html).toContain('data:image/svg+xml;base64,');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\son\w+\s*=/i);
      expect(html).not.toMatch(/javascript:/i);
    }, 30_000);
  });
});

/**
 * `@crowi/plugin-renderer-link-card` integration fixture (reviewer
 * finding: the renderer package's own `render-card.test.ts` only
 * verified the emitted string's tag names via a regex scan — it never
 * exercised the ACTUAL front-end pipeline this HTML is injected into).
 * The two fixtures below are the byte-for-byte output of that
 * package's `renderCard()` / `renderErrorCard()` for a representative
 * input (verified by invoking them directly — see this test's git
 * history for the generating call). Pulling the plugin package itself
 * in as a dependency of `@crowi/web` would be the wrong direction (web
 * never depends on api-side renderer plugins at runtime); a literal,
 * clearly-labelled fixture here keeps that boundary while still
 * running the REAL `toHast -> raw -> stripUnknownElements ->
 * toJsxRuntime` pipeline (the same one `page-content.tsx` and
 * `MarkdownPreview.tsx` both call through via `renderMdastToReactNode`)
 * against it. If `render-card.ts`'s output shape changes, regenerate
 * these two strings from it and update both fixtures together.
 */
describe('link-card embed HTML (@crowi/plugin-renderer-link-card) survives the real render pipeline', () => {
  const FULL_CARD_HTML =
    '<figure class="crowi-link-card"><a class="crowi-link-card-link" href="https://example.test/page" target="_blank" rel="noopener noreferrer"><div class="crowi-link-card-body"><div class="crowi-link-card-title">&lt;script&gt;alert(1)&lt;/script&gt; Title</div><div class="crowi-link-card-description">Some description text.</div><div class="crowi-link-card-meta"><span class="crowi-link-card-site-name">Example Site</span><span class="crowi-link-card-domain">example.test</span></div></div><img class="crowi-link-card-image" alt="" loading="lazy" src="https://example.test/img.png"></a></figure>';

  const ERROR_CARD_HTML =
    '<figure class="crowi-link-card crowi-link-card-error"><a class="crowi-link-card-link" href="https://example.test/unreachable" target="_blank" rel="noopener noreferrer"><div class="crowi-link-card-body"><div class="crowi-link-card-title">example.test</div><span class="crowi-link-card-error-label">Preview unavailable</span></div></a></figure>';

  function renderHtmlNode(html: string): string {
    const mdast = { type: 'root', children: [{ type: 'html', value: html }] };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    return renderToStaticMarkup(node);
  }

  it('preserves the full card structure — every emitted tag (figure/a/div/span/img) survives stripUnknownElements untouched', () => {
    const html = renderHtmlNode(FULL_CARD_HTML);
    for (const tag of ['figure', 'a', 'div', 'span', 'img']) {
      expect(html).toContain(`<${tag}`);
    }
    // Structure + attributes survive intact.
    expect(html).toContain('class="crowi-link-card"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('src="https://example.test/img.png"');
    // Text content (title/description/site-name/domain) survives.
    expect(html).toContain('Some description text.');
    expect(html).toContain('Example Site');
    expect(html).toContain('example.test');
  });

  it('never re-parses the already-escaped XSS fixture in the title into a live <script> element', () => {
    const html = renderHtmlNode(FULL_CARD_HTML);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('preserves the error-card structure — the link stays a working, clickable anchor', () => {
    const html = renderHtmlNode(ERROR_CARD_HTML);
    expect(html).toContain('href="https://example.test/unreachable"');
    expect(html).toContain('Preview unavailable');
    expect(html).toContain('class="crowi-link-card crowi-link-card-error"');
  });
});
