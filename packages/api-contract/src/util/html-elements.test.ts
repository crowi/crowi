/**
 * Unit test for the shared HTML-tag strip helpers. Run with `node --test`
 * (built-in runner) — no jest dep, the assertions are pure-data — matching the
 * sibling `src/contracts/admin/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KNOWN_HTML_ELEMENTS, STRIP_KNOWN_HTML_TAGS_MAX_LENGTH, stripKnownHtmlTags } from './html-elements';

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

    // D1 — hyphenated custom elements whose prefix is a known tag must be kept,
    // matching the body renderer (`known-tags.ts`: any `-` tag is a custom).
    it('does NOT strip a hyphenated custom element whose prefix is a known tag', () => {
      assert.equal(stripKnownHtmlTags('<code-sample>X</code-sample>'), '<code-sample>X</code-sample>');
      assert.equal(stripKnownHtmlTags('<data-foo>Y</data-foo>'), '<data-foo>Y</data-foo>');
    });

    // D4 — a `>` inside a quoted attribute value must not end the tag early.
    it('tolerates `>` inside a quoted attribute value (double quotes)', () => {
      assert.equal(stripKnownHtmlTags('<a title="a > b">X</a>'), 'X');
    });

    it('tolerates `>` inside a quoted attribute value (single quotes)', () => {
      assert.equal(stripKnownHtmlTags("<a title='a > b'>X</a>"), 'X');
    });

    // B — the ReDoS guard. A long unterminated `<i<i<i…` run made the old
    // `[^>]*` attribute scan backtrack O(n^2) (~31s at 200k). The length cap
    // returns oversized input unchanged WITHOUT running the regex.
    it('returns an oversized adversarial input promptly and unchanged (ReDoS guard)', () => {
      const adversarial = '<i'.repeat(25_000); // ~50k chars, no closing `>`
      assert.equal(adversarial.length > STRIP_KNOWN_HTML_TAGS_MAX_LENGTH, true);
      const start = Date.now();
      const out = stripKnownHtmlTags(adversarial);
      const elapsedMs = Date.now() - start;
      assert.equal(out, adversarial, 'oversized input is returned unchanged');
      assert.equal(elapsedMs < 1000, true, `expected fast return, took ${elapsedMs}ms`);
    });

    it('still strips a normal-length string that contains a quoted `>` near the cap boundary', () => {
      // A legitimately long-but-bounded heading still strips correctly.
      const label = `${'word '.repeat(100)}<b>bold</b>`;
      assert.equal(label.length < STRIP_KNOWN_HTML_TAGS_MAX_LENGTH, true);
      assert.equal(stripKnownHtmlTags(label), `${'word '.repeat(100)}bold`);
    });
  });
});
