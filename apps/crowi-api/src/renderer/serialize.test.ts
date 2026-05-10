import type { Root } from 'mdast';
import { serializeMdast } from './serialize';

describe('serializeMdast', () => {
  it('returns a plain JSON-serialisable object', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'hello' }],
        },
      ],
    };
    const out = serializeMdast(tree);
    expect(JSON.parse(JSON.stringify(out))).toEqual({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'hello' }],
        },
      ],
    });
  });

  it('strips `position` from every node, including nested ones', () => {
    const tree = {
      type: 'root',
      position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 5, offset: 4 } },
      children: [
        {
          type: 'heading',
          depth: 1,
          position: { start: {}, end: {} },
          children: [
            {
              type: 'text',
              value: 'hi',
              position: { start: {}, end: {} },
            },
          ],
        },
      ],
    } as unknown as Root;
    const out = serializeMdast(tree) as Record<string, unknown>;
    expect('position' in out).toBe(false);
    const child = (out.children as Array<Record<string, unknown>>)[0];
    expect('position' in child).toBe(false);
    const grand = (child.children as Array<Record<string, unknown>>)[0];
    expect('position' in grand).toBe(false);
  });

  it('preserves data.hProperties (anchor ids, wikilink-broken, mention)', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'heading',
          depth: 2,
          data: { hProperties: { id: 'section-a' } },
          children: [{ type: 'text', value: 'Section A' }],
        },
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: '#',
              data: { hProperties: { className: 'wikilink-broken' } },
              children: [{ type: 'text', value: 'Bare' }],
            },
            {
              type: 'link',
              url: '/user/alice',
              data: { hProperties: { className: 'mention' } },
              children: [{ type: 'text', value: '@alice' }],
            },
          ],
        },
      ],
    } as unknown as Root;
    const out = serializeMdast(tree) as { children: Array<Record<string, unknown>> };
    expect(out.children[0].data).toEqual({ hProperties: { id: 'section-a' } });
    const para = out.children[1] as { children: Array<{ data: unknown }> };
    expect(para.children[0].data).toEqual({ hProperties: { className: 'wikilink-broken' } });
    expect(para.children[1].data).toEqual({ hProperties: { className: 'mention' } });
  });

  it('preserves html nodes (shiki output) verbatim', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'html', value: '<pre class="shiki"><code>x</code></pre>' }],
    } as unknown as Root;
    const out = serializeMdast(tree) as { children: Array<{ type: string; value: string }> };
    expect(out.children[0].type).toBe('html');
    expect(out.children[0].value).toBe('<pre class="shiki"><code>x</code></pre>');
  });

  it('does not mutate the input tree', () => {
    const tree = {
      type: 'root',
      position: { start: {}, end: {} },
      children: [{ type: 'text', value: 'x', position: { start: {}, end: {} } }],
    } as unknown as Root;
    serializeMdast(tree);
    expect((tree as unknown as { position?: unknown }).position).toBeDefined();
    expect((tree.children[0] as unknown as { position?: unknown }).position).toBeDefined();
  });
});
