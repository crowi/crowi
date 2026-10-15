/**
 * Corpus for the relaxed-policy style filter (spec R-2a). CSS input uses
 * `String.raw` so backslashes reach css-tree and style-to-js byte for byte.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import styleToJs from 'style-to-js';

import { sanitizeRelaxedStyle } from './relaxed-html-style';

const keep = (input: string): string => {
  const out = sanitizeRelaxedStyle(input);
  assert.notEqual(out, undefined, `expected to keep: ${input}`);
  return out as string;
};

describe('sanitizeRelaxedStyle', () => {
  describe('ordinary declarations are kept', () => {
    it('keeps color / margin / display:flex / quoted font-family exactly', () => {
      assert.equal(keep('color:red'), 'color:red');
      assert.equal(keep('margin:1px 2px'), 'margin:1px 2px');
      assert.equal(keep('display:flex'), 'display:flex');
      assert.equal(keep('font-family:"Hiragino Sans"'), 'font-family:"Hiragino Sans"');
    });

    it('keeps layout and overlay declarations (no property allow-list)', () => {
      assert.equal(keep('position:absolute;z-index:9;top:0'), 'position:absolute;z-index:9;top:0');
      assert.equal(keep('display:grid;grid-template-columns:1fr 2fr'), 'display:grid;grid-template-columns:1fr 2fr');
    });

    it('keeps gradients that reference no resource', () => {
      assert.equal(keep('background:linear-gradient(red, blue)'), 'background:linear-gradient(red,blue)');
    });

    it('keeps vendor-prefixed properties and !important', () => {
      assert.equal(keep('-webkit-transform:rotate(1deg);-ms-transform:none'), '-webkit-transform:rotate(1deg);-ms-transform:none');
      assert.equal(keep('color:red !important'), 'color:red!important');
    });

    it('normalises property case and drops comments and empty declarations', () => {
      assert.equal(keep('COLOR:Red'), 'color:Red');
      assert.equal(keep('color:/*c*/red;;;'), 'color:red');
    });
  });

  describe('resource references and variables are dropped per declaration', () => {
    it('drops url() backgrounds of every scheme, keeping neighbours', () => {
      assert.equal(keep('color:red;background:url(https://evil/x)'), 'color:red');
      assert.equal(keep('color:red;background-image:url("data:image/png;base64,AAAA")'), 'color:red');
      assert.equal(sanitizeRelaxedStyle('background:url(x)'), undefined);
    });

    it('drops an escaped url name and an upper-case URL', () => {
      assert.equal(sanitizeRelaxedStyle(String.raw`background:\75rl(x)`), undefined);
      assert.equal(sanitizeRelaxedStyle('background:URL(x)'), undefined);
      assert.equal(sanitizeRelaxedStyle('background:u\\72l(x)'), undefined);
    });

    it('drops every forbidden function, nested or not', () => {
      for (const fn of ['image-set', '-webkit-image-set', 'image', 'cross-fade', 'element', 'paint', 'var', 'env', 'attr', 'src', 'expression']) {
        assert.equal(sanitizeRelaxedStyle(`background:${fn}(a)`), undefined, fn);
        assert.equal(sanitizeRelaxedStyle(`color:red;background:linear-gradient(red, ${fn.toUpperCase()}(a))`), 'color:red', fn);
      }
    });

    it('drops image-set with a string and custom properties, including a variable use', () => {
      assert.equal(sanitizeRelaxedStyle('background-image:image-set("https://evil/x" 1x)'), undefined);
      assert.equal(sanitizeRelaxedStyle('--img:"data:image/svg+xml,x"'), undefined);
      assert.equal(sanitizeRelaxedStyle('--img:"data:image/svg+xml,x";background-image:image-set(var(--img) 1x)'), undefined);
      // The parent defines the variable in another call; the use site is dropped on its own.
      assert.equal(sanitizeRelaxedStyle('background-image:var(--img)'), undefined);
      assert.equal(keep('color:red;width:var(--w)'), 'color:red');
    });

    it('drops behavior and -moz-binding', () => {
      assert.equal(keep('color:red;behavior:url(x.htc)'), 'color:red');
      assert.equal(keep('color:red;-moz-binding:foo'), 'color:red');
    });

    it('drops at-rules and unparseable fragments', () => {
      assert.equal(keep('color:red;@import "x.css"'), 'color:red');
      assert.equal(sanitizeRelaxedStyle('@media print{a{color:red}}'), undefined);
      assert.equal(sanitizeRelaxedStyle('{'), undefined);
    });
  });

  describe('parser disagreement removes the whole attribute', () => {
    it('rejects the two known css-tree / style-to-js divergences', () => {
      assert.equal(sanitizeRelaxedStyle(String.raw`content:"a\\";x:"; background-image: url(https://evil/x); z:"`), undefined);
      assert.equal(sanitizeRelaxedStyle(String.raw`a\;b:1`), undefined);
    });

    it('rejects duplicate and camelCase-colliding properties and empty values', () => {
      assert.equal(sanitizeRelaxedStyle('color:red;color:blue'), undefined);
      assert.equal(sanitizeRelaxedStyle('color:red;COLOR:blue'), undefined);
      assert.equal(sanitizeRelaxedStyle('x:'), undefined);
      assert.equal(sanitizeRelaxedStyle('color:'), undefined);
    });

    it('rejects an unsafe property identifier', () => {
      assert.equal(sanitizeRelaxedStyle(String.raw`a\3b b:1`), undefined);
      assert.equal(sanitizeRelaxedStyle(String.raw`a\;b:1;color:red`), undefined);
    });

    it('handles escapes in strings and identifiers without letting a second declaration through', () => {
      for (const input of [
        String.raw`font-family:"a\"b";color:red`,
        String.raw`font-family:"a\\"`,
        String.raw`content:"x\3b y";color:red`,
        String.raw`content:"x\A y"`,
        'color:red\\',
        'content:"/*";color:red;content2:"*/"',
        String.raw`content:"a\;b:1"`,
      ]) {
        const out = sanitizeRelaxedStyle(input);
        if (out === undefined) continue;
        // Whatever survives must read back to exactly the declarations kept.
        const parsed = styleToJs(out, { reactCompat: true });
        assert.ok(!('backgroundImage' in parsed), input);
        assert.equal(sanitizeRelaxedStyle(out), out, `idempotent: ${input}`);
      }
    });

    it('every kept output re-reads to one entry per declaration', () => {
      const out = keep('color:red;margin:1px 2px;font-family:"Hiragino Sans";-webkit-transform:none');
      assert.deepEqual(styleToJs(out, { reactCompat: true }), {
        color: 'red',
        margin: '1px 2px',
        fontFamily: '"Hiragino Sans"',
        WebkitTransform: 'none',
      });
    });
  });

  describe('input handling', () => {
    it('returns undefined for non-strings and empty input', () => {
      for (const value of [undefined, null, 1, true, {}, [], '', '   ']) assert.equal(sanitizeRelaxedStyle(value), undefined);
    });

    it('copes with a very large style without throwing', () => {
      const big = `color:red;${'margin:1px;'.repeat(2)}${'a'.repeat(200_000)}:1`;
      const out = sanitizeRelaxedStyle(big);
      assert.ok(out === undefined || typeof out === 'string');
    });
  });
});
