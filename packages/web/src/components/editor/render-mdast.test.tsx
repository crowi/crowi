import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { toHast } from 'mdast-util-to-hast';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderMdastToReactNode } from './render-mdast';

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
    const mdast = { type: 'root', children: [{ type: 'html', value: diagramImgHtml }] };

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
    const mdast = { type: 'root', children: [{ type: 'html', value: diagramImgHtml }] };

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

  it('forwards the editor preview scroll-sync anchor and nothing else from data', () => {
    const html = render([
      {
        type: 'crowiAlert',
        variant: 'note',
        data: { hName: 'blockquote', hProperties: { 'data-source-line': 1, className: ['evil'], onclick: 'steal()' } },
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '[!NOTE]' }, { type: 'break' }, { type: 'text', value: 'body' }] }],
      },
    ]);

    expect(html).toContain('data-source-line="1"');
    expect(html).toContain('class="crowi-alert crowi-alert-note"');
    expect(html).not.toContain('evil');
    expect(html).not.toContain('steal()');
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
 * in raw HTML. Those must come out the way they always have; the one
 * exception — an author who copies the variant attribute — gets the
 * callout chrome and nothing more, since that chrome is chosen from a
 * closed map rather than taken from the element.
 */
describe('an author-written <aside>', () => {
  it('passes a plain aside through untouched', () => {
    const html = render([{ type: 'html', value: '<aside class="sidebar" id="note-1">side note</aside>' }]);
    expect(html).toContain('side note');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('id="note-1"');
    expect(html).not.toContain('crowi-alert');
  });

  it('gives an aside claiming a known variant the fixed callout chrome and drops everything else it carried', () => {
    const html = render([{ type: 'html', value: '<aside data-crowi-alert-variant="note" id="x" title="t">claimed</aside>' }]);
    expect(html).toContain('class="crowi-alert crowi-alert-note"');
    expect(html).toContain('<span>Note</span>');
    expect(html).toContain('claimed');
    expect(html).not.toContain('id="x"');
    expect(html).not.toContain('title="t"');
  });

  it('leaves an aside claiming an unknown variant alone', () => {
    const html = render([{ type: 'html', value: '<aside data-crowi-alert-variant="bogus">claimed</aside>' }]);
    expect(html).toContain('claimed');
    expect(html).not.toContain('crowi-alert-title');
  });
});
