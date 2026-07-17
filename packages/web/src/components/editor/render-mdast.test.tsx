import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
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
