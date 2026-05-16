import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { detectTrigger, isSuppressedContext, isMobileWidth } from './autocomplete-extension';

/**
 * RFC-0004 Phase 5 — unit tests for the autocomplete extension's pure
 * logic: trigger detection (`@<char>` / `[[<char>+`), the bare-`@` /
 * trigger-precondition exclusions, suppression contexts (code / link),
 * and the mobile-width heuristic.
 */
describe('detectTrigger', () => {
  it('detects an @mention trigger at start of line', () => {
    expect(detectTrigger('@al')).toEqual({ kind: 'user', query: 'al', from: 0 });
  });

  it('detects an @mention after whitespace', () => {
    expect(detectTrigger('hello @bob')).toEqual({ kind: 'user', query: 'bob', from: 6 });
  });

  it('does NOT trigger on bare @ (no character yet)', () => {
    expect(detectTrigger('@')).toBeNull();
    expect(detectTrigger('hi @')).toBeNull();
  });

  it('does NOT trigger on @[ (embed syntax)', () => {
    // `[` is not a username character, so `@[` produces no query.
    expect(detectTrigger('@[')).toBeNull();
  });

  it('does NOT trigger on @ inside a word (email)', () => {
    expect(detectTrigger('user@example')).toBeNull();
  });

  it('detects a wikilink trigger', () => {
    expect(detectTrigger('[[api')).toEqual({ kind: 'page', query: 'api', from: 0 });
  });

  it('does NOT trigger on a single bracket', () => {
    expect(detectTrigger('[api')).toBeNull();
  });

  it('does NOT trigger on [[ with no character yet', () => {
    expect(detectTrigger('[[')).toBeNull();
  });

  it('does NOT trigger on [[ inside a word', () => {
    expect(detectTrigger('word[[api')).toBeNull();
  });

  it('stops the wikilink trigger once ] is typed', () => {
    expect(detectTrigger('[[api]')).toBeNull();
  });

  it('prefers the wikilink trigger when both [[ and @ are present', () => {
    // `[[` after the `@` — the cursor is inside the wikilink.
    expect(detectTrigger('@user [[pa')).toEqual({ kind: 'page', query: 'pa', from: 6 });
  });
});

describe('isSuppressedContext', () => {
  const makeState = (doc: string) => EditorState.create({ doc, extensions: [markdown()] });

  const posInside = (doc: string, marker: string) => doc.indexOf(marker) + marker.length;

  it('suppresses inside an inline code span', () => {
    const doc = 'text `code@here` more';
    const state = makeState(doc);
    ensureSyntaxTree(state, doc.length);
    expect(isSuppressedContext(state, posInside(doc, '`code@h'))).toBe(true);
  });

  it('suppresses inside a fenced code block', () => {
    const doc = '```\n@mention here\n```';
    const state = makeState(doc);
    ensureSyntaxTree(state, doc.length);
    expect(isSuppressedContext(state, posInside(doc, '@menti'))).toBe(true);
  });

  it('does not suppress in plain paragraph text', () => {
    const doc = 'just a normal @paragraph';
    const state = makeState(doc);
    ensureSyntaxTree(state, doc.length);
    expect(isSuppressedContext(state, doc.length)).toBe(false);
  });

  it('suppresses inside a link', () => {
    const doc = '[label @x](http://example.com)';
    const state = makeState(doc);
    ensureSyntaxTree(state, doc.length);
    expect(isSuppressedContext(state, posInside(doc, '[label @'))).toBe(true);
  });
});

describe('isMobileWidth', () => {
  const realInnerWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: realInnerWidth, configurable: true });
    vi.restoreAllMocks();
  });

  it('returns true below 768px', () => {
    Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true });
    expect(isMobileWidth()).toBe(true);
  });

  it('returns false at or above 768px', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    expect(isMobileWidth()).toBe(false);
  });
});
