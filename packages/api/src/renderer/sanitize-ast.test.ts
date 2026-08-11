import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AST_OUTPUT_BUDGET_BYTES, CURRENT_AST_VERSION, RenderedAstEnvelopeSchema } from '@crowi/api-contract';
import type { Root } from 'mdast';
import { createPipelineEsmDepsLoader, runPipeline } from './pipeline';
import { RendererRegistryImpl } from './registry';
import { envelopeInvalidEnvelope, sanitizeAst } from './sanitize-ast';
import { serializeMdast } from './serialize';

/**
 * RFC-0023 / design doc §5-§8 — sanitising walker + v1 projection.
 * Projection inputs are synthetic sidecar-carrying `html` nodes (the
 * walker is a pure function; no handler integration here), plus one
 * real-parser round-trip fixture for the standard-node field
 * preservation AC.
 */

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();
const runCore = async (body: string) => {
  const reg = new RendererRegistryImpl();
  return runPipeline(body, reg, { mode: 'save', log: silentLogger, actor: { kind: 'system' } }, loadDeps);
};

type AnyNode = { type: string } & Record<string, unknown>;

const root = (...children: unknown[]): unknown => ({ type: 'root', children });
const para = (...children: unknown[]): unknown => ({ type: 'paragraph', children });
const text = (value: string): unknown => ({ type: 'text', value });

const rootChildren = (envelope: ReturnType<typeof sanitizeAst>): AnyNode[] => envelope.root.children as AnyNode[];

/** A tiny SVG that passes `@crowi/svg-sanitize` under `allowSafeHref: false`. */
const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10"></rect></svg>';
const SAFE_SVG_B64 = Buffer.from(SAFE_SVG, 'utf8').toString('base64');
/** Minimal valid PNG header bytes (signature + IHDR framing) — enough for the signature check. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.from([0, 0, 0, 20, 0, 0, 0, 10, 8, 6, 0, 0, 0]),
]);
const PNG_B64 = PNG_BYTES.toString('base64');

const diagramSidecar = (overrides: Record<string, unknown> = {}) => ({
  kind: 'mermaid',
  alt: 'Mermaid diagram',
  image: { mediaType: 'image/svg+xml', base64: SAFE_SVG_B64, width: 20, height: 10 },
  ...overrides,
});

const htmlWithSidecar = (key: string, payload: unknown, extraData: Record<string, unknown> = {}): unknown => ({
  type: 'html',
  value: '<div class="producer-html">x</div>',
  data: { [key]: payload, ...extraData },
});

const cardSidecar = (url = 'https://example.com/a') => ({ url, title: 'T', domain: 'example.com' });

describe('sanitizeAst — envelope basics + envelope-level failures (§5/§7)', () => {
  it('wraps a valid bare Root into an astVersion:1 envelope that passes the strict schema', () => {
    const envelope = sanitizeAst(root(para(text('hello'))));
    expect(envelope.astVersion).toBe(CURRENT_AST_VERSION);
    expect(rootChildren(envelope)).toEqual([{ type: 'paragraph', children: [{ type: 'text', value: 'hello' }] }]);
    expect(() => RenderedAstEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it.each([
    ['non-root object', { type: 'paragraph', children: [] }],
    ['unknown-typed object', { type: 'unknown' }],
    ['null', null],
    ['a string', 'not a tree'],
  ])('top-level guard: %s → envelope-invalid placeholder envelope (never absent, never a throw)', (_label, input) => {
    const envelope = sanitizeAst(input);
    const children = rootChildren(envelope);
    expect(children).toHaveLength(1);
    expect(children[0].type).toBe('crowiPlaceholder');
    expect(children[0].kind).toBe('envelope-invalid');
    expect(() => RenderedAstEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('a cyclic "tree" (JSON.stringify throws) collapses to envelope-invalid instead of hanging or throwing', () => {
    const cyclic: { type: string; children: unknown[] } = { type: 'root', children: [] };
    cyclic.children.push(cyclic);
    const envelope = sanitizeAst(cyclic);
    expect(rootChildren(envelope)[0].kind).toBe('envelope-invalid');
  });

  it('tree depth beyond 64 fails at the iterative pre-pass → envelope-invalid', () => {
    let node: unknown = para(text('deep'));
    for (let i = 0; i < 70; i++) node = { type: 'blockquote', children: [node] };
    const envelope = sanitizeAst(root(node));
    expect(rootChildren(envelope)[0].kind).toBe('envelope-invalid');
  });

  it('input beyond 8MB fails the coarse input gate → envelope-invalid', () => {
    const envelope = sanitizeAst(root(para(text('x'.repeat(9 * 1024 * 1024)))));
    expect(rootChildren(envelope)[0].kind).toBe('envelope-invalid');
  });

  it('envelopeInvalidEnvelope returns fresh (non-shared) objects', () => {
    const a = envelopeInvalidEnvelope();
    const b = envelopeInvalidEnvelope();
    expect(a).not.toBe(b);
    expect(a.root).not.toBe(b.root);
  });
});

describe('sanitizeAst — crowiOpaque catch-all (§5)', () => {
  it('unknown-type: a third-party node is opaque-ised (children discarded) and the rest of the page survives', () => {
    const envelope = sanitizeAst(root({ type: 'x-some-plugin-callout', children: [para(text('inner'))] }, para(text('after'))));
    const children = rootChildren(envelope);
    expect(children[0]).toEqual({ type: 'crowiOpaque', reason: 'unknown-type', originalType: 'x-some-plugin-callout' });
    expect(children[0].children).toBeUndefined();
    expect(children[1].type).toBe('paragraph');
  });

  it('unknown-type with a >64-char type string truncates originalType and the whole envelope still parses', () => {
    const longType = 'x'.repeat(100);
    const envelope = sanitizeAst(root({ type: longType }));
    const opaque = rootChildren(envelope)[0];
    expect(opaque.reason).toBe('unknown-type');
    expect((opaque.originalType as string).length).toBe(64);
    expect(() => RenderedAstEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('invalid-shape: a known type failing its shallow field check is opaque-ised', () => {
    const envelope = sanitizeAst(root({ type: 'heading', children: [text('no depth')] }));
    expect(rootChildren(envelope)[0]).toEqual({ type: 'crowiOpaque', reason: 'invalid-shape', originalType: 'heading' });
  });

  it('invalid-position: a shape-valid block node inside paragraph.children is opaque-ised (not passed through)', () => {
    const envelope = sanitizeAst(root(para(text('a'), { type: 'blockquote', children: [para(text('b'))] })));
    const paragraph = rootChildren(envelope)[0];
    const inner = (paragraph.children as AnyNode[])[1];
    expect(inner).toEqual({ type: 'crowiOpaque', reason: 'invalid-position', originalType: 'blockquote' });
  });

  it('a reserved Crowi type with a non-conforming shape degrades via the same invalid-shape path (collision handling = shape validation)', () => {
    const envelope = sanitizeAst(root({ type: 'crowiDiagram', bogus: true }));
    expect(rootChildren(envelope)[0]).toEqual({ type: 'crowiOpaque', reason: 'invalid-shape', originalType: 'crowiDiagram' });
  });
});

// feature-renderer-frontmatter AC-8 — `crowiFrontmatter` is registered
// in `RENDERED_AST_NODE_DEFS` (childModel: 'none', flow placement) with
// no bespoke walker branch needed (unlike `crowiFigure`'s structural
// `hName`/`hProperties` requirement): the generic def-driven
// `fields.safeParse` path already projects/opaque-ises it like every
// other typed node.
describe('sanitizeAst — crowiFrontmatter envelope projection (§3, feature-renderer-frontmatter AC-8)', () => {
  it('a well-formed crowiFrontmatter passes through the envelope with its entries intact', () => {
    const node = {
      type: 'crowiFrontmatter',
      entries: [
        { key: 'id', value: 'feature-foo' },
        { key: 'status', value: 'approved' },
      ],
    };
    const envelope = sanitizeAst(root(node, para(text('body'))));
    const children = rootChildren(envelope);
    expect(children[0]).toEqual(node);
    expect(children[1].type).toBe('paragraph');
    expect(() => RenderedAstEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('drops an entry array beyond the max-50 cap: invalid-shape → crowiOpaque (schema violation)', () => {
    const entries = Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
    const envelope = sanitizeAst(root({ type: 'crowiFrontmatter', entries }));
    expect(rootChildren(envelope)[0]).toEqual({ type: 'crowiOpaque', reason: 'invalid-shape', originalType: 'crowiFrontmatter' });
  });

  it('an entry with a key over 100 chars fails the schema: invalid-shape → crowiOpaque', () => {
    const envelope = sanitizeAst(root({ type: 'crowiFrontmatter', entries: [{ key: 'k'.repeat(101), value: 'v' }] }));
    expect(rootChildren(envelope)[0]).toEqual({ type: 'crowiOpaque', reason: 'invalid-shape', originalType: 'crowiFrontmatter' });
  });

  it('an entry with a value over 300 chars fails the schema: invalid-shape → crowiOpaque', () => {
    const envelope = sanitizeAst(root({ type: 'crowiFrontmatter', entries: [{ key: 'k', value: 'v'.repeat(301) }] }));
    expect(rootChildren(envelope)[0]).toEqual({ type: 'crowiOpaque', reason: 'invalid-shape', originalType: 'crowiFrontmatter' });
  });

  it('a missing entries field fails the schema: invalid-shape → crowiOpaque', () => {
    const envelope = sanitizeAst(root({ type: 'crowiFrontmatter' }));
    expect(rootChildren(envelope)[0]).toEqual({ type: 'crowiOpaque', reason: 'invalid-shape', originalType: 'crowiFrontmatter' });
  });

  it('rejects crowiFrontmatter at a non-flow position (invalid-position → crowiOpaque), matching the flow-only registry entry', () => {
    const envelope = sanitizeAst(root(para(text('a'), { type: 'crowiFrontmatter', entries: [{ key: 'k', value: 'v' }] })));
    const paragraph = rootChildren(envelope)[0];
    const inner = (paragraph.children as AnyNode[])[1];
    expect(inner).toEqual({ type: 'crowiOpaque', reason: 'invalid-position', originalType: 'crowiFrontmatter' });
  });
});

// `crowiAlert` is the one Crowi type that is deliberately kept OUT of
// `RENDERED_AST_NODE_DEFS`: v1 is a closed union with shipped native
// decoders, so the walker narrows a well-formed alert to the ordinary
// `blockquote` it already advertises via `data.hName`, children
// untouched (literal marker included).
describe('sanitizeAst — crowiAlert v1 blockquote projection', () => {
  const alert = (overrides: Record<string, unknown> = {}): AnyNode =>
    ({
      type: 'crowiAlert',
      variant: 'note',
      data: { hName: 'blockquote' },
      children: [para(text('[!NOTE]'), { type: 'break' }, text('body'))],
      ...overrides,
    }) as AnyNode;

  it('projects a marker-bearing alert to a blockquote whose children are passed through verbatim', () => {
    const envelope = sanitizeAst(root(alert()));
    expect(rootChildren(envelope)[0]).toEqual({
      type: 'blockquote',
      data: { hName: 'blockquote' },
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: '[!NOTE]' }, { type: 'break' }, { type: 'text', value: 'body' }],
        },
      ],
    });
    expect(() => RenderedAstEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it.each([
    ['a list-first body', [para(text('[!TIP]')), { type: 'list', ordered: false, children: [{ type: 'listItem', children: [para(text('a'))] }] }]],
    ['a code-first body', [para(text('[!TIP]')), { type: 'code', value: 'x' }]],
    ['a nested ordinary blockquote', [para(text('[!TIP]')), { type: 'blockquote', children: [para(text('q'))] }]],
  ])('keeps %s in place, with no marker text / break / paragraph synthesized', (_label, children) => {
    const envelope = sanitizeAst(root(alert({ variant: 'tip', children })));
    const projected = rootChildren(envelope)[0];
    expect(projected.type).toBe('blockquote');
    expect((projected.children as AnyNode[]).map((c) => c.type)).toEqual(children.map((c) => (c as AnyNode).type));
    expect(JSON.stringify(projected)).toContain('[!TIP]');
  });

  it('keeps the preview scroll-sync anchor on the projected blockquote', () => {
    const envelope = sanitizeAst(root(alert({ data: { hName: 'blockquote', hProperties: { 'data-source-line': 1 } } })));
    expect(rootChildren(envelope)[0].data).toEqual({ hName: 'blockquote', hProperties: { 'data-source-line': 1 } });
  });

  it('drops unsafe extras from `data` the same way every other node does', () => {
    const envelope = sanitizeAst(root(alert({ data: { hName: 'blockquote', onclick: 'steal()', crowiCode: { value: 'x' } } })));
    expect(rootChildren(envelope)[0].data).toEqual({ hName: 'blockquote' });
  });

  it.each([['bogus'], [''], ['NOTE'], [42], [undefined]])('degrades an alert with variant %p to invalid-shape → crowiOpaque', (variant) => {
    const envelope = sanitizeAst(root(alert({ variant })));
    expect(rootChildren(envelope)[0]).toEqual({ type: 'crowiOpaque', reason: 'invalid-shape', originalType: 'crowiAlert' });
  });

  it('degrades an alert with a non-array children field to invalid-shape → crowiOpaque', () => {
    const envelope = sanitizeAst(root(alert({ children: 'body' })));
    expect(rootChildren(envelope)[0]).toEqual({ type: 'crowiOpaque', reason: 'invalid-shape', originalType: 'crowiAlert' });
  });

  it('rejects an alert at a non-flow position (invalid-position → crowiOpaque)', () => {
    const envelope = sanitizeAst(root(para(text('a'), alert())));
    const inner = (rootChildren(envelope)[0].children as AnyNode[])[1];
    expect(inner).toEqual({ type: 'crowiOpaque', reason: 'invalid-position', originalType: 'crowiAlert' });
  });

  it('degrades an invalid CHILD only, leaving the surrounding projection intact', () => {
    const envelope = sanitizeAst(root(alert({ children: [para(text('[!NOTE]')), { type: 'x-plugin-thing' }] })));
    const projected = rootChildren(envelope)[0];
    expect(projected.type).toBe('blockquote');
    expect((projected.children as AnyNode[])[1]).toEqual({ type: 'crowiOpaque', reason: 'unknown-type', originalType: 'x-plugin-thing' });
  });
});

describe('sanitizeAst — hast hint data preservation (§4)', () => {
  it('preserves emoji a11y data (hName/hProperties/hChildren), heading anchors, link className, image display attrs and preview data-source-line', () => {
    const envelope = sanitizeAst(
      root(
        {
          type: 'heading',
          depth: 2,
          data: { hProperties: { id: 'anchor-id' } },
          children: [text('Heading')],
        },
        {
          type: 'paragraph',
          data: { hProperties: { 'data-source-line': 12 } },
          children: [
            {
              type: 'text',
              value: '😄',
              data: { hName: 'span', hProperties: { role: 'img', ariaLabel: 'smile emoji' }, hChildren: [{ type: 'text', value: '😄' }] },
            },
            { type: 'link', url: '/wiki/page', data: { hProperties: { className: ['wikilink'] } }, children: [text('go')] },
            { type: 'image', url: 'https://example.com/i.png', alt: 'alt', data: { hProperties: { 'data-crowi-image-width': '60%' } } },
          ],
        },
      ),
    );
    const [heading, paragraph] = rootChildren(envelope);
    expect((heading.data as AnyNode).hProperties).toEqual({ id: 'anchor-id' });
    expect((paragraph.data as AnyNode).hProperties).toEqual({ 'data-source-line': 12 });
    const [emoji, link, image] = paragraph.children as AnyNode[];
    expect(emoji.data).toEqual({
      hName: 'span',
      hProperties: { role: 'img', ariaLabel: 'smile emoji' },
      hChildren: [{ type: 'text', value: '😄' }],
    });
    expect((link.data as AnyNode).hProperties).toEqual({ className: ['wikilink'] });
    expect((image.data as AnyNode).hProperties).toEqual({ 'data-crowi-image-width': '60%' });
  });

  it('drops unlisted data sub-keys (including sidecar keys on non-projected nodes) without opaque-ising the node', () => {
    const envelope = sanitizeAst(root(para({ type: 'text', value: 'x', data: { hName: 'span', someThirdPartyKey: { deep: true } } })));
    const t = (rootChildren(envelope)[0].children as AnyNode[])[0];
    expect(t.data).toEqual({ hName: 'span' });
  });
});

describe('sanitizeAst — URL allow-list (§8)', () => {
  it('link.url: javascript:/data:/protocol-relative degrade to "#" (node kept); http(s)/mailto/relative/fragment pass', () => {
    const mk = (url: string) => ({ type: 'link', url, children: [text('x')] });
    const envelope = sanitizeAst(
      root(para(mk('javascript:alert(1)'), mk('//evil.example/x'), mk('https://ok.example'), mk('mailto:a@b.c'), mk('/relative/path'), mk('#frag'))),
    );
    const urls = (rootChildren(envelope)[0].children as AnyNode[]).map((n) => n.url);
    expect(urls).toEqual(['#', '#', 'https://ok.example', 'mailto:a@b.c', '/relative/path', '#frag']);
  });

  it('definition.url degrades to "#" the same way', () => {
    const envelope = sanitizeAst(root({ type: 'definition', identifier: 'ref', url: 'vbscript:evil' }));
    expect(rootChildren(envelope)[0].url).toBe('#');
  });

  it('image.url violation replaces the node with a visible validation-failed placeholder', () => {
    const envelope = sanitizeAst(root(para({ type: 'image', url: 'javascript:alert(1)' })));
    const node = (rootChildren(envelope)[0].children as AnyNode[])[0];
    expect(node.type).toBe('crowiPlaceholder');
    expect(node.kind).toBe('validation-failed');
  });

  it('crowiLinkCard.url is http(s)-ONLY: mailto/relative/fragment are all rejected (visible placeholder), unlike link.url', () => {
    for (const url of ['mailto:a@b.c', '/relative', '#frag']) {
      const envelope = sanitizeAst(root(htmlWithSidecar('crowiLinkCard', cardSidecar(url))));
      const node = rootChildren(envelope)[0];
      expect(node.type).toBe('crowiPlaceholder');
      expect(node.kind).toBe('validation-failed');
    }
  });

  it('crowiLinkCard.image.url violation drops just the image field (image-less card)', () => {
    const envelope = sanitizeAst(root(htmlWithSidecar('crowiLinkCard', { ...cardSidecar(), image: { url: '/relative-not-http' } })));
    const node = rootChildren(envelope)[0];
    expect(node.type).toBe('crowiLinkCard');
    expect(node.image).toBeUndefined();
  });
});

describe('sanitizeAst — projection table (§5 step 1b / §10)', () => {
  it('crowiCode → code node with data.tokens; html value gone from the wire; hProperties carried', () => {
    const tokens = [[{ content: 'const', light: { color: '#111111' }, dark: { color: '#eeeeee' } }]];
    const envelope = sanitizeAst(root(htmlWithSidecar('crowiCode', { lang: 'ts', value: 'const a = 1;', tokens }, { hProperties: { 'data-source-line': 3 } })));
    const node = rootChildren(envelope)[0];
    expect(node.type).toBe('code');
    expect(node.lang).toBe('ts');
    expect(node.value).toBe('const a = 1;');
    expect((node.data as AnyNode).tokens).toEqual(tokens);
    expect((node.data as AnyNode).hProperties).toEqual({ 'data-source-line': 3 });
    expect(JSON.stringify(envelope)).not.toContain('producer-html');
  });

  it('crowiMath display:true → math (flow position)', () => {
    const envelope = sanitizeAst(root(htmlWithSidecar('crowiMath', { tex: 'x^2', display: true }, { hProperties: { 'data-source-line': 8 } })));
    const node = rootChildren(envelope)[0];
    expect(node.type).toBe('math');
    expect(node.value).toBe('x^2');
    expect((node.data as AnyNode).hProperties).toEqual({ 'data-source-line': 8 });
  });

  it('crowiMath display:false → inlineMath (phrasing position)', () => {
    const envelope = sanitizeAst(root(para(text('inline '), htmlWithSidecar('crowiMath', { tex: 'y', display: false }))));
    const node = (rootChildren(envelope)[0].children as AnyNode[])[1];
    expect(node.type).toBe('inlineMath');
    expect(node.value).toBe('y');
  });

  it('crowiDiagram → crowiDiagram node with intrinsic dimensions; html value gone from the wire', () => {
    const envelope = sanitizeAst(root(htmlWithSidecar('crowiDiagram', diagramSidecar({ diagramType: 'flowchart' }))));
    const node = rootChildren(envelope)[0];
    expect(node.type).toBe('crowiDiagram');
    expect(node.kind).toBe('mermaid');
    expect(node.diagramType).toBe('flowchart');
    expect((node.image as AnyNode).width).toBe(20);
    expect((node.image as AnyNode).height).toBe(10);
    expect(JSON.stringify(envelope)).not.toContain('producer-html');
  });

  it('crowiLinkCard (flow position) → crowiLinkCard node', () => {
    const envelope = sanitizeAst(root(htmlWithSidecar('crowiLinkCard', cardSidecar())));
    const node = rootChildren(envelope)[0];
    expect(node.type).toBe('crowiLinkCard');
    expect(node.url).toBe('https://example.com/a');
  });

  it('crowiPlaceholder → crowiPlaceholder node (both positions)', () => {
    const sidecar = { kind: 'error-network', label: 'Embed is temporarily unavailable.', reservation: { variant: 'fixed', heightPx: 48 } };
    const envelope = sanitizeAst(root(htmlWithSidecar('crowiPlaceholder', sidecar), para(text('a'), htmlWithSidecar('crowiPlaceholder', sidecar))));
    expect(rootChildren(envelope)[0].type).toBe('crowiPlaceholder');
    const inline = (rootChildren(envelope)[1].children as AnyNode[])[1];
    expect(inline.type).toBe('crowiPlaceholder');
  });

  it('non-projection: sidecar absent / schema-invalid / two sidecars / incompatible position all leave the html node (sidecar keys dropped)', () => {
    const displayMathInPhrasing = para(text('x'), htmlWithSidecar('crowiMath', { tex: 'z', display: true }));
    const envelope = sanitizeAst(
      root(
        { type: 'html', value: '<p>no sidecar</p>' },
        htmlWithSidecar('crowiMath', { tex: 42 }), // schema-invalid
        { type: 'html', value: '<x/>', data: { crowiMath: { tex: 'a', display: true }, crowiCode: { value: 'b', tokens: [] } } }, // ambiguous
        displayMathInPhrasing,
      ),
    );
    const children = rootChildren(envelope);
    expect(children[0]).toEqual({ type: 'html', value: '<p>no sidecar</p>' });
    expect(children[1].type).toBe('html');
    expect(children[1].data).toBeUndefined(); // sidecar key dropped by §4's unlisted-subkey default
    expect(children[2].type).toBe('html');
    expect(children[2].data).toBeUndefined();
    const inlineHtml = (children[3].children as AnyNode[])[1];
    expect(inlineHtml.type).toBe('html');
  });
});

describe('sanitizeAst — projection-time per-type validation (§10)', () => {
  it('non-canonical base64 → validation-failed placeholder', () => {
    const envelope = sanitizeAst(
      root(htmlWithSidecar('crowiDiagram', diagramSidecar({ image: { mediaType: 'image/svg+xml', base64: '!!not-base64!!', width: 20, height: 10 } }))),
    );
    expect(rootChildren(envelope)[0].kind).toBe('validation-failed');
  });

  it('decoded payload beyond 100KB → validation-failed placeholder', () => {
    const big = Buffer.from('a'.repeat(101 * 1024), 'utf8').toString('base64');
    const envelope = sanitizeAst(
      root(htmlWithSidecar('crowiDiagram', diagramSidecar({ image: { mediaType: 'image/svg+xml', base64: big, width: 20, height: 10 } }))),
    );
    expect(rootChildren(envelope)[0].kind).toBe('validation-failed');
  });

  it('SVG with dangerous content (written straight to data, no producer sanitize) is re-sanitised or rejected at projection time', () => {
    const evil = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"></rect></svg>';
    const evilB64 = Buffer.from(evil, 'utf8').toString('base64');
    const envelope = sanitizeAst(
      root(htmlWithSidecar('crowiDiagram', diagramSidecar({ image: { mediaType: 'image/svg+xml', base64: evilB64, width: 10, height: 10 } }))),
    );
    const node = rootChildren(envelope)[0];
    if (node.type === 'crowiDiagram') {
      const shipped = Buffer.from((node.image as { base64: string }).base64, 'base64').toString('utf8');
      expect(shipped).not.toContain('<script');
    } else {
      expect(node.kind).toBe('validation-failed');
    }
  });

  it('a payload declaring image/png whose bytes are not PNG → validation-failed placeholder', () => {
    const envelope = sanitizeAst(
      root(htmlWithSidecar('crowiDiagram', diagramSidecar({ image: { mediaType: 'image/png', base64: SAFE_SVG_B64, width: 10, height: 10 } }))),
    );
    expect(rootChildren(envelope)[0].kind).toBe('validation-failed');
  });

  it('a genuine PNG signature passes', () => {
    const envelope = sanitizeAst(
      root(htmlWithSidecar('crowiDiagram', diagramSidecar({ kind: 'plantuml', image: { mediaType: 'image/png', base64: PNG_B64, width: 20, height: 10 } }))),
    );
    expect(rootChildren(envelope)[0].type).toBe('crowiDiagram');
  });
});

describe('sanitizeAst — crowiLinkCard hoist (§6)', () => {
  const card = (url = 'https://c.example/x') => htmlWithSidecar('crowiLinkCard', cardSidecar(url));

  it('(a) paragraph-direct: [before, CARD, after] → [para(before), card, para(after)] with no empty paragraphs', () => {
    const envelope = sanitizeAst(root(para(text('before '), card(), text(' after'))));
    const children = rootChildren(envelope);
    expect(children.map((c) => c.type)).toEqual(['paragraph', 'crowiLinkCard', 'paragraph']);
    expect((children[0].children as AnyNode[])[0].value).toBe('before ');
    expect((children[2].children as AnyNode[])[0].value).toBe(' after');
  });

  it.each(['emphasis', 'strong', 'delete'] as const)('(b-d) card inside %s: the ancestor chain is duplicated into before/after copies', (wrapper) => {
    const envelope = sanitizeAst(root(para(text('x '), { type: wrapper, children: [text('a'), card(), text('b')] }, text(' y'))));
    const children = rootChildren(envelope);
    expect(children.map((c) => c.type)).toEqual(['paragraph', 'crowiLinkCard', 'paragraph']);
    const beforePara = children[0].children as AnyNode[];
    expect(beforePara[0].value).toBe('x ');
    expect(beforePara[1].type).toBe(wrapper);
    expect((beforePara[1].children as AnyNode[])[0].value).toBe('a');
    const afterPara = children[2].children as AnyNode[];
    expect(afterPara[0].type).toBe(wrapper);
    expect((afterPara[0].children as AnyNode[])[0].value).toBe('b');
    expect(afterPara[1].value).toBe(' y');
  });

  it('(f) card at the start/end produces no empty paragraph or empty ancestor copies', () => {
    const envelope = sanitizeAst(root(para(card(), text('tail'))));
    const children = rootChildren(envelope);
    expect(children.map((c) => c.type)).toEqual(['crowiLinkCard', 'paragraph']);
    const envelope2 = sanitizeAst(root(para(text('head'), card())));
    expect(rootChildren(envelope2).map((c) => c.type)).toEqual(['paragraph', 'crowiLinkCard']);
  });

  it('(g) multiple cards in one paragraph apply the same rule left-to-right', () => {
    const envelope = sanitizeAst(root(para(text('a'), card('https://c.example/1'), text('b'), card('https://c.example/2'), text('c'))));
    const children = rootChildren(envelope);
    expect(children.map((c) => c.type)).toEqual(['paragraph', 'crowiLinkCard', 'paragraph', 'crowiLinkCard', 'paragraph']);
    expect(children[1].url).toBe('https://c.example/1');
    expect(children[3].url).toBe('https://c.example/2');
  });

  it('(h) inside heading / tableCell: NOT hoisted — the card stays an html node (visible placeholder for declared clients)', () => {
    const envelope = sanitizeAst(
      root(
        { type: 'heading', depth: 1, children: [text('h '), card()] },
        {
          type: 'table',
          children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [card()] }] }],
        },
      ),
    );
    const [heading, table] = rootChildren(envelope);
    const inHeading = (heading.children as AnyNode[])[1];
    expect(inHeading.type).toBe('html');
    const cell = ((table.children as AnyNode[])[0].children as AnyNode[])[0];
    expect((cell.children as AnyNode[])[0].type).toBe('html');
  });
});

describe('sanitizeAst — output budget (§7)', () => {
  it('a stored AST in the (2MB, 8MB] band whose projection lands under 2MB stays a fully-renderable envelope (NOT envelope-invalid)', () => {
    // 30 producer html nodes each with ~100KB html value (stored ≈ 3MB)
    // + small math sidecars → projected envelope drops the html values.
    const bigHtml = 'H'.repeat(100 * 1024);
    const nodes = Array.from({ length: 30 }, () => ({
      type: 'html',
      value: bigHtml,
      data: { crowiMath: { tex: 'x^2', display: true } },
    }));
    const stored = root(...nodes);
    const storedBytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
    expect(storedBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(storedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    const envelope = sanitizeAst(stored);
    const children = rootChildren(envelope);
    expect(children).toHaveLength(30);
    expect(children.every((c) => c.type === 'math')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(AST_OUTPUT_BUDGET_BYTES);
  });

  it('a projected envelope over 2MB degrades the largest contributors to validation-failed placeholders — never the whole envelope', () => {
    // 25 sidecars each carrying ~150KB of TeX → projected ≈ 3.7MB.
    const nodes = Array.from({ length: 25 }, (_, i) => htmlWithSidecar('crowiMath', { tex: `${i}:${'t'.repeat(150 * 1024)}`, display: true }));
    const warn = jest.fn();
    const envelope = sanitizeAst(root(...nodes), { warn });
    const children = rootChildren(envelope);
    expect(children).toHaveLength(25);
    const placeholders = children.filter((c) => c.type === 'crowiPlaceholder' && c.kind === 'validation-failed');
    const maths = children.filter((c) => c.type === 'math');
    expect(placeholders.length).toBeGreaterThan(0);
    expect(maths.length).toBeGreaterThan(0); // the page is degraded node-by-node, not wholesale
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(AST_OUTPUT_BUDGET_BYTES);
    expect(warn).toHaveBeenCalled();
    expect(() => RenderedAstEnvelopeSchema.parse(envelope)).not.toThrow();
  });
});

describe('sanitizeAst — real-parser round-trip fixture (§3 field preservation)', () => {
  it('rendering-significant standard/GFM fields survive the walker verbatim, nullability included', async () => {
    const md = [
      '| A | B | C |',
      '|:--|--:|---|',
      '| 1 | 2 | 3 |',
      '',
      '3. ordered start',
      '4. second',
      '',
      '- [x] done',
      '- [ ] todo',
      '- plain',
      '',
      '```unknownlang some-meta',
      'raw code',
      '```',
      '',
      '[titled](https://example.com "The Title") and ![alt text](https://example.com/i.png "Img Title")',
      '',
      '[collapsed][ref] and ![imgalt][ref]',
      '',
      '[ref]: https://example.com/def "Def Title"',
      '',
      'Footnote here[^note]',
      '',
      '[^note]: the footnote body',
    ].join('\n');
    const { tree } = await runCore(md);
    const stored = serializeMdast(tree) as Root;
    const envelope = sanitizeAst(stored);
    const children = rootChildren(envelope);

    const table = children.find((c) => c.type === 'table');
    expect(table?.align).toEqual(['left', 'right', null]);

    const list = children.find((c) => c.type === 'list' && c.ordered === true);
    expect(list?.start).toBe(3);
    const taskList = children.find((c) => c.type === 'list' && c.ordered !== true);
    const checks = (taskList?.children as AnyNode[]).map((li) => li.checked);
    expect(checks).toEqual([true, false, null]);

    const code = children.find((c) => c.type === 'code');
    expect(code?.lang).toBe('unknownlang');
    expect(code?.meta).toBe('some-meta');
    expect(code?.value).toBe('raw code');

    const paraWithLink = children.find((c) => Array.isArray(c.children) && (c.children as AnyNode[]).some((n) => n.type === 'link'));
    const link = (paraWithLink?.children as AnyNode[]).find((n) => n.type === 'link');
    expect(link?.title).toBe('The Title');
    const image = (paraWithLink?.children as AnyNode[]).find((n) => n.type === 'image');
    expect(image?.alt).toBe('alt text');
    expect(image?.title).toBe('Img Title');

    const refPara = children.find((c) => Array.isArray(c.children) && (c.children as AnyNode[]).some((n) => n.type === 'linkReference'));
    const linkRef = (refPara?.children as AnyNode[]).find((n) => n.type === 'linkReference');
    expect(linkRef?.identifier).toBe('ref');
    expect(linkRef?.referenceType).toBe('full');
    const imageRef = (refPara?.children as AnyNode[]).find((n) => n.type === 'imageReference');
    expect(imageRef?.identifier).toBe('ref');
    expect(imageRef?.alt).toBe('imgalt');

    const definition = children.find((c) => c.type === 'definition');
    expect(definition?.identifier).toBe('ref');
    expect(definition?.url).toBe('https://example.com/def');
    expect(definition?.title).toBe('Def Title');

    const footnoteDef = children.find((c) => c.type === 'footnoteDefinition');
    expect(footnoteDef?.identifier).toBe('note');
    const fnPara = children.find((c) => Array.isArray(c.children) && (c.children as AnyNode[]).some((n) => n.type === 'footnoteReference'));
    const fnRef = (fnPara?.children as AnyNode[]).find((n) => n.type === 'footnoteReference');
    expect(fnRef?.identifier).toBe('note');

    // Nothing in this valid GFM document became opaque.
    expect(JSON.stringify(envelope)).not.toContain('crowiOpaque');
    expect(() => RenderedAstEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('a real shiki-highlighted fence round-trips into a tokens-carrying code node under v1 (producer sidecar → projection)', async () => {
    const { tree } = await runCore('```ts\nconst a = 1;\n```\n');
    const stored = serializeMdast(tree) as Root;
    // The producer stamped a sidecar onto an html node in the stored AST...
    const storedChild = (stored as unknown as { children: AnyNode[] }).children[0];
    expect(storedChild.type).toBe('html');
    expect((storedChild.data as AnyNode).crowiCode).toBeDefined();
    // ...and the projection turns it back into a typed code node.
    const envelope = sanitizeAst(stored);
    const code = rootChildren(envelope)[0];
    expect(code.type).toBe('code');
    expect(code.lang).toBe('ts');
    expect(code.value).toBe('const a = 1;');
    expect(Array.isArray((code.data as AnyNode).tokens)).toBe(true);
    expect(((code.data as AnyNode).tokens as unknown[]).length).toBeGreaterThan(0);
  });

  it('an unhighlighted fence (unknown lang) stays a plain code node with NO tokens under v1', async () => {
    const { tree } = await runCore('```nosuchlang\nplain\n```\n');
    const envelope = sanitizeAst(serializeMdast(tree));
    const code = rootChildren(envelope)[0];
    expect(code.type).toBe('code');
    expect(code.lang).toBe('nosuchlang');
    expect(code.data ?? {}).not.toHaveProperty('tokens');
  });

  it('a standalone attributed image round-trips as crowiFigure (shipped Crowi type)', async () => {
    const { tree } = await runCore('![alt](https://example.com/i.png)\n{width=50%}\n');
    const stored = serializeMdast(tree) as { children: AnyNode[] };
    const figure = stored.children.find((c) => c.type === 'crowiFigure');
    expect(figure).toBeDefined();
    const envelope = sanitizeAst(stored);
    const projected = rootChildren(envelope).find((c) => c.type === 'crowiFigure');
    expect(projected).toBeDefined();
    expect((projected?.data as AnyNode).hName).toBe('figure');
  });

  it('a document-leading frontmatter block round-trips as crowiFrontmatter (feature-renderer-frontmatter AC-8)', async () => {
    const md = ['---', 'id: feature-foo', 'status: approved', '---', '', 'body'].join('\n');
    const { tree } = await runCore(md);
    const stored = serializeMdast(tree) as { children: AnyNode[] };
    const fm = stored.children.find((c) => c.type === 'crowiFrontmatter');
    expect(fm).toBeDefined();
    const envelope = sanitizeAst(stored);
    const projected = rootChildren(envelope).find((c) => c.type === 'crowiFrontmatter');
    expect(projected).toBeDefined();
    expect(projected?.entries).toEqual([
      { key: 'id', value: 'feature-foo' },
      { key: 'status', value: 'approved' },
    ]);
    expect(() => RenderedAstEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('a GitHub Alerts quote is stored as crowiAlert and served to a declared v1 client as the same-shaped blockquote', async () => {
    const { tree } = await runCore('> [!WARNING]\n> body\n');
    const stored = serializeMdast(tree) as { children: AnyNode[] };
    expect(stored.children[0].type).toBe('crowiAlert');

    const envelope = sanitizeAst(stored);
    const projected = rootChildren(envelope)[0];
    expect(projected.type).toBe('blockquote');
    // The marker is still the first text node and the delimiter is
    // still a `break` — the same children an ordinary quote carried.
    expect(projected.children).toEqual(stored.children[0].children);
    expect(JSON.stringify(projected)).toContain('[!WARNING]');
    expect(() => RenderedAstEnvelopeSchema.parse(envelope)).not.toThrow();
  });
});

describe('serializeMdast call sites stay untouched (design doc §2 — walker is response-time only)', () => {
  const apiSrc = path.join(__dirname, '..');
  it('renderer/index.ts and page-preview.ts still call serializeMdast, and neither imports sanitize-ast', () => {
    const rendererIndex = readFileSync(path.join(apiSrc, 'renderer', 'index.ts'), 'utf8');
    const preview = readFileSync(path.join(apiSrc, 'hono', 'handlers', 'page-preview.ts'), 'utf8');
    expect(rendererIndex).toContain('serializeMdast(result.tree)');
    expect(preview).toContain('serializeMdast(tree)');
    expect(rendererIndex).not.toContain('sanitize-ast');
    expect(preview).not.toContain('sanitize-ast');
    // sanitizeAst is only reachable through the negotiation chokepoint.
    const negotiation = readFileSync(path.join(apiSrc, 'util', 'rendered-ast-negotiation.ts'), 'utf8');
    expect(negotiation).toContain("from 'src/renderer/sanitize-ast'");
  });
});
