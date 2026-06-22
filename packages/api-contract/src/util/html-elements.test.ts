/**
 * Unit test for the shared HTML-tag strip helpers. Run with `node --test`
 * (built-in runner) — no jest dep, the assertions are pure-data — matching the
 * sibling `src/contracts/admin/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KNOWN_HTML_ELEMENTS, stripKnownHtmlTags } from './html-elements';

describe('util/html-elements', () => {
  describe('KNOWN_HTML_ELEMENTS', () => {
    it('includes the 5 deprecated presentational elements', () => {
      for (const el of ['font', 'center', 'marquee', 'blink', 'applet']) {
        assert.equal(KNOWN_HTML_ELEMENTS.has(el), true, `expected ${el} to be a known element`);
      }
    });

    it('includes the always-known structural elements', () => {
      for (const el of ['section', 'div', 'br', 'img', 'span', 'h1', 'h6']) {
        assert.equal(KNOWN_HTML_ELEMENTS.has(el), true, `expected ${el} to be a known element`);
      }
    });
  });

  describe('stripKnownHtmlTags', () => {
    it('strips an open + close tag pair, leaving inner text', () => {
      assert.equal(stripKnownHtmlTags('<font color="x">A</font>'), 'A');
    });

    it('strips a self-closing tag', () => {
      assert.equal(stripKnownHtmlTags('a<br/>b'), 'ab');
    });

    it('strips a void open tag', () => {
      assert.equal(stripKnownHtmlTags('a<br>b'), 'ab');
    });

    it('is case-insensitive', () => {
      assert.equal(stripKnownHtmlTags('<FONT>x</FONT>'), 'x');
    });

    it('leaves an unknown tag-like token intact', () => {
      assert.equal(stripKnownHtmlTags('Using List<int> in C#'), 'Using List<int> in C#');
    });

    it('does not strip a longer name that merely starts with an element name', () => {
      assert.equal(stripKnownHtmlTags('<fontain>'), '<fontain>');
    });

    it('leaves a bare angle bracket in text intact', () => {
      assert.equal(stripKnownHtmlTags('price < 100'), 'price < 100');
      assert.equal(stripKnownHtmlTags('if x < 10'), 'if x < 10');
    });

    it('strips multiple known tags in one string', () => {
      assert.equal(stripKnownHtmlTags('Plain <b>bold</b> <i>tail</i>'), 'Plain bold tail');
    });
  });
});
