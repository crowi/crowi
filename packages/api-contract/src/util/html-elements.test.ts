/**
 * Unit test for the shared HTML-tag strip helpers. Run with `node --test`
 * (built-in runner) — no jest dep, the assertions are pure-data — matching the
 * sibling `src/contracts/admin/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KNOWN_HTML_ELEMENTS, STRIP_KNOWN_HTML_TAGS_MAX_LENGTH, stripKnownHtmlTags } from './html-elements';

/**
 * The web body renderer's INLINE HTML allow-list (the lower-case `HTML_TAGS`
 * array in `packages/web/src/components/editor/known-tags.ts`, excluding the
 * camelCase SVG tags). The body renders each of these as a real element, so a
 * TOC label MUST strip them to match the body text. This is duplicated here on
 * purpose: `@crowi/api-contract` is the lower layer and cannot import from
 * `@crowi/web`, so the cross-guard below pins the strip set as a SUPERSET of
 * this list. If `known-tags.ts` gains an inline HTML tag, update both lists in
 * lockstep — this test fails until the strip set covers it.
 */
const WEB_BODY_INLINE_HTML_TAGS = [
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'param',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'svg',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
  // Obsolete but still browser-recognised (rendered, not stripped, by the body).
  'acronym',
  'big',
  'center',
  'dir',
  'font',
  'frame',
  'frameset',
  'marquee',
  'menuitem',
  'nobr',
  'noembed',
  'noframes',
  'rb',
  'rtc',
  'strike',
  'tt',
  'xmp',
  'listing',
  'basefont',
];

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

    it('includes the inline presentational tags the body renderer keeps (strike/tt/big/acronym/nobr/search)', () => {
      for (const el of ['strike', 'tt', 'big', 'acronym', 'nobr', 'search']) {
        assert.equal(KNOWN_HTML_ELEMENTS.has(el), true, `expected ${el} to be a known element`);
      }
    });

    // Cross-guard: the strip set must be a SUPERSET of the body renderer's
    // inline HTML allow-list so a `### <strike>X</strike>` strips in the TOC
    // exactly as the body renders it (TOC label == body text). Catches drift if
    // the web list gains an inline tag this set misses.
    it('covers the entire web body inline HTML allow-list (TOC label == body text)', () => {
      const missing = WEB_BODY_INLINE_HTML_TAGS.filter((tag) => !KNOWN_HTML_ELEMENTS.has(tag));
      assert.deepEqual(missing, [], `strip set is missing body-rendered inline tags: ${missing.join(', ')}`);
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

    it('strips the newly-added inline presentational tags', () => {
      assert.equal(stripKnownHtmlTags('<strike>X</strike>'), 'X');
      assert.equal(stripKnownHtmlTags('<tt>code</tt>'), 'code');
      assert.equal(stripKnownHtmlTags('<big>large</big>'), 'large');
      assert.equal(stripKnownHtmlTags('<acronym title="x">A</acronym>'), 'A');
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
