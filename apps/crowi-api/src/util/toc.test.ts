import { Slugger, extractToc, slug } from '@crowi/api-contract';

describe('slug', () => {
  it('lowercases and replaces whitespace with hyphens', () => {
    expect(slug('Hello World')).toBe('hello-world');
  });

  it('drops punctuation', () => {
    expect(slug('Hello, World!')).toBe('hello-world');
  });

  it('preserves Japanese characters', () => {
    expect(slug('日本語の見出し')).toBe('日本語の見出し');
  });

  it('handles mixed CJK + ASCII', () => {
    expect(slug('Crowi の使い方')).toBe('crowi-の使い方');
  });

  it('collapses multiple hyphens', () => {
    expect(slug('foo  --  bar')).toBe('foo-bar');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slug('-foo-')).toBe('foo');
  });
});

describe('Slugger', () => {
  it('appends -1, -2 to duplicates', () => {
    const s = new Slugger();
    expect(s.slug('foo')).toBe('foo');
    expect(s.slug('foo')).toBe('foo-1');
    expect(s.slug('foo')).toBe('foo-2');
  });

  it('falls back to "section" for empty inputs', () => {
    const s = new Slugger();
    expect(s.slug('')).toBe('section');
    expect(s.slug('   ')).toBe('section-1');
  });
});

describe('extractToc', () => {
  it('returns empty array for empty body', () => {
    expect(extractToc('')).toEqual([]);
  });

  it('extracts ATX headings with levels and anchors', () => {
    const md = ['# Title', '', '## Section A', '', '### Sub A1', '', '## Section B'].join('\n');
    expect(extractToc(md)).toEqual([
      { level: 1, text: 'Title', anchorId: 'title' },
      { level: 2, text: 'Section A', anchorId: 'section-a' },
      { level: 3, text: 'Sub A1', anchorId: 'sub-a1' },
      { level: 2, text: 'Section B', anchorId: 'section-b' },
    ]);
  });

  it('skips headings inside fenced code blocks', () => {
    const md = ['# Real heading', '', '```ts', '// # not a heading', '```', '', '## After fence'].join('\n');
    expect(extractToc(md).map((e) => e.text)).toEqual(['Real heading', 'After fence']);
  });

  it('handles tilde fences too', () => {
    const md = ['# H1', '', '~~~', '# inside', '~~~', '', '## H2'].join('\n');
    expect(extractToc(md).map((e) => e.text)).toEqual(['H1', 'H2']);
  });

  it('strips inline markup from heading labels but keeps anchor stable', () => {
    const md = '## Use the `Crowi` **API**';
    expect(extractToc(md)).toEqual([{ level: 2, text: 'Use the Crowi API', anchorId: 'use-the-crowi-api' }]);
  });

  it('disambiguates duplicate slugs with -1, -2', () => {
    const md = ['## Notes', '## Notes', '## Notes'].join('\n');
    expect(extractToc(md).map((e) => e.anchorId)).toEqual(['notes', 'notes-1', 'notes-2']);
  });

  it('ignores trailing hashes (closed ATX style)', () => {
    expect(extractToc('## Heading ##')).toEqual([{ level: 2, text: 'Heading', anchorId: 'heading' }]);
  });

  it('ignores fake headings (no space after hash)', () => {
    expect(extractToc('#nottag')).toEqual([]);
  });
});
