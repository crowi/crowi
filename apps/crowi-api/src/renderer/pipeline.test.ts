import type { PluginLogger } from '@crowi/plugin-api';
import { createPipelineEsmDepsLoader, runPipeline } from './pipeline';
import { RendererRegistryImpl } from './registry';

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
// test for "core renderer behaviour".
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
});

describe('RendererRegistryImpl warn-noops', () => {
  it('discards code-block-renderer registrations and warns', () => {
    const warn = jest.fn();
    const log: PluginLogger = { debug: () => undefined, info: () => undefined, warn, error: () => undefined };
    const reg = new RendererRegistryImpl();
    // Direct registration via the impl skipped; use the scope to
    // exercise the warn-noop path the way external plugins will.
    // (Imports tested at the integration level.)
    const { makeRendererScope } = require('./registry');
    const scope = makeRendererScope(reg, '@crowi/plugin-test', log);
    scope.addCodeBlockRenderer('mermaid', () => ({ html: '' }));
    scope.addEmbedTag('youtube', () => ({ html: '' }));
    scope.addUrlInlineExpander({ match: /x/, expand: () => ({ html: '' }) });
    expect(warn).toHaveBeenCalledTimes(3);
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
