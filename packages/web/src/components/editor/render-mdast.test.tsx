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
