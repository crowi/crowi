import type { Heading, Paragraph, Root } from 'mdast';
import type { PluginLogger, RendererRegistry, RenderPhase } from '@crowi/plugin-api';
import crowiLegacyPlugin, { remarkFixV1Headings } from './index';

/**
 * Minimal RendererRegistry capture stub. The real implementation lives
 * in `packages/api/src/renderer/registry.ts`; mirroring its shape here
 * lets us assert that `registerRenderer` queues the v1-heading-fix
 * transform on the transform phase without coupling the plugin
 * unit-test to the api package's TypeScript graph.
 */
interface CapturedRegistration {
  plugin: unknown;
  phase: RenderPhase;
}

function makeRegistry(): { scope: RendererRegistry; captured: CapturedRegistration[] } {
  const captured: CapturedRegistration[] = [];
  const scope: RendererRegistry = {
    addUnifiedPlugin: (plugin, options) => {
      captured.push({ plugin, phase: options?.phase ?? 'transform' });
    },
    addNodeRenderer: () => undefined,
    addCodeBlockRenderer: () => undefined,
    addEmbedTag: () => undefined,
    addUrlInlineExpander: () => undefined,
    addStylesheet: () => undefined,
  };
  return { scope, captured };
}

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('@crowi/plugin-renderer-crowi-legacy', () => {
  it('exports a CrowiPlugin with the expected name + version', () => {
    expect(crowiLegacyPlugin.name).toBe('@crowi/plugin-renderer-crowi-legacy');
    expect(crowiLegacyPlugin.version).toBe('0.1.0-dev');
    expect(typeof crowiLegacyPlugin.registerRenderer).toBe('function');
  });

  it('registers exactly one transform-phase unified plugin', () => {
    const { scope, captured } = makeRegistry();
    crowiLegacyPlugin.registerRenderer?.(scope, {
      log: silentLogger,
      // The other PluginContext fields aren't read by registerRenderer.
    } as never);

    expect(captured).toHaveLength(1);
    expect(captured[0].phase).toBe('transform');
    expect(captured[0].plugin).toBe(remarkFixV1Headings);
  });

  describe('remarkFixV1Headings (pure mdast transform — no ESM deps needed)', () => {
    const run = (tree: Root): Root => {
      remarkFixV1Headings()(tree);
      return tree;
    };

    it('converts `##hoge` paragraph → heading depth 2', () => {
      const tree: Root = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '##hoge' }] }],
      };
      const out = run(tree);
      expect(out.children).toHaveLength(1);
      const heading = out.children[0] as Heading;
      expect(heading.type).toBe('heading');
      expect(heading.depth).toBe(2);
      expect(heading.children[0]).toEqual({ type: 'text', value: 'hoge' });
    });

    it('respects depth 1–6: `######quux` → depth 6', () => {
      const tree: Root = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '######quux' }] }],
      };
      const out = run(tree);
      expect((out.children[0] as Heading).depth).toBe(6);
    });

    it('refuses 7+ hashes: `#######no` stays a paragraph', () => {
      const tree: Root = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '#######no' }] }],
      };
      const out = run(tree);
      expect(out.children[0].type).toBe('paragraph');
    });

    it('does NOT rewrite `## hoge` (already a proper heading source)', () => {
      // mdast wouldn't actually give us a paragraph for `## hoge` after
      // remark-parse — it parses as a real heading. We test the regex
      // guard directly: even if the registry got a paragraph that looks
      // like a proper heading source, we must not double-convert it.
      const tree: Root = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '## hoge' }] }],
      };
      const out = run(tree);
      expect(out.children[0].type).toBe('paragraph');
    });

    it('splits `##hoge\\nbar` into heading + paragraph', () => {
      const tree: Root = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '##hoge\nbar' }] }],
      };
      const out = run(tree);
      expect(out.children).toHaveLength(2);
      expect((out.children[0] as Heading).depth).toBe(2);
      expect((out.children[0] as Heading).children[0]).toEqual({ type: 'text', value: 'hoge' });
      expect((out.children[1] as Paragraph).type).toBe('paragraph');
      expect((out.children[1] as Paragraph).children[0]).toEqual({ type: 'text', value: 'bar' });
    });

    it('drops a leading `break` node from the leftover paragraph', () => {
      // Simulates the post-remark-breaks tree shape: the paragraph's
      // first text is `##hoge`, then a `break` node, then more text.
      const tree: Root = {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'text', value: '##hoge' }, { type: 'break' }, { type: 'text', value: 'bar' }],
          },
        ],
      };
      const out = run(tree);
      expect(out.children).toHaveLength(2);
      expect((out.children[0] as Heading).depth).toBe(2);
      const leftover = out.children[1] as Paragraph;
      expect(leftover.children[0]).toEqual({ type: 'text', value: 'bar' });
    });

    it('leaves non-paragraph nodes (code, list, etc.) untouched', () => {
      const tree: Root = {
        type: 'root',
        children: [
          { type: 'code', lang: 'ts', value: '##notAHeading' },
          { type: 'paragraph', children: [{ type: 'text', value: '##realFix' }] },
        ],
      };
      const out = run(tree);
      expect(out.children).toHaveLength(2);
      expect(out.children[0].type).toBe('code');
      expect(out.children[1].type).toBe('heading');
    });

    it('leaves a paragraph whose first child is NOT text alone (e.g. `**bold** lead`)', () => {
      const tree: Root = {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
              { type: 'text', value: ' lead' },
            ],
          },
        ],
      };
      const out = run(tree);
      expect(out.children[0].type).toBe('paragraph');
    });
  });
});
