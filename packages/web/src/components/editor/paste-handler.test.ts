import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { extractSingleUrl, isInsideLinkSyntax } from './paste-handler';

/**
 * RFC-0004 Phase 6 — unit tests for the paste handler's pure logic:
 * single-URL detection from a clipboard payload and the "cursor inside
 * link syntax" check that suppresses double-wrapping.
 */

describe('extractSingleUrl', () => {
  it('returns the URL when the payload is exactly one http(s) URL', () => {
    expect(extractSingleUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(extractSingleUrl('http://example.com')).toBe('http://example.com');
  });

  it('trims surrounding whitespace and trailing newlines', () => {
    expect(extractSingleUrl('  https://example.com/x \n')).toBe('https://example.com/x');
  });

  it('returns null when the payload contains more than a URL', () => {
    expect(extractSingleUrl('see https://example.com here')).toBeNull();
    expect(extractSingleUrl('https://example.com and more text')).toBeNull();
  });

  it('returns null for non-http(s) schemes and non-URLs', () => {
    expect(extractSingleUrl('ftp://example.com/file')).toBeNull();
    expect(extractSingleUrl('javascript:alert(1)')).toBeNull();
    expect(extractSingleUrl('just plain text')).toBeNull();
    expect(extractSingleUrl('')).toBeNull();
  });
});

describe('isInsideLinkSyntax', () => {
  /** Build a markdown EditorState with a fully-realised syntax tree. */
  const stateFor = (doc: string): EditorState => {
    const state = EditorState.create({ doc, extensions: [markdown()] });
    ensureSyntaxTree(state, doc.length, 5000);
    return state;
  };

  it('is true inside a [text](url) link', () => {
    const doc = 'see [the docs](https://example.com) now';
    const state = stateFor(doc);
    // Position inside the URL portion.
    expect(isInsideLinkSyntax(state, doc.indexOf('example'))).toBe(true);
  });

  it('is false in plain prose outside any link', () => {
    const doc = 'just some plain words here';
    const state = stateFor(doc);
    expect(isInsideLinkSyntax(state, 10)).toBe(false);
  });
});
