import type { Code, Html, Root } from 'mdast';
import type { PluginLogger } from '@crowi/plugin-api';
import { createPipelineEsmDepsLoader, runPipeline } from './pipeline';
import { RendererRegistryImpl, createAuthContextStub } from './registry';
import { serializeMdast } from './serialize';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// One loader for the whole test file so the ESM `require()` happens once.
const loadDeps = createPipelineEsmDepsLoader();

// The pipeline always prepends the bundled core 4 transforms on every
// run — runPipeline against a fresh empty registry is what we want to
// test for "core renderer behaviour". No `dispatch` is passed, so the
// plugin-dispatch transforms (embed-tags / url-inline-expand) are
// skipped entirely.
const runCore = async (body: string) => {
  const reg = new RendererRegistryImpl();
  return runPipeline(body, reg, { mode: 'save', log: silentLogger }, loadDeps);
};

describe('pipeline + core renderers', () => {
  describe('TOC (heading anchors via github-slugger)', () => {
    it('returns empty toc for empty body', async () => {
      const { metadata } = await runCore('');
      expect(metadata.toc).toEqual([]);
    });

    it('extracts ATX headings with levels and anchors', async () => {
      const md = ['# Title', '', '## Section A', '', '### Sub A1', '', '## Section B'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.toc).toEqual([
        { level: 1, text: 'Title', anchorId: 'title' },
        { level: 2, text: 'Section A', anchorId: 'section-a' },
        { level: 3, text: 'Sub A1', anchorId: 'sub-a1' },
        { level: 2, text: 'Section B', anchorId: 'section-b' },
      ]);
    });

    it('skips headings inside fenced code blocks', async () => {
      const md = ['# Real heading', '', '```ts', '// # not a heading', '```', '', '## After fence'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.toc.map((e) => e.text)).toEqual(['Real heading', 'After fence']);
    });

    it('handles tilde fences too', async () => {
      const md = ['# H1', '', '~~~', '# inside', '~~~', '', '## H2'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.toc.map((e) => e.text)).toEqual(['H1', 'H2']);
    });

    it('strips inline markup from heading labels but keeps anchor stable', async () => {
      const md = '## Use the `Crowi` **API**';
      const { metadata } = await runCore(md);
      expect(metadata.toc).toEqual([{ level: 2, text: 'Use the Crowi API', anchorId: 'use-the-crowi-api' }]);
    });

    it('disambiguates duplicate slugs with -1, -2', async () => {
      const md = ['## Notes', '## Notes', '## Notes'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.toc.map((e) => e.anchorId)).toEqual(['notes', 'notes-1', 'notes-2']);
    });

    it('ignores trailing hashes (closed ATX style)', async () => {
      const { metadata } = await runCore('## Heading ##');
      expect(metadata.toc).toEqual([{ level: 2, text: 'Heading', anchorId: 'heading' }]);
    });

    it('ignores fake headings (no space after hash)', async () => {
      const { metadata } = await runCore('#nottag');
      expect(metadata.toc).toEqual([]);
    });

    it('preserves CJK characters in slug', async () => {
      const { metadata } = await runCore('## 日本語の見出し');
      // github-slugger preserves Unicode letters in the slug.
      expect(metadata.toc[0].text).toBe('日本語の見出し');
      expect(metadata.toc[0].anchorId).toBe('日本語の見出し');
    });

    it('mixes CJK + ASCII', async () => {
      const { metadata } = await runCore('## Crowi の使い方');
      expect(metadata.toc[0].anchorId).toBe('crowi-の使い方');
    });

    it('keeps RAW inline HTML in the TOC label but slugs the anchor from the stripped text', async () => {
      // `mdast-util-to-string` defaults to `includeHtml: true`, so the raw
      // `<font …>` / `</font>` markup is present in the heading text. We keep
      // it RAW in `meta.toc[].text` (stored data is never mutated; the web
      // strips it at display) while the anchor id is slugged from the STRIPPED
      // text so the hash is clean and `id == href`.
      const { metadata } = await runCore('### <font color="1a73e8">Workspace の作成</font>');
      expect(metadata.toc).toEqual([{ level: 3, text: '<font color="1a73e8">Workspace の作成</font>', anchorId: 'workspace-の作成' }]);
    });

    it('keeps mixed HTML + plain text RAW in the label, anchor from stripped text', async () => {
      const { metadata } = await runCore('## Plain <b>bold</b> tail');
      expect(metadata.toc[0].text).toBe('Plain <b>bold</b> tail');
      expect(metadata.toc[0].anchorId).toBe('plain-bold-tail');
    });

    it('drops an HTML-only heading from the TOC (no visible label remains)', async () => {
      // `### <br>` strips to an empty label; there is no visible text to put in
      // the TOC, so the entry is dropped entirely (the body heading still gets
      // a non-empty id slugged from the raw text — see the hProperties test).
      const { metadata } = await runCore('### <br>');
      expect(metadata.toc).toEqual([]);
    });

    it('keeps surrounding headings while dropping the HTML-only one', async () => {
      const md = ['# Real', '', '### <br>', '', '## Tail'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.toc.map((e) => e.text)).toEqual(['Real', 'Tail']);
    });

    it('gives a symbol/emoji-only heading a non-empty synthetic anchorId', async () => {
      // `## 🎉` has no slug-able characters, so github-slugger returns ''. The
      // TOC entry must still carry a NON-EMPTY anchorId (an empty one renders
      // `href="#"` → broken jump); it falls back to a synthetic `section` slug.
      const { metadata } = await runCore('## 🎉');
      expect(metadata.toc).toHaveLength(1);
      expect(metadata.toc[0].anchorId).toBe('section');
      expect(metadata.toc[0].anchorId.length).toBeGreaterThan(0);
    });

    it('dedups multiple symbol-only headings via the synthetic slug', async () => {
      const { metadata } = await runCore(['## 🎉', '', '## ✨'].join('\n'));
      expect(metadata.toc.map((e) => e.anchorId)).toEqual(['section', 'section-1']);
    });
  });

  describe('wikilinks', () => {
    it('extracts and links absolute paths', async () => {
      const md = 'See [[/foo/bar]] for details.';
      const { metadata } = await runCore(md);
      expect(metadata.wikiLinks).toEqual([{ raw: '/foo/bar', target: '/foo/bar' }]);
    });

    it('parses pipe-aliased display text', async () => {
      const md = 'Check [[/setup|Setup Guide]] please.';
      const { metadata } = await runCore(md);
      expect(metadata.wikiLinks).toEqual([{ raw: '/setup|Setup Guide', target: '/setup', displayText: 'Setup Guide' }]);
    });

    it('keeps section anchors in target', async () => {
      const md = 'Jump to [[/page#section-a]] now.';
      const { metadata } = await runCore(md);
      expect(metadata.wikiLinks).toEqual([{ raw: '/page#section-a', target: '/page#section-a' }]);
    });

    it('treats non-absolute targets as broken', async () => {
      const md = 'Bare [[Page]] reference.';
      const { metadata } = await runCore(md);
      expect(metadata.wikiLinks).toEqual([{ raw: 'Page', target: 'Page' }]);
    });

    it('does not extract from fenced code blocks', async () => {
      const md = ['Before [[/keep]]', '', '```', '[[/skip]]', '```', '', 'After [[/also-keep]]'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.wikiLinks.map((w) => w.target)).toEqual(['/keep', '/also-keep']);
    });

    it('does not extract from inline code', async () => {
      const md = 'Live `[[/skip]]` skipped, [[/kept]] kept.';
      const { metadata } = await runCore(md);
      expect(metadata.wikiLinks.map((w) => w.target)).toEqual(['/kept']);
    });

    it('extracts inside headings, blockquotes, and list items', async () => {
      const md = ['## Heading [[/h]]', '', '> Quote [[/q]]', '', '- Item [[/i]]'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.wikiLinks.map((w) => w.target).sort()).toEqual(['/h', '/i', '/q']);
    });

    it('extracts multiple wikilinks in one paragraph', async () => {
      const md = 'See [[/a]] and [[/b]] and [[Page|Display]].';
      const { metadata } = await runCore(md);
      expect(metadata.wikiLinks).toHaveLength(3);
    });
  });

  describe('mentions', () => {
    it('extracts standalone @username', async () => {
      const md = 'Hi @alice and @bob_dev-1.';
      const { metadata } = await runCore(md);
      expect(metadata.mentions).toEqual([{ username: 'alice' }, { username: 'bob_dev-1' }]);
    });

    it('does not match @ inside email addresses', async () => {
      const md = 'Email me at me@example.com please.';
      const { metadata } = await runCore(md);
      expect(metadata.mentions).toEqual([]);
    });

    it('does not extract mentions inside code blocks', async () => {
      const md = ['```', '@skipped', '```', '', '`@inline-skip` and @kept'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.mentions).toEqual([{ username: 'kept' }]);
    });

    it('does not double-link inside an existing link', async () => {
      const md = '[See @inside](https://example.com)';
      const { metadata } = await runCore(md);
      expect(metadata.mentions).toEqual([]);
    });

    it('matches at start of string', async () => {
      const md = '@firstword leads.';
      const { metadata } = await runCore(md);
      expect(metadata.mentions).toEqual([{ username: 'firstword' }]);
    });

    it('matches inside headings, blockquotes, list items', async () => {
      const md = ['## Hi @h', '', '> Quote @q', '', '- Item @i'].join('\n');
      const { metadata } = await runCore(md);
      const usernames = metadata.mentions.map((m) => m.username).sort();
      expect(usernames).toEqual(['h', 'i', 'q']);
    });
  });

  describe('codeBlockLanguages', () => {
    it('aggregates fence languages, unique and sorted', async () => {
      const md = ['```ts', 'a', '```', '', '```ts', 'b', '```', '', '```python', 'c', '```'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.codeBlockLanguages).toEqual(['python', 'ts']);
    });

    it('ignores fences without a language tag', async () => {
      const md = ['```', 'no lang', '```', '', '```rust', 'k', '```'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.codeBlockLanguages).toEqual(['rust']);
    });

    it('returns empty array when there are no fences', async () => {
      const { metadata } = await runCore('plain text only');
      expect(metadata.codeBlockLanguages).toEqual([]);
    });
  });

  describe('combined run', () => {
    it('populates all 4 metadata fields in one parse', async () => {
      const md = ['# Welcome', '', '## Setup', '', 'See [[/install]] and ping @alice.', '', '```ts', 'const x = 1;', '```'].join('\n');
      const { metadata } = await runCore(md);
      expect(metadata.toc.map((e) => e.text)).toEqual(['Welcome', 'Setup']);
      expect(metadata.wikiLinks.map((w) => w.target)).toEqual(['/install']);
      expect(metadata.mentions.map((m) => m.username)).toEqual(['alice']);
      expect(metadata.codeBlockLanguages).toEqual(['ts']);
    });
  });

  describe('renderedAst (transformed mdast persistence — Phase 3)', () => {
    it('returns a JSON-serialisable tree with no `position` fields', async () => {
      const md = '# Title\n\nbody.';
      const { tree } = await runCore(md);
      const serialised = serializeMdast(tree);
      // Must round-trip through JSON without throwing.
      const json = JSON.stringify(serialised);
      const parsed = JSON.parse(json) as { type: string; children: unknown[] };
      expect(parsed.type).toBe('root');
      // Strip leaves no `position` anywhere.
      expect(json.includes('"position"')).toBe(false);
    });

    it('preserves heading anchor ids on `data.hProperties.id`', async () => {
      const md = '## Section A\n\n## Section B';
      const { tree } = await runCore(md);
      const ids = tree.children
        .filter((c): c is { type: 'heading'; data?: { hProperties?: { id?: string } } } & typeof c => c.type === 'heading')
        .map((h) => h.data?.hProperties?.id);
      expect(ids).toEqual(['section-a', 'section-b']);
    });

    it('stamps a non-empty id even on an HTML-only heading dropped from the TOC', async () => {
      // `### <br>` is dropped from the TOC (no visible label) but the body
      // heading must still carry a non-empty id (slugged from the raw text),
      // so it is never given an empty anchor.
      const { tree } = await runCore('### <br>');
      const heading = tree.children.find((c): c is { type: 'heading'; data?: { hProperties?: { id?: string } } } & typeof c => c.type === 'heading');
      expect(heading?.data?.hProperties?.id).toBeTruthy();
    });

    it('slugs the heading id from the stripped text (clean hash, id == href)', async () => {
      const { tree, metadata } = await runCore('### <font color="1a73e8">Workspace</font>');
      const heading = tree.children.find((c): c is { type: 'heading'; data?: { hProperties?: { id?: string } } } & typeof c => c.type === 'heading');
      // Body heading id and the TOC anchorId are both the stripped slug.
      expect(heading?.data?.hProperties?.id).toBe('workspace');
      expect(metadata.toc[0].anchorId).toBe('workspace');
    });

    it('stamps the SAME non-empty id on a symbol-only heading and its TOC entry', async () => {
      // `## 🎉` slugs to '' → synthetic `section`. The body heading id and the
      // TOC anchorId must be identical and non-empty so the in-page jump works.
      const { tree, metadata } = await runCore('## 🎉');
      const heading = tree.children.find((c): c is { type: 'heading'; data?: { hProperties?: { id?: string } } } & typeof c => c.type === 'heading');
      expect(heading?.data?.hProperties?.id).toBe('section');
      expect(heading?.data?.hProperties?.id).toBe(metadata.toc[0].anchorId);
    });

    it('preserves wikilink-broken / mention className stamps after serialise', async () => {
      const md = 'See [[Bare]] and ping @alice.';
      const { tree } = await runCore(md);
      const out = serializeMdast(tree) as { children: Array<{ children: Array<{ type: string; data?: { hProperties?: { className?: string } } }> }> };
      const para = out.children[0];
      const classes = para.children.filter((c) => c.type === 'link').map((c) => c.data?.hProperties?.className);
      expect(classes).toContain('wikilink-broken');
      expect(classes).toContain('mention');
    });

    it('replaces a known-language fence with an `html` node carrying shiki output', async () => {
      const md = ['```ts', 'const x: number = 1;', '```'].join('\n');
      const { tree } = await runCore(md);
      const top = tree.children[0];
      expect(top.type).toBe('html');
      const html = (top as Html).value;
      // shiki always emits a top-level `<pre class="shiki ...">`. With
      // dual-theme output the `<pre>` carries `--shiki-light-bg` /
      // `--shiki-dark-bg` CSS variables instead of a single bg colour.
      expect(html).toContain('<pre');
      expect(html).toContain('shiki');
    });

    it('keeps unknown-language fences as `code` nodes (web-side fallback)', async () => {
      const md = ['```brainfuck', '+++[->+<]', '```'].join('\n');
      const { tree } = await runCore(md);
      const top = tree.children[0];
      expect(top.type).toBe('code');
      expect((top as Code).lang).toBe('brainfuck');
    });

    it('keeps fences without a language as `code` nodes', async () => {
      const md = ['```', 'plain', '```'].join('\n');
      const { tree } = await runCore(md);
      expect(tree.children[0].type).toBe('code');
    });

    it('highlights PHP fences (bundled lang)', async () => {
      const md = ['```php', '<?php declare(strict_types = 1);', 'namespace PHPStan;', '```'].join('\n');
      const { tree } = await runCore(md);
      const top = tree.children[0];
      expect(top.type).toBe('html');
      const html = (top as Html).value;
      expect(html).toContain('<pre');
      expect(html).toContain('shiki');
      // Dual-theme (`defaultColor: false`) emits per-token spans carrying
      // `--shiki-light` / `--shiki-dark` CSS variables instead of a single
      // `color:` declaration — proof that the highlighter actually
      // tokenised the body (otherwise it'd just escape the raw text).
      expect(html).toMatch(/<span[^>]*style="[^"]*--shiki-light:/);
      expect(html).toMatch(/<span[^>]*style="[^"]*--shiki-dark:/);
      expect(html).toContain('PHPStan');
    });
  });

  describe('single-newline → `<br>` (Crowi default via remark-breaks)', () => {
    // The breaks transform was previously gated behind the
    // `@crowi/plugin-renderer-crowi-legacy` plugin but is now baked
    // into the core pipeline because GFM (GitHub / GitLab / Slack /
    // everywhere) treats single newlines as hard breaks. These tests
    // pin the default behaviour so future refactors don't silently
    // regress to CommonMark soft-break semantics.
    it('inserts a `break` node between two lines separated by a single newline', async () => {
      const { tree } = await runCore('line1\nline2');
      const paragraph = tree.children[0] as { type: string; children: Array<{ type: string }> };
      expect(paragraph.type).toBe('paragraph');
      expect(paragraph.children.find((c) => c.type === 'break')).toMatchObject({ type: 'break' });
    });

    it('does NOT collapse blank-line paragraph breaks into a `break` node', async () => {
      // `\n\n` is the spec's paragraph delimiter — remark-breaks only
      // touches single-newline soft breaks, so the two paragraphs
      // remain separate and neither contains a break node.
      const { tree } = await runCore('para1\n\npara2');
      expect(tree.children).toHaveLength(2);
      for (const child of tree.children) {
        expect(child.type).toBe('paragraph');
        const para = child as { children: Array<{ type: string }> };
        expect(para.children.find((c) => c.type === 'break')).toBeUndefined();
      }
    });

    it('leaves newlines inside fenced code blocks untouched', async () => {
      // Fenced code is a `code` leaf node — remark-breaks walks
      // paragraph children only, so the original `a\nb` body survives
      // verbatim and shiki can still highlight it.
      const md = ['```', 'a', 'b', '```'].join('\n');
      const { tree } = await runCore(md);
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0].type).toBe('code');
    });

    it('heading slugs are computed BEFORE breaks (anchor parity with GFM-only build)', async () => {
      // The pipeline orders `core 4 → remark-breaks → registry`. If
      // remark-breaks ever moved ahead of headings, `break` nodes
      // injected into the heading children would change what
      // `mdastToString` reports — and therefore the slug. This test
      // pins the order via the anchor.
      const { metadata } = await runCore('# Hello World\n\nbody');
      expect(metadata.toc).toHaveLength(1);
      expect(metadata.toc[0].anchorId).toBe('hello-world');
    });
  });

  describe('on-the-fly fallback (renderedAst recompute for legacy revisions)', () => {
    it('produces an equivalent AST when the same body is re-run', async () => {
      // The fallback path runs the pipeline against the body when no
      // stored AST exists; same input must yield byte-identical JSON
      // (shiki output is deterministic for the same theme + lang).
      const md = '# Hello\n\n[[/wiki]] @alice\n\n```ts\nx\n```';
      const a = serializeMdast((await runCore(md)).tree) as Record<string, unknown>;
      const b = serializeMdast((await runCore(md)).tree) as Record<string, unknown>;
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('produces an empty Root for empty body (legacy revision with no body)', async () => {
      const tree: Root = (await runCore('')).tree;
      expect(tree).toEqual({ type: 'root', children: [] });
      expect(serializeMdast(tree)).toEqual({ type: 'root', children: [] });
    });
  });
});

describe('RendererRegistryImpl registrations (Phase 6: addCodeBlockRenderer is live)', () => {
  it('persists code-block-renderer registrations without warn', () => {
    const warn = jest.fn();
    const log: PluginLogger = { debug: () => undefined, info: () => undefined, warn, error: () => undefined };
    const reg = new RendererRegistryImpl();
    const { makeRendererScope } = require('./registry');
    const scope = makeRendererScope(reg, '@crowi/plugin-test', log);
    const renderer = { cacheVersion: 1, render: () => ({ html: '<x/>' }) };
    scope.addCodeBlockRenderer('mermaid', renderer);
    expect(warn).not.toHaveBeenCalled();
    expect(reg.getCodeBlockRenderer('mermaid')?.renderer).toBe(renderer);
    expect(reg.getCodeBlockRenderer('mermaid')?.plugin).toBe('@crowi/plugin-test');
    expect(reg.hasCodeBlockRenderers()).toBe(true);
  });

  it('addCodeBlockRenderer collision is last-wins + boot warn', () => {
    const warn = jest.fn();
    const log: PluginLogger = { debug: () => undefined, info: () => undefined, warn, error: () => undefined };
    const reg = new RendererRegistryImpl();
    const { makeRendererScope } = require('./registry');
    const scopeA = makeRendererScope(reg, '@crowi/plugin-a', log);
    const scopeB = makeRendererScope(reg, '@crowi/plugin-b', log);
    const rendererA = { cacheVersion: 1, render: () => ({ html: 'A' }) };
    const rendererB = { cacheVersion: 1, render: () => ({ html: 'B' }) };
    scopeA.addCodeBlockRenderer('plantuml', rendererA);
    scopeB.addCodeBlockRenderer('plantuml', rendererB);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/code-block-renderer collision on 'plantuml'/);
    expect(reg.getCodeBlockRenderer('plantuml')?.plugin).toBe('@crowi/plugin-b');
    expect(reg.getCodeBlockRenderer('plantuml')?.renderer).toBe(rendererB);
  });

  it('persists addEmbedTag and addUrlInlineExpander registrations (Phase 4)', () => {
    const warn = jest.fn();
    const log: PluginLogger = { debug: () => undefined, info: () => undefined, warn, error: () => undefined };
    const reg = new RendererRegistryImpl();
    const { makeRendererScope } = require('./registry');
    const scope = makeRendererScope(reg, '@crowi/plugin-test', log);

    const embedRenderer = { cacheVersion: 1, render: () => ({ html: '<x/>' }) };
    scope.addEmbedTag('youtube', embedRenderer);
    expect(warn).not.toHaveBeenCalled();
    expect(reg.getEmbedTag('youtube')?.renderer).toBe(embedRenderer);
    expect(reg.getEmbedTag('youtube')?.plugin).toBe('@crowi/plugin-test');

    const rule = { cacheVersion: 1, match: /x/, expand: () => ({ kind: 'unchanged' as const }) };
    scope.addUrlInlineExpander(rule);
    const list = reg.getUrlInlineExpanders();
    expect(list).toHaveLength(1);
    expect(list[0].rule).toBe(rule);
    expect(list[0].plugin).toBe('@crowi/plugin-test');
  });

  it('addEmbedTag collision is last-wins + boot warn', () => {
    const warn = jest.fn();
    const log: PluginLogger = { debug: () => undefined, info: () => undefined, warn, error: () => undefined };
    const reg = new RendererRegistryImpl();
    const { makeRendererScope } = require('./registry');
    const scopeA = makeRendererScope(reg, '@crowi/plugin-a', log);
    const scopeB = makeRendererScope(reg, '@crowi/plugin-b', log);
    const rendererA = { cacheVersion: 1, render: () => ({ html: 'A' }) };
    const rendererB = { cacheVersion: 1, render: () => ({ html: 'B' }) };
    scopeA.addEmbedTag('shared', rendererA);
    scopeB.addEmbedTag('shared', rendererB);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/collision on 'shared'/);
    expect(reg.getEmbedTag('shared')?.plugin).toBe('@crowi/plugin-b');
    expect(reg.getEmbedTag('shared')?.renderer).toBe(rendererB);
  });

  it('discards non-transform unified-plugin phases and warns', () => {
    const warn = jest.fn();
    const log: PluginLogger = { debug: () => undefined, info: () => undefined, warn, error: () => undefined };
    const reg = new RendererRegistryImpl();
    const { makeRendererScope } = require('./registry');
    const scope = makeRendererScope(reg, '@crowi/plugin-test', log);
    scope.addUnifiedPlugin(() => () => undefined, { phase: 'pre' });
    scope.addUnifiedPlugin(() => () => undefined, { phase: 'post' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(reg.getTransformPlugins()).toHaveLength(0);
  });
});

describe('AuthContext stub (Phase 4 — Phase 7 implements)', () => {
  it('config() throws because Phase 4 only ships the interface', () => {
    const auth = createAuthContextStub();
    expect(() => auth.config({} as never)).toThrow(/AuthContext not yet implemented — Phase 7/);
  });
});
