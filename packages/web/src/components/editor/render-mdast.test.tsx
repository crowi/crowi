import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { toHast } from 'mdast-util-to-hast';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { renderMdastToReactNode, renderMdastToReactResult } from './render-mdast';

/** Render a bare root's children through the real helper, with no caller-supplied components. */
const render = (children: unknown[]): string =>
  renderToStaticMarkup(renderMdastToReactNode({ type: 'root', children }, { sectionWrap: false, components: {} }));

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
          data: { g: 1 },
          value: '<div data-source-line="5"><img class="diagram-embed fake-diagram-embed" alt="Diagram" src="data:image/svg+xml;base64,PHN2Zy8+"></div>',
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
  // toJsxRuntime` pipeline unchanged, on both a `<div>` root (a diagram
  // renderer's inline SVG shape) and an `<img>` root (a diagram renderer's
  // PNG-fallback / data-URL success shape) — `div`/`img` are already known tags (`known-tags.ts`), so
  // `stripUnknownElements` never touches them, but this proves that end to
  // end with literal HTML fixtures rather than trusting the reasoning.
  it('a raw <div>/<img> carrying the new data-crowi-renderer-presentation/-state attributes survives toHast→raw→stripUnknownElements→toJsxRuntime unchanged', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'html',
          data: { g: 1 },
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
  // — see that file's doc comment). Each diagram producer plugin's own
  // test suite (e.g. `packages/plugin-renderer-mermaid/src/index.test.ts`)
  // proves the *string* the real plugin returns for a
  // script/onload/javascript:-laden diagram label never contains those
  // substrings; THIS test proves the complementary half — running that
  // exact `<img class="diagram-embed fake-diagram-embed" ...>` shape (spec
  // §2 layer 3: opaque base64 `data:image/svg+xml;base64,...` `src`, the
  // ONLY thing this package ever receives from a diagram renderer plugin)
  // through the real production `hast-util-raw` → `hast-util-to-jsx-runtime`
  // pipeline still produces markup with no executable script/handler/URL-scheme —
  // even in the worst case where an adversarial payload made it into the
  // pre-base64 SVG bytes (a data: URI `src` is inert image data to the
  // browser regardless of what its decoded bytes contain; this test
  // proves the web-side conversion step doesn't accidentally undo that).
  it('a diagram <img> whose base64 payload embeds script/onerror/javascript: bytes never resurfaces them as executable markup after hast-util-raw/JSX', () => {
    const maliciousSvgBytes = '<svg><text><script>alert(1)</script> onerror=alert(2) javascript:alert(3)</text></svg>';
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(maliciousSvgBytes).toString('base64')}`;
    const diagramImgHtml = `<img class="diagram-embed fake-diagram-embed" alt="Diagram" src="${dataUrl}">`;
    const mdast = { type: 'root', children: [{ type: 'html', data: { g: 1 }, value: diagramImgHtml }] };

    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  // feature-renderer-plugin-boundary Phase 2 (§1/§4) — this suite
  // previously fed a REAL `@crowi/plugin-renderer-mermaid` render() output
  // (real mermaid + jsdom + the svg sanitizer, now `@crowi/svg-sanitize`,
  // forked child-process worker) through the pipeline here, to prove the
  // sanitizer's real output survives `hast-util-raw`/JSX unchanged. That
  // real-plugin production seam moved to the plugin's own test suite
  // (`render-engine.test.ts`, `index.test.ts`) plus the reference-runner
  // integration suite (`packages/e2e/tests/renderer-plugins.spec.ts`) —
  // `@crowi/web` no longer depends on any optional renderer package, even
  // as a devDependency (spec §4's own boundary rule applies to test code
  // too). This adversarial literal fixture keeps the WEB-side half of the
  // claim (the defense-in-depth test above proves it for the legacy
  // class-only shape; this one additionally carries the new
  // `data-crowi-renderer-presentation`/`data-crowi-renderer-state`
  // contract spec §3.1 introduces, so both output shapes are pinned).
  it('a diagram <img> carrying the new data-crowi-renderer-* contract, whose base64 payload embeds script/onerror/javascript: bytes, never resurfaces them as executable markup after hast-util-raw/JSX', () => {
    const maliciousSvgBytes = '<svg><text><script>alert(1)</script> onerror=alert(2) javascript:alert(3)</text></svg>';
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(maliciousSvgBytes).toString('base64')}`;
    const diagramImgHtml = `<img class="diagram-embed fake-diagram-embed" data-crowi-renderer-presentation="diagram" data-crowi-renderer-state="ready" alt="Diagram" src="${dataUrl}">`;
    const mdast = { type: 'root', children: [{ type: 'html', data: { g: 1 }, value: diagramImgHtml }] };

    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    expect(html).toContain('data-crowi-renderer-presentation="diagram"');
    expect(html).toContain('data-crowi-renderer-state="ready"');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });
});

/**
 * feature-renderer-break-normalization AC-8 — renderer parity between an
 * mdast `html("<br>")` node (what a bare `<br>` used to stay as) and the
 * `break` node `core/break-normalization.ts` now normalizes it to.
 * `mdast-util-to-hast`'s `html` handler emits one `raw` node containing
 * the literal string, which `hast-util-raw` then parses into a single
 * `<br>` element; its `break` handler instead directly emits a `<br>`
 * element PLUS a sibling `{ type: 'text', value: '\n' }` (`break.js`'s
 * `hardBreak`). Both inputs therefore produce the SAME single `<br>`
 * element in the SAME position with the SAME surrounding visible text —
 * this is what makes the two byte-different trees render identically
 * (D-3) — but they are not byte-identical: only the `break` side carries
 * the extra (CSS-collapsed, invisible in prose) newline text node. Each
 * input gets its OWN expectation rather than one shared assertion.
 */
describe('html("<br>") vs break render parity (feature-renderer-break-normalization AC-8)', () => {
  const paragraphWith = (breakNode: unknown) => [{ type: 'paragraph', children: [{ type: 'text', value: 'a' }, breakNode, { type: 'text', value: 'b' }] }];

  const tableWith = (breakNode: unknown) => [
    {
      type: 'table',
      align: [null],
      children: [
        { type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: 'h' }] }] },
        { type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: 'a' }, breakNode, { type: 'text', value: 'b' }] }] },
      ],
    },
  ];

  it('paragraph: `html("<br>")` renders one `<br>` element between "a" and "b", with no injected text node', () => {
    const html = render(paragraphWith({ type: 'html', value: '<br>' }));
    expect(html).toBe('<p>a<br/>b</p>');
  });

  it('paragraph: `break` renders the same single `<br>` element between "a" and "b", plus its own newline text node', () => {
    const html = render(paragraphWith({ type: 'break' }));
    expect(html).toBe('<p>a<br/>\nb</p>');
  });

  it('tableCell: `html("<br>")` renders one `<br>` element between "a" and "b", with no injected text node', () => {
    const html = render(tableWith({ type: 'html', value: '<br>' }));
    expect(html).toContain('<td>a<br/>b</td>');
  });

  it('tableCell: `break` renders the same single `<br>` element between "a" and "b", plus its own newline text node', () => {
    const html = render(tableWith({ type: 'break' }));
    expect(html).toContain('<td>a<br/>\nb</td>');
  });
});

/**
 * Link-card embed HTML integration fixture (reviewer finding: the
 * renderer's own `render-card.test.ts` only verified the emitted
 * string's tag names via a regex scan — it never exercised the ACTUAL
 * front-end pipeline this HTML is injected into). The two fixtures
 * below are literal, clearly-labelled HTML strings — not pulled from a
 * live import (web never depends on api-side renderer code at
 * runtime) — so this test can still run the REAL `toHast -> raw ->
 * stripUnknownElements -> toJsxRuntime` pipeline (the same one
 * `page-content.tsx` and `MarkdownPreview.tsx` both call through via
 * `renderMdastToReactNode`) against it while keeping that boundary.
 * `FULL_CARD_HTML` is the current `renderCard()` success shape
 * (`packages/api/src/renderer/core/link-card/render-card.ts`);
 * `ERROR_CARD_HTML` is the now-legacy `renderErrorCard()` shape a
 * page saved before Phase 3 may still have persisted (Phase 3 replaced
 * it with a unified fallback card for all NEW renders — see that
 * file's `renderFallbackCard()` — but old saved `renderedAst` content
 * isn't migrated, so the pipeline must still render this shape safely
 * for those pages until they're re-rendered). If either function's
 * output shape changes, regenerate the corresponding string and update
 * the fixture.
 */
describe('link-card embed HTML survives the real render pipeline', () => {
  const FULL_CARD_HTML =
    '<figure class="crowi-link-card"><a class="crowi-link-card-link" href="https://example.test/page" target="_blank" rel="noopener noreferrer"><div class="crowi-link-card-body"><div class="crowi-link-card-title">&lt;script&gt;alert(1)&lt;/script&gt; Title</div><div class="crowi-link-card-description">Some description text.</div><div class="crowi-link-card-meta"><span class="crowi-link-card-site-name">Example Site</span><span class="crowi-link-card-domain">example.test</span></div></div><img class="crowi-link-card-image" alt="" loading="lazy" src="https://example.test/img.png"></a></figure>';

  // Legacy pre-Phase-3 renderErrorCard() shape — see the fixture doc
  // comment above for why this is still exercised.
  const ERROR_CARD_HTML =
    '<figure class="crowi-link-card crowi-link-card-error"><a class="crowi-link-card-link" href="https://example.test/unreachable" target="_blank" rel="noopener noreferrer"><div class="crowi-link-card-body"><div class="crowi-link-card-title">example.test</div><span class="crowi-link-card-error-label">Preview unavailable</span></div></a></figure>';

  function renderHtmlNode(html: string): string {
    const mdast = { type: 'root', children: [{ type: 'html', data: { g: 1 }, value: html }] };
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

/**
 * feature-renderer-frontmatter §D-5 / AC-11 / AC-9 — `crowiFrontmatter`
 * renders as a `<dl>` of `<dt>`/`<dd>` pairs (not `<table>`, see
 * `render-mdast.ts`'s `crowiFrontmatterHandler` doc comment), and every
 * entry value is a plain hast `text` node — never re-parsed as Markdown,
 * so `*`/`[` in a value must survive as literal characters, not emphasis
 * or a link.
 */
describe('crowiFrontmatter rendering (feature-renderer-frontmatter)', () => {
  it('renders entries as an ordered dl/dt/dd list distinguishable from body text (AC-11)', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'crowiFrontmatter',
          entries: [
            { key: 'id', value: 'feature-foo' },
            { key: 'status', value: 'approved' },
          ],
        },
        { type: 'paragraph', children: [{ type: 'text', value: 'body' }] },
      ],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    expect(html).toContain('<dl class="crowi-frontmatter">');
    expect(html).toContain('<dt>id</dt>');
    expect(html).toContain('<dd>feature-foo</dd>');
    expect(html).toContain('<dt>status</dt>');
    expect(html).toContain('<dd>approved</dd>');
    // Renders BEFORE the body paragraph, matching document order.
    expect(html.indexOf('crowi-frontmatter')).toBeLessThan(html.indexOf('body'));
  });

  it('renders an entry value containing `*`/`[` as literal text, never re-parsed as Markdown emphasis/link syntax (AC-9)', () => {
    const mdast = {
      type: 'root',
      children: [{ type: 'crowiFrontmatter', entries: [{ key: 'note', value: '*starred* and [bracketed]' }] }],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    expect(html).toContain('<dd>*starred* and [bracketed]</dd>');
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<a ');
  });

  it('forwards data-source-line from mdast.data.hProperties onto the rendered dl, matching every other top-level block', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'crowiFrontmatter',
          data: { hProperties: { 'data-source-line': 1 } },
          entries: [{ key: 'id', value: 'feature-foo' }],
        },
      ],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    expect(html).toContain('data-source-line="1"');
  });

  it('keeps the fixed dl/dt/dd shape and crowi-frontmatter class even when node.data carries hName/hChildren/className (AC-11 shape guarantee)', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'crowiFrontmatter',
          entries: [{ key: 'id', value: 'feature-foo' }],
          data: {
            hName: 'section',
            hChildren: [{ type: 'text', value: 'overwritten' }],
            hProperties: { className: ['other'], 'data-source-line': 1 },
          },
        },
      ],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    expect(html).toMatch(/<dl[^>]*class="crowi-frontmatter"[^>]*>/);
    expect(html).toContain('data-source-line="1"');
    expect(html).toContain('<dt>id</dt>');
    expect(html).toContain('<dd>feature-foo</dd>');
    expect(html).not.toContain('<section');
    expect(html).not.toContain('overwritten');
  });

  it('keeps the fixed crowi-frontmatter class even when node.data.hProperties smuggles a `class` alias alongside `className` (AC-11 shape guarantee)', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'crowiFrontmatter',
          entries: [{ key: 'id', value: 'feature-foo' }],
          data: { hProperties: { className: ['other'], class: 'evil', 'data-source-line': 1 } },
        },
      ],
    };
    const node = renderMdastToReactNode(mdast, { sectionWrap: false, components: {} });
    const html = renderToStaticMarkup(node);

    expect(html).toMatch(/<dl[^>]*class="crowi-frontmatter"[^>]*>/);
    expect(html).toContain('data-source-line="1"');
    expect(html).not.toContain('class="evil"');
    expect(html).not.toContain('other');
  });
});

/**
 * RFC-0023 §1 — sidecar invisibility regression guard. Producers stamp
 * typed sidecars (`data.crowiCode` / `crowiMath` / `crowiDiagram` /
 * `crowiLinkCard` / `crowiPlaceholder`) onto their `html` nodes;
 * `mdast-util-to-hast`'s `applyData` only ever reads `hName` /
 * `hProperties` / `hChildren`, so the rendered output of a
 * sidecar-carrying `html` node must be byte-identical to the same node
 * without the sidecar — through the REAL
 * `toHast → escapeUnknownRawHtml → raw() → toJsxRuntime` pipeline, with
 * no per-type `handlers` registered.
 */
describe('sidecar data keys are invisible to the web render pipeline (RFC-0023)', () => {
  const HTML_VALUE = '<pre class="shiki"><code><span style="--shiki-light:#111">const a = 1;</span></code></pre>';

  it.each([
    ['crowiCode', { lang: 'ts', value: 'const a = 1;', tokens: [[{ content: 'const', light: { color: '#111' }, dark: { color: '#eee' } }]] }],
    ['crowiMath', { tex: 'x^2', display: true }],
    ['crowiDiagram', { kind: 'mermaid', alt: 'd', image: { mediaType: 'image/svg+xml', base64: 'aGk=', width: 10, height: 10 } }],
    ['crowiLinkCard', { url: 'https://example.com' }],
    ['crowiPlaceholder', { kind: 'error-network', label: 'x', reservation: { variant: 'fixed', heightPx: 48 } }],
  ] as const)('an html node with a %s sidecar renders byte-identically to the same node without it', (key, payload) => {
    const withSidecar = render([{ type: 'html', value: HTML_VALUE, data: { [key]: payload } }]);
    const withoutSidecar = render([{ type: 'html', value: HTML_VALUE }]);
    expect(withSidecar).toBe(withoutSidecar);
  });
});

/**
 * A `crowiAlert` renders as a semantic `<aside>` callout with a fixed
 * English title and a decorative icon, and the literal marker the api
 * deliberately keeps in the stored AST is skipped at RENDER time only.
 */
describe('crowiAlert rendering', () => {
  /** The marker paragraph exactly as the api stores it: marker text, the delimiter `break`, then the body. */
  const markerParagraph = (marker: string, ...body: unknown[]): unknown => ({
    type: 'paragraph',
    children: [{ type: 'text', value: marker }, { type: 'break' }, ...body],
  });

  /** What the api stores: the marker text and its delimiter `break` are still there. */
  const alert = (variant: string, body: unknown[] = [{ type: 'text', value: 'body text' }], marker = `[!${variant.toUpperCase()}]`): unknown => ({
    type: 'crowiAlert',
    variant,
    data: { hName: 'blockquote' },
    children: [markerParagraph(marker, ...body)],
  });

  it.each([
    ['note', 'Note'],
    ['tip', 'Tip'],
    ['important', 'Important'],
    ['warning', 'Warning'],
    ['caution', 'Caution'],
  ])('renders the %s variant with its own class, English title, decorative icon and aria-label', (variant, label) => {
    const html = render([alert(variant)]);

    expect(html).toMatch(new RegExp(`<aside[^>]*class="crowi-alert crowi-alert-${variant}"`));
    expect(html).toContain(`data-crowi-alert-variant="${variant}"`);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
    // Static document content — announcing it as a live region would
    // interrupt the reader on every page load.
    expect(html).not.toContain('role="alert"');
  });

  it('gives all five variants distinct titles and classes', () => {
    const rendered = ['note', 'tip', 'important', 'warning', 'caution'].map((v) => render([alert(v)]));
    expect(new Set(rendered).size).toBe(5);
    // The icon markup differs too: the same `<path>` set would mean two
    // variants are only distinguishable by colour.
    const paths = rendered.map((html) => html.slice(html.indexOf('<svg'), html.indexOf('</svg>')));
    expect(new Set(paths).size).toBe(5);
  });

  it('skips the marker text and its delimiter break, keeping the rest of the body', () => {
    const html = render([alert('note')]);
    expect(html).toContain('body text');
    expect(html).not.toContain('[!NOTE]');
  });

  it('drops the marker paragraph entirely when the marker was all it held', () => {
    const html = render([
      {
        type: 'crowiAlert',
        variant: 'tip',
        data: { hName: 'blockquote' },
        children: [
          { type: 'paragraph', children: [{ type: 'text', value: '[!TIP]' }] },
          { type: 'paragraph', children: [{ type: 'text', value: 'body' }] },
        ],
      },
    ]);
    expect(html).toContain('<div class="crowi-alert-body"><p>body</p></div>');
  });

  it('renders links, emphasis, lists and nested block quotes in the body as ordinary Markdown', () => {
    const html = render([
      {
        type: 'crowiAlert',
        variant: 'note',
        data: { hName: 'blockquote' },
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', value: '[!NOTE]' },
              { type: 'break' },
              { type: 'link', url: '/page', title: null, children: [{ type: 'text', value: 'link' }] },
              { type: 'emphasis', children: [{ type: 'text', value: 'em' }] },
            ],
          },
          { type: 'list', ordered: false, children: [{ type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'item' }] }] }] },
          { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'quoted' }] }] },
        ],
      },
    ]);

    expect(html).toContain('<a href="/page">link</a>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<li>item</li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('quoted');
  });

  it('renders the same callout markup whether the caller wraps sections (page view) or not (editor preview)', () => {
    const children = [alert('note')];
    const withSections = renderToStaticMarkup(renderMdastToReactNode({ type: 'root', children }, { sectionWrap: true, components: {} }));
    const withoutSections = renderToStaticMarkup(renderMdastToReactNode({ type: 'root', children }, { sectionWrap: false, components: {} }));
    const callout = (html: string) => html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));

    expect(callout(withSections)).toContain('class="crowi-alert crowi-alert-note"');
    expect(callout(withSections)).toBe(callout(withoutSections));
  });

  describe('data-source-line forwarding', () => {
    const anchored = (value: unknown): unknown => ({
      type: 'crowiAlert',
      variant: 'note',
      data: { hName: 'blockquote', hProperties: { 'data-source-line': value } },
      children: [markerParagraph('[!NOTE]', { type: 'text', value: 'body' })],
    });

    it.each([
      ['a number', 12],
      ['a numeric string', '12'],
    ])('forwards %s anchor so the preview can scroll-sync the callout', (_label, value) => {
      expect(render([anchored(value)])).toContain('data-source-line="12"');
    });

    it.each([
      ['a boolean', true],
      ['an object', { line: 1 }],
      ['an array', [1]],
      ['null', null],
    ])('drops %s, which could never be a source line', (_label, value) => {
      const html = render([anchored(value)]);
      expect(html).not.toContain('data-source-line');
      expect(html).toContain('body');
    });

    it('emits no anchor at all for a stored alert, which carries none', () => {
      expect(render([alert('note')])).not.toContain('data-source-line');
    });
  });

  /**
   * The callout DOM is this module's own contract: the node picks which
   * of five fixed presentations to use and nothing else. Everything
   * here would otherwise be a route from page body content to the
   * rendered element's identity.
   */
  describe('the node cannot influence the callout element', () => {
    const withData = (data: unknown): unknown => ({
      type: 'crowiAlert',
      variant: 'note',
      data,
      children: [markerParagraph('[!NOTE]', { type: 'text', value: 'body' })],
    });

    it('keeps the aside when data.hName/hChildren would replace the element and its content', () => {
      const html = render([withData({ hName: 'section', hChildren: [{ type: 'text', value: 'overwritten' }] })]);
      expect(html).toMatch(/<aside[^>]*class="crowi-alert crowi-alert-note"/);
      expect(html).not.toContain('<section');
      expect(html).not.toContain('overwritten');
      expect(html).toContain('body');
    });

    it('keeps the fixed class when hProperties smuggles a `class` alias alongside className', () => {
      const html = render([withData({ hProperties: { className: ['other'], class: 'evil' } })]);
      expect(html).toContain('class="crowi-alert crowi-alert-note"');
      expect(html).not.toContain('evil');
      expect(html).not.toContain('other');
    });

    it('drops arbitrary hProperties instead of spreading them onto the element', () => {
      const html = render([withData({ hProperties: { id: 'anchor', style: 'position:fixed', onclick: 'steal()', title: 'tooltip' } })]);
      expect(html).not.toContain('id="anchor"');
      expect(html).not.toContain('position:fixed');
      expect(html).not.toContain('steal()');
      expect(html).not.toContain('tooltip');
    });

    it('ignores a variant smuggled through hProperties — the typed field decides', () => {
      const html = render([withData({ hProperties: { 'data-crowi-alert-variant': 'caution' } })]);
      expect(html).toContain('class="crowi-alert crowi-alert-note"');
      expect(html).toContain('aria-label="Note"');
      expect(html).not.toContain('caution');
    });

    it('ignores unknown top-level fields on the node', () => {
      const html = render([
        {
          type: 'crowiAlert',
          variant: 'note',
          marker: '[!CAUTION]',
          tagName: 'script',
          children: [markerParagraph('[!NOTE]', { type: 'text', value: 'body' })],
        },
      ]);
      expect(html).toMatch(/<aside[^>]*class="crowi-alert crowi-alert-note"/);
      expect(html).not.toContain('<script');
      expect(html).not.toContain('[!CAUTION]');
    });
  });

  /**
   * Skipping the marker is a rendering decision made on a shape the api
   * guarantees. When the node does not have that shape — hand-written,
   * or produced by some future transform — showing every child is the
   * only answer that cannot silently eat someone's content.
   */
  describe('marker skipping is shape-checked', () => {
    it('skips a lower-case marker the author spelled that way', () => {
      const html = render([alert('note', [{ type: 'text', value: 'body text' }], '[!note]')]);
      expect(html).not.toContain('[!note]');
      expect(html).toContain('body text');
    });

    it('keeps the marker paragraph when content follows the marker without a delimiter break', () => {
      const html = render([
        {
          type: 'crowiAlert',
          variant: 'note',
          children: [
            {
              type: 'paragraph',
              children: [
                { type: 'text', value: '[!NOTE]' },
                { type: 'text', value: 'body' },
              ],
            },
          ],
        },
      ]);
      // The transform never emits a marker butted against content with no
      // delimiter break, so this shape is not ours to strip: decorate the
      // callout but leave every child exactly as authored.
      expect(html).toContain('<p>[!NOTE]body</p>');
    });

    it.each([
      [
        'the marker text names a different variant than the node',
        { type: 'crowiAlert', variant: 'note', children: [markerParagraph('[!TIP]', { type: 'text', value: 'body' })] },
        '[!TIP]',
      ],
      [
        'the marker shares its text node with body content',
        { type: 'crowiAlert', variant: 'note', children: [markerParagraph('[!NOTE] extra', { type: 'text', value: 'body' })] },
        '[!NOTE] extra',
      ],
      [
        'the first child is not a paragraph',
        {
          type: 'crowiAlert',
          variant: 'note',
          children: [{ type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: '[!NOTE]' }] }] }],
        },
        '[!NOTE]',
      ],
      [
        'the first paragraph does not open with a text node',
        {
          type: 'crowiAlert',
          variant: 'note',
          children: [
            {
              type: 'paragraph',
              children: [
                { type: 'link', url: '/a', title: null, children: [{ type: 'text', value: '[!NOTE]' }] },
                { type: 'text', value: 'body' },
              ],
            },
          ],
        },
        '[!NOTE]',
      ],
    ] as const)('shows every child when %s', (_label, node, preserved) => {
      const html = render([node]);
      expect(html).toContain('class="crowi-alert crowi-alert-note"');
      expect(html).toContain(preserved);
    });

    it.each([
      ['no children field', undefined],
      ['an empty children array', []],
    ])('renders the titled callout with an empty body for %s', (_label, children) => {
      const html = render([{ type: 'crowiAlert', variant: 'tip', children }]);
      expect(html).toContain('<span>Tip</span>');
      expect(html).toContain('<div class="crowi-alert-body"></div>');
    });
  });

  describe('body content renders as ordinary Markdown', () => {
    it.each([
      ['an image', { type: 'image', url: '/i.png', title: null, alt: 'shot' }, 'src="/i.png"'],
      ['inline code', { type: 'inlineCode', value: 'x = 1' }, '<code>x = 1</code>'],
      ['strong text', { type: 'strong', children: [{ type: 'text', value: 'bold' }] }, '<strong>bold</strong>'],
    ] as const)('keeps %s in the marker paragraph', (_label, node, expected) => {
      expect(render([{ type: 'crowiAlert', variant: 'note', children: [markerParagraph('[!NOTE]', node)] }])).toContain(expected);
    });

    it.each([
      ['a fenced code block', { type: 'code', lang: 'ts', value: 'const a = 1;' }, 'const a = 1;'],
      ['a heading', { type: 'heading', depth: 3, children: [{ type: 'text', value: 'Heads up' }] }, '<h3>Heads up</h3>'],
      ['a thematic break', { type: 'thematicBreak' }, '<hr/>'],
      [
        'a table',
        {
          type: 'table',
          align: [null],
          children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: 'cell' }] }] }],
        },
        '<table>',
      ],
    ] as const)('keeps %s following the marker paragraph', (_label, node, expected) => {
      const html = render([
        { type: 'crowiAlert', variant: 'warning', children: [{ type: 'paragraph', children: [{ type: 'text', value: '[!WARNING]' }] }, node] },
      ]);
      expect(html).toContain(expected);
      expect(html).not.toContain('[!WARNING]');
    });
  });

  it('falls back to a plain aside — marker included — for an unknown variant', () => {
    const html = render([alert('bogus', [{ type: 'text', value: 'body' }], '[!BOGUS]')]);
    expect(html).toContain('<aside');
    expect(html).toContain('[!BOGUS]');
    expect(html).not.toContain('crowi-alert-title');
    expect(html).not.toContain('aria-label');
  });

  it('shows every child when the marker shape is not the one the producer emits (defensive fallback)', () => {
    const html = render([
      {
        type: 'crowiAlert',
        variant: 'note',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'hand-written, no marker' }] }],
      },
    ]);
    expect(html).toContain('hand-written, no marker');
    expect(html).toContain('class="crowi-alert crowi-alert-note"');
  });

  /**
   * The compatibility half of the design: a web bundle deployed BEFORE
   * this feature has no `crowiAlert` handler at all. `mdast-util-to-hast`
   * then falls back to the node's `data.hName` — which the producer
   * fixes to `blockquote` — and the preserved children put the literal
   * marker back on screen, i.e. exactly today's rendering. Reproduced
   * here by converting with NO handlers registered.
   */
  it('an alert-unaware bundle (no handler registered) still gets a standard blockquote with the literal marker', () => {
    const hast = toHast(
      {
        type: 'root',
        children: [alert('note')],
      } as Parameters<typeof toHast>[0],
      { allowDangerousHtml: true },
    );
    const html = renderToStaticMarkup(toJsxRuntime(hast as Parameters<typeof toJsxRuntime>[0], { Fragment, jsx, jsxs, passNode: false }));

    expect(html).toContain('<blockquote>');
    expect(html).toContain('[!NOTE]');
    expect(html).toContain('body text');
    expect(html).not.toContain('<aside');
  });
});

/**
 * The `aside` adapter is composed into the component map for every
 * render, so it also meets the `<aside>` elements authors write by hand
 * in raw HTML. The sanitizer removes the variant attribute (and the
 * class) from those, so the callout chrome is reachable only through a
 * `crowiAlert` node the renderer pipeline produced.
 */
describe('an author-written <aside>', () => {
  it('keeps a plain aside as an aside but drops its class (only the id survives)', () => {
    const html = render([{ type: 'html', value: '<aside class="sidebar" id="note-1">side note</aside>' }]);
    expect(html).toContain('side note');
    expect(html).not.toContain('class="sidebar"');
    expect(html).toContain('id="note-1"');
    expect(html).not.toContain('crowi-alert');
  });

  it('cannot claim the callout chrome by copying the variant attribute', () => {
    const html = render([{ type: 'html', value: '<aside data-crowi-alert-variant="note" id="x" title="t">claimed</aside>' }]);
    expect(html).toContain('claimed');
    expect(html).not.toContain('crowi-alert');
    expect(html).not.toContain('data-crowi-alert-variant');
  });

  it('leaves an aside claiming an unknown variant alone', () => {
    const html = render([{ type: 'html', value: '<aside data-crowi-alert-variant="bogus">claimed</aside>' }]);
    expect(html).toContain('claimed');
    expect(html).not.toContain('crowi-alert-title');
  });
});

/**
 * Strict HTML boundary (feature-html-sanitizer-web): every case below goes
 * through the real `toHast → sanitizer → toJsxRuntime` path and inspects the
 * final markup, never only the sanitizer's return value.
 */
describe('strict HTML boundary', () => {
  const authorHtml = (value: string) => ({ type: 'html', value });
  const generatedHtml = (value: string) => ({ type: 'html', value, data: { g: 1 } });
  const para = (...children: unknown[]) => ({ type: 'paragraph', children });
  const txt = (value: string) => ({ type: 'text', value });
  const heading = (depth: number, id: string, value: string) => ({ type: 'heading', depth, data: { hProperties: { id } }, children: [txt(value)] });

  describe('generated-preservation', () => {
    const SHIKI =
      '<pre class="shiki" style="--shiki-light:#24292e" tabindex="0"><code><span class="line"><span style="--shiki-light:#D73A49">const</span></span></code></pre>';
    const KATEX =
      '<span class="katex" style="font-size:1.2em"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html" aria-hidden="true">x</span></span>';
    const CARD =
      '<figure class="crowi-link-card"><a class="crowi-link-card-link" href="https://example.test/p" target="_blank" rel="noopener noreferrer"><div class="crowi-link-card-title">T</div></a></figure>';

    it('keeps class/style/tabindex on a marked fragment and strips the same markup written by an author', () => {
      const marked = render([generatedHtml(SHIKI)]);
      expect(marked).toContain('class="shiki"');
      expect(marked).toContain('style="--shiki-light:#24292e"');
      expect(marked).toContain('tabindex="0"');
      expect(marked).toContain('--shiki-light:#D73A49');

      const authored = render([authorHtml(SHIKI)]);
      expect(authored).toContain('const');
      expect(authored).not.toContain('class="shiki"');
      expect(authored).not.toContain('style=');
      expect(authored).not.toContain('tabindex');
    });

    it('keeps KaTeX (inline math included) and card structure from a marked fragment', () => {
      const html = render([para(txt('see '), generatedHtml(KATEX), txt(' and')), generatedHtml(CARD)]);
      expect(html).toContain('class="katex"');
      expect(html).toContain('<math>');
      expect(html).toContain('class="crowi-link-card"');
      expect(html).toContain('target="_blank"');
      expect(html.indexOf('see')).toBeLessThan(html.indexOf('katex'));
      expect(html.indexOf('and')).toBeGreaterThan(html.indexOf('katex-html'));
    });

    it('keeps every internal reference of a marked PlantUML-style svg even when author ids collide', () => {
      const svg =
        '<svg><defs><marker id="arrowhead" markerWidth="2"><path d="M0 0"/></marker><linearGradient id="gradient"><stop offset="0"/></linearGradient><path id="shape" d="M1 1" name="shape-name"/></defs>' +
        '<line marker-end="url(#arrowhead)" stroke="black"/><rect fill="url(#gradient)"/><use href="#shape"/></svg>';
      const html = render([authorHtml('<span id="arrowhead">a</span><span id="shape">s</span>'), generatedHtml(svg)]);
      expect(html).toContain('<span>a</span><span>s</span>');
      expect(html).toContain('id="arrowhead"');
      expect(html).toContain('id="gradient"');
      expect(html).toContain('id="shape"');
      expect(html).toContain('marker-end="url(#arrowhead)"');
      expect(html).toContain('fill="url(#gradient)"');
      expect(html).toContain('href="#shape"');
      expect((html.match(/id="arrowhead"/g) ?? []).length).toBe(1);
    });

    it('renders a typed link-card preview node as fixed spans with the url and message as text', () => {
      const html = render([{ type: 'crowiLinkCardPreview', url: 'https://example.test/<b>x</b>', message: '<i>pending</i>', sourceLine: 4 }]);
      expect(html).toContain('class="crowi-link-card"');
      expect(html).toContain('data-source-line="4"');
      expect(html).toContain('class="crowi-link-card-title">https://example.test/&lt;b&gt;x&lt;/b&gt;</span>');
      expect(html).toContain('class="crowi-link-card-preview-message">&lt;i&gt;pending&lt;/i&gt;</span>');
      expect(html).not.toContain('<b>');
    });
  });

  describe('unknown-placeholder-literal', () => {
    it('keeps `ssh <user>@<host>` and `No <thing> yet` as literal text', () => {
      const html = render([para(txt('ssh '), authorHtml('<user>'), txt('@'), authorHtml('<host>')), para(txt('No '), authorHtml('<thing>'), txt(' yet'))]);
      expect(html).toContain('ssh &lt;user&gt;@&lt;host&gt;');
      expect(html).toContain('No &lt;thing&gt; yet');
    });

    it.each(['math', 'applet', 'plaintext'])('shows a leading <%s> chunk as inert text, closed or not', (tag) => {
      const closed = render([authorHtml(`<${tag}><b>x</b></${tag}>`)]);
      expect(closed).toContain(`&lt;${tag}&gt;`);
      expect(closed).not.toContain('<b>');
      const open = render([authorHtml(`<${tag}>`), heading(2, 'after', 'After'), para(txt('tail'))]);
      expect(open).toContain(`&lt;${tag}&gt;`);
      expect(open).toContain('<h2 id="after">After</h2>');
      expect(open).toContain('<p>tail</p>');
    });

    it('unwraps an unknown tag nested inside a known raw block', () => {
      expect(render([authorHtml('<div><o:p>x</o:p></div>')])).toBe('<div>x</div>');
    });
  });

  describe('author attributes and dangerous markup', () => {
    it('removes event handlers, style, class, srcdoc and embedded content', () => {
      const html = render([
        authorHtml(
          '<div class="a" style="position:fixed" onclick="x()" srcdoc="s" data-x="1">t</div><iframe src="//e/"></iframe><script>alert(1)</script><object data="x"><p>kept</p></object>',
        ),
      ]);
      expect(html).toBe('<div>t</div><p>kept</p>');
    });

    it('does not let an author span or section claim owner-only structure', () => {
      const html = render([
        authorHtml(
          '<span role="img" aria-label="x">e</span><section data-section-id="a"><h2 id="a">h</h2></section><ul class="contains-task-list"><li class="task-list-item">i</li></ul>',
        ),
      ]);
      expect(html).toBe('<span>e</span><section><h2 id="a">h</h2></section><ul><li>i</li></ul>');
    });

    it('applies README-style align as an attribute, with no style', () => {
      expect(render([authorHtml('<p align="center">x</p>')])).toBe('<p style="text-align:center">x</p>'.replace('style="text-align:center"', 'align="center"'));
    });
  });

  describe('URL handling for Markdown and HTML alike', () => {
    const link = (url: string) => para({ type: 'link', url, title: null, children: [txt('l')] });
    it('keeps tel/file/slack hrefs and drops javascript/vbscript/data hrefs, in Markdown and HTML', () => {
      for (const url of ['tel:+81312345678', 'file:///etc/hosts', 'slack://open']) {
        expect(render([link(url)])).toContain(`href="${url}"`);
        expect(render([authorHtml(`<a href="${url}">l</a>`)])).toContain(`href="${url}"`);
      }
      for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:x', 'data:text/html,x']) {
        expect(render([link(url)])).not.toContain('href=');
        expect(render([authorHtml(`<a href="${url}">l</a>`)])).not.toContain('href=');
      }
      for (const encoded of ['&#106;avascript:alert(1)', ' java&#10;script:x', '&#x6A;AVASCRIPT:x', 'java&Tab;script:x']) {
        expect(render([authorHtml(`<a href="${encoded}">l</a>`)])).not.toContain('href=');
      }
    });

    it('keeps raw-space page and file paths (Markdown URLs arrive percent-encoded from toHast)', () => {
      expect(render([authorHtml('<a href="/Team/My Page">l</a>')])).toContain('href="/Team/My Page"');
      expect(render([authorHtml('<img src="/files/my shot.png" alt="a">')])).toContain('src="/files/my shot.png"');
      expect(render([link('/Team/My Page')])).toContain('href="/Team/My%20Page"');
      expect(render([para({ type: 'image', url: '/files/my shot.png', alt: 'a' })])).toContain('src="/files/my%20shot.png"');
    });

    it('shows alt text for an image whose src is not allowed, in Markdown and HTML', () => {
      expect(render([para({ type: 'image', url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', alt: 'svg alt' })])).toBe('<p>svg alt</p>');
      expect(render([authorHtml('<img src="javascript:x" alt="js alt">')])).toBe('js alt');
      expect(render([para({ type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', alt: 'png' })])).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    });
  });

  describe('image-structure', () => {
    it('keeps a Markdown standalone figure and strips transport values from the DOM props sent to components', () => {
      const html = render([
        {
          type: 'crowiFigure',
          data: { hName: 'figure', hProperties: { className: 'crowi-figure', 'data-crowi-image-float': 'right' } },
          children: [{ type: 'image', url: '/a.png', alt: 'a', data: { hProperties: { 'data-crowi-image-width': '40%' } } }],
        },
      ]);
      expect(html).toContain('<figure class="crowi-figure" data-crowi-image-float="right">');
      expect(html).toContain('data-crowi-image-width="40%"');
    });

    it('turns a raw standalone aligned image into a figure, keeps inline images inline, and drops invalid values', () => {
      const standalone = render([authorHtml('<img src="/a.png" alt="a" data-crowi-image-align="center" data-crowi-image-width="50%">')]);
      expect(standalone).toContain('<figure class="crowi-figure" data-crowi-image-align="center">');
      const inline = render([para(txt('x '), authorHtml('<img src="/a.png" alt="a" data-crowi-image-align="center">'), txt(' y'))]);
      expect(inline).not.toContain('figure');
      expect(inline).not.toContain('data-crowi-image-align');
      const invalid = render([authorHtml('<img src="/a.png" alt="a" data-crowi-image-width="9999px" data-crowi-image-align="middle">')]);
      expect(invalid).not.toContain('data-crowi-image');
    });
  });

  describe('source-line-owned', () => {
    it('keeps data-source-line as the number or numeric string the pipeline gave, and drops an author one', () => {
      const html = render([
        {
          type: 'crowiAlert',
          variant: 'note',
          data: { hProperties: { 'data-source-line': '5' } },
          children: [para(txt('[!NOTE]'), { type: 'break' }, txt('body'))],
        },
        { type: 'paragraph', data: { hProperties: { 'data-source-line': 9 } }, children: [txt('p')] },
        authorHtml('<p data-source-line="77">forged</p>'),
      ]);
      expect(html).toContain('data-source-line="5"');
      expect(html).toContain('<p data-source-line="9">p</p>');
      expect(html).not.toContain('77');
      expect(html).toContain('<p>forged</p>');
    });
  });

  describe('author-anchor-filter', () => {
    it('keeps valid author ids and drops those that collide with headings, footnotes and each other', () => {
      const html = render([
        authorHtml('<span id="intro">author</span><span id="free">f</span><span id="free">dup</span><span id="location">l</span><a name="cookie">c</a>'),
        heading(2, 'intro', 'Intro'),
        { type: 'footnoteDefinition', identifier: '1', children: [para(txt('note'))] },
        para({ type: 'footnoteReference', identifier: '1', label: '1' }),
      ]);
      expect(html).toContain('<span>author</span>');
      expect(html).toContain('<span id="free">f</span><span>dup</span>');
      expect(html).toContain('<span>l</span>');
      expect(html).toContain('<a>c</a>');
      expect(html).toContain('id="intro"');
      expect(html).toContain('id="footnote-label"');
      expect(html).toContain('id="user-content-fn-1"');
    });

    it('applies the 256-byte and emptiness bounds', () => {
      const html = render([authorHtml(`<span id="${'a'.repeat(256)}">ok</span><span id="${'a'.repeat(257)}">long</span><span id="">e</span>`)]);
      expect(html).toContain(`id="${'a'.repeat(256)}"`);
      expect(html).toContain('<span>long</span><span>e</span>');
    });

    it('lets a footnote label heading coexist with the generated footnote section', () => {
      const html = render([
        heading(2, 'footnote-label', 'footnote label'),
        para(txt('x'), { type: 'footnoteReference', identifier: '1', label: '1' }),
        { type: 'footnoteDefinition', identifier: '1', children: [para(txt('n'))] },
      ]);
      expect(html).toContain('aria-describedby="footnote-label"');
      expect(html).toContain('href="#user-content-fnref-1"');
      expect(html.match(/id="footnote-label"/g)?.length).toBe(2);
    });

    it('does not turn an author heading into a section, and keeps sections for Markdown headings after an unclosed wrapper', () => {
      const node = renderMdastToReactNode(
        { type: 'root', children: [authorHtml('<h2 id="raw-h">raw</h2>'), authorHtml('<div>'), heading(2, 'md-h', 'md'), para(txt('after'))] },
        { sectionWrap: true, components: {} },
      );
      const html = renderToStaticMarkup(node);
      expect(html).toContain('<h2 id="raw-h">raw</h2>');
      expect(html).not.toContain('data-section-id="raw-h"');
      expect(html).toContain('<section data-section-id="md-h"><h2 id="md-h">md</h2>');
    });
  });

  describe('clobbering-stable-rerender', () => {
    it('keeps a harmless author id whether or not an earlier render of it is still in the document', () => {
      const ast = { type: 'root', children: [authorHtml('<span id="faq">answer</span>')] };
      const first = document.createElement('div');
      document.body.appendChild(first);
      first.innerHTML = renderToStaticMarkup(renderMdastToReactNode(ast, { sectionWrap: false, components: {} }));
      expect(document.getElementById('faq')).not.toBeNull();
      const second = renderToStaticMarkup(renderMdastToReactNode({ ...ast }, { sectionWrap: false, components: {} }));
      expect(second).toBe('<span id="faq">answer</span>');
      first.remove();
      // jsdom exposes named elements as window properties; the decision must not depend on it.
      (window as unknown as Record<string, unknown>).someGlobal = 1;
      expect(
        renderToStaticMarkup(
          renderMdastToReactNode({ type: 'root', children: [authorHtml('<span id="someGlobal">x</span>')] }, { sectionWrap: false, components: {} }),
        ),
      ).toBe('<span id="someGlobal">x</span>');
      delete (window as unknown as Record<string, unknown>).someGlobal;
    });
  });

  describe('stale-ast-strict', () => {
    it('does not rescue an old unmarked Shiki block, while a current marked one keeps its colors with no sidecar', () => {
      const old = '<pre class="shiki" style="--shiki-light:#fff"><code>old code</code></pre>';
      expect(render([authorHtml(old)])).toBe('<pre><code>old code</code></pre>');
      expect(render([{ type: 'html', value: old, data: { g: 1 } }])).toContain('style="--shiki-light:#fff"');
    });
  });

  describe('generated marks come only from html nodes', () => {
    it('ignores a mark on a raw node smuggled through data.hChildren', () => {
      const html = render([
        { type: 'paragraph', data: { hChildren: [{ type: 'raw', value: '<pre style="x:y" onclick="a()">G</pre>', data: { g: 1 } }] }, children: [txt('t')] },
      ]);
      expect(html).toContain('<pre>G</pre>');
      expect(html).not.toContain('style=');
      expect(html).not.toContain('onclick');
    });
  });

  describe('fail-closed-dom', () => {
    it('returns a failed result (never the raw tree) for an invalid AST', () => {
      const cyclic: { type: string; children: unknown[] } = { type: 'root', children: [] };
      cyclic.children.push(cyclic);
      expect(renderMdastToReactResult(cyclic, { sectionWrap: false, components: {} })).toEqual({ status: 'failed', reason: 'invalid-input' });
      expect(renderMdastToReactNode(cyclic, { sectionWrap: false, components: {} })).toBeNull();
    });

    it('reports a missing AST as missing and an empty root as ok', () => {
      expect(renderMdastToReactResult(null, { sectionWrap: false, components: {} })).toEqual({ status: 'missing' });
      expect(renderMdastToReactResult({ type: 'root', children: [] }, { sectionWrap: false, components: {} }).status).toBe('ok');
    });

    it('fails with invalid-input when Web Crypto is unavailable', () => {
      vi.stubGlobal('crypto', undefined);
      expect(renderMdastToReactResult({ type: 'root', children: [para(txt('x'))] }, { sectionWrap: false, components: {} })).toEqual({
        status: 'failed',
        reason: 'invalid-input',
      });
    });

    it('never puts carrier attributes, the nonce, or positions in the DOM, and uses a fresh nonce per call', () => {
      const nonces: string[] = [];
      const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
        array.fill(nonces.length + 1);
        nonces.push(Array.from(array, (b) => b.toString(16).padStart(2, '0')).join(''));
        return array;
      }) as never);
      const ast = { type: 'root', children: [generatedHtml('<pre>CODE</pre>'), authorHtml('<p>after</p>')] };
      const a = render(ast.children);
      const b = render(ast.children);
      expect(a).toBe(b);
      expect(nonces).toHaveLength(2);
      expect(nonces[0]).not.toBe(nonces[1]);
      for (const needle of [nonces[0] as string, 'crowi-generated-slot', 'data-g', 'position']) expect(a).not.toContain(needle);
      spy.mockRestore();
    });

    it('renders a heavy but legitimate Shiki-sized fragment and deep legacy inline nesting', () => {
      const lines = Array.from({ length: 4000 }, (_, i) => `<span class="line"><span style="--shiki-light:#24292e">line ${i}</span></span>`).join('\n');
      const html = render([generatedHtml(`<pre class="shiki"><code>${lines}</code></pre>`)]);
      expect(html).toContain('line 3999');
      const nested = '<em>'.repeat(300) + 'deep' + '</em>'.repeat(300);
      expect(render([authorHtml(nested)])).toContain('deep');
    });
  });

  describe('realistic pipeline output', () => {
    it('renders headings, tasks, footnotes, mentions, emoji, figures and raw HTML from a real stored AST shape', () => {
      const ast = {
        type: 'root',
        children: [
          { type: 'crowiFrontmatter', entries: [{ key: 'id', value: 'foo' }] },
          { type: 'heading', depth: 1, children: [txt('Title')], data: { hProperties: { id: 'title' } } },
          para(
            txt('Para'),
            { type: 'footnoteReference', identifier: '1', label: '1' },
            { type: 'link', url: '/user/sotarok', title: null, children: [txt('@sotarok')], data: { hProperties: { className: 'mention' } } },
            { type: 'link', url: '#', title: null, children: [txt('wiki')], data: { hProperties: { className: 'wikilink-broken' } } },
            { type: 'text', value: '😄', data: { hName: 'span', hProperties: { role: 'img', ariaLabel: 'smile emoji' }, hChildren: [txt('😄')] } },
          ),
          { type: 'list', ordered: false, spread: false, children: [{ type: 'listItem', spread: false, checked: true, children: [para(txt('done'))] }] },
          { type: 'footnoteDefinition', identifier: '1', children: [para(txt('The note.'))] },
          authorHtml('<div class="x" onclick="a()">raw <b>bold</b></div>'),
        ],
      };
      const html = renderToStaticMarkup(renderMdastToReactNode(ast, { sectionWrap: true, components: {} })).replace(/>\s+</g, '><');
      expect(html).toContain('<dl class="crowi-frontmatter">');
      expect(html).toContain('<section data-section-id="title"><h1 id="title">Title</h1>');
      expect(html).toContain('class="mention"');
      expect(html).toContain('class="wikilink-broken"');
      expect(html).toContain('<span role="img" aria-label="smile emoji">');
      expect(html).toContain('<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled="" checked=""/>');
      expect(html).toContain('data-footnote-ref=""');
      expect(html).toContain('class="data-footnote-backref"');
      expect(html).toContain('<div>raw <b>bold</b></div>');
      expect(html).not.toContain('onclick');
    });
  });
});
