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
