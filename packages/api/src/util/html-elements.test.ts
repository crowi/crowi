import { KNOWN_HTML_ELEMENTS, containsKnownHtmlTag, stripKnownHtmlTags } from './html-elements';

describe('util/html-elements', () => {
  describe('KNOWN_HTML_ELEMENTS', () => {
    it('includes the 5 deprecated presentational elements', () => {
      for (const el of ['font', 'center', 'marquee', 'blink', 'applet']) {
        expect(KNOWN_HTML_ELEMENTS.has(el)).toBe(true);
      }
    });

    it('includes the always-known structural elements', () => {
      for (const el of ['section', 'div', 'br', 'img', 'span', 'h1', 'h6']) {
        expect(KNOWN_HTML_ELEMENTS.has(el)).toBe(true);
      }
    });
  });

  describe('stripKnownHtmlTags', () => {
    it('strips an open + close tag pair, leaving inner text', () => {
      expect(stripKnownHtmlTags('<font color="x">A</font>')).toBe('A');
    });

    it('strips a self-closing tag', () => {
      expect(stripKnownHtmlTags('a<br/>b')).toBe('ab');
    });

    it('strips a void open tag', () => {
      expect(stripKnownHtmlTags('a<br>b')).toBe('ab');
    });

    it('is case-insensitive', () => {
      expect(stripKnownHtmlTags('<FONT>x</FONT>')).toBe('x');
    });

    it('leaves an unknown tag-like token intact', () => {
      expect(stripKnownHtmlTags('Using List<int> in C#')).toBe('Using List<int> in C#');
    });

    it('does not strip a longer name that merely starts with an element name', () => {
      expect(stripKnownHtmlTags('<fontain>')).toBe('<fontain>');
    });

    it('leaves a bare angle bracket in text intact', () => {
      expect(stripKnownHtmlTags('price < 100')).toBe('price < 100');
      expect(stripKnownHtmlTags('if x < 10')).toBe('if x < 10');
    });

    it('strips multiple known tags in one string', () => {
      expect(stripKnownHtmlTags('Plain <b>bold</b> <i>tail</i>')).toBe('Plain bold tail');
    });
  });

  describe('containsKnownHtmlTag', () => {
    it('is true when a known tag is present', () => {
      expect(containsKnownHtmlTag('<font color="x">A</font>')).toBe(true);
      expect(containsKnownHtmlTag('a<br>b')).toBe(true);
      expect(containsKnownHtmlTag('<FONT>x</FONT>')).toBe(true);
    });

    it('is false for a bare angle bracket', () => {
      expect(containsKnownHtmlTag('price < 100')).toBe(false);
      expect(containsKnownHtmlTag('if x < 10')).toBe(false);
    });

    it('is false for an unknown tag-like token', () => {
      expect(containsKnownHtmlTag('Using List<int> in C#')).toBe(false);
      expect(containsKnownHtmlTag('<fontain>')).toBe(false);
    });

    it('is false for plain text', () => {
      expect(containsKnownHtmlTag('just a heading')).toBe(false);
    });
  });
});
