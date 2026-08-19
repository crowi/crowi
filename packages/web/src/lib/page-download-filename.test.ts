import { describe, expect, it } from 'vitest';
import { toMarkdownFileName } from './page-download-filename';

describe('toMarkdownFileName', () => {
  it('uses the last path segment for a normal page', () => {
    expect(toMarkdownFileName('/foo/bar', 'fallback-id')).toBe('bar.md');
  });

  it('drops the trailing slash for a portal page', () => {
    expect(toMarkdownFileName('/foo/bar/', 'fallback-id')).toBe('bar.md');
  });

  it('falls back to the given id for the root path', () => {
    expect(toMarkdownFileName('/', 'page-id-123')).toBe('page-id-123.md');
  });

  it('falls back to the given id when sanitization leaves no characters (all-dot segment)', () => {
    expect(toMarkdownFileName('/...', 'page-id-123')).toBe('page-id-123.md');
  });

  it('preserves Japanese page names as-is', () => {
    expect(toMarkdownFileName('/foo/日本語のページ名', 'fallback-id')).toBe('日本語のページ名.md');
  });

  it('drops a path-separator segment boundary, keeping only the last segment', () => {
    expect(toMarkdownFileName('/foo/a/bar', 'fallback-id')).toBe('bar.md');
  });

  it('replaces Windows-forbidden punctuation (including a literal backslash) with a hyphen', () => {
    expect(toMarkdownFileName('/foo/a\\b:c*d?e"f<g>h|i', 'fallback-id')).toBe('a-b-c-d-e-f-g-h-i.md');
  });

  it('replaces an embedded ASCII code-point-1 byte with a hyphen', () => {
    const unsafeByte = String.fromCharCode(1);
    const raw = ['a', unsafeByte, 'b'].join('');
    expect(toMarkdownFileName(`/foo/${raw}`, 'fallback-id')).toBe('a-b.md');
  });

  it('trims leading/trailing whitespace and dots from the base name', () => {
    expect(toMarkdownFileName('/foo/ ..bar.. ', 'fallback-id')).toBe('bar.md');
  });

  it('truncates a base name longer than 100 characters', () => {
    const longName = 'a'.repeat(150);
    const result = toMarkdownFileName(`/foo/${longName}`, 'fallback-id');
    expect(result).toBe(`${'a'.repeat(100)}.md`);
  });

  it('re-trims a trailing dot exposed by truncation', () => {
    // 99 'a's followed by a dot, then more 'a's — truncating to 100 chars
    // lands exactly on the dot (the 100th character), which must not
    // survive into the filename.
    const name = `${'a'.repeat(99)}.${'a'.repeat(10)}`;
    const result = toMarkdownFileName(`/foo/${name}`, 'fallback-id');
    expect(result).toBe(`${'a'.repeat(99)}.md`);
  });

  it('truncates by Unicode character, not UTF-16 code unit, keeping an astral character at the cut boundary intact', () => {
    // An emoji is a single code point but two UTF-16 code units; placing
    // one exactly at the 100-character boundary would split it into an
    // unpaired surrogate if truncation used `.slice` directly on the string.
    const name = `${'a'.repeat(99)}😀${'a'.repeat(10)}`;
    const result = toMarkdownFileName(`/foo/${name}`, 'fallback-id');
    expect(result).toBe(`${'a'.repeat(99)}😀.md`);
    expect(Array.from(result.replace(/\.md$/, ''))).toHaveLength(100);
  });
});
