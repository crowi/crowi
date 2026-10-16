/**
 * Unit corpus for the Web HTML sanitizer. Run with `tsx --test` like its
 * siblings. Sanitizer imports are relative on purpose: the published subpath
 * is exercised separately (contract-subpath-exports) so type-check never
 * needs `dist`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import {
  CLOBBERING_NAMES,
  safeDecodeFragment,
  sanitizeDisplayUrl,
  sanitizeIframeSrc,
  sanitizeWebHast,
  validateImageDisplayProps,
  validateWebRenderInput,
} from './html-sanitizer';

type Node = { type: string; [key: string]: unknown };
const NONCE = 'abcdef0123456789abcdef0123456789';

const el = (tagName: string, properties: Record<string, unknown> = {}, children: Node[] = []): Node => ({ type: 'element', tagName, properties, children });
const text = (value: string): Node => ({ type: 'text', value });
const rawHtml = (value: string): Node => ({ type: 'raw', value });
const gen = (value: string): Node => ({ type: 'raw', value, data: { g: 1 } });
const root = (...children: Node[]): Node => ({ type: 'root', children });

function run(tree: Node, nonce = NONCE) {
  return sanitizeWebHast(tree as never, { policy: 'strict', slotNonce: nonce });
}

const VOID = new Set(['br', 'col', 'hr', 'img', 'input', 'wbr']);

function ser(node: Node): string {
  if (node.type === 'text') return String(node.value);
  const kids = ((node.children as Node[] | undefined) ?? []).map(ser).join('');
  if (node.type === 'root') return kids;
  const props = (node.properties as Record<string, unknown>) ?? {};
  const attrs = Object.keys(props)
    .sort()
    .map((k) => {
      const v = props[k];
      if (v === true) return ` ${k}`;
      return ` ${k}="${Array.isArray(v) ? v.join(' ') : String(v)}"`;
    })
    .join('');
  if (VOID.has(String(node.tagName))) return `<${String(node.tagName)}${attrs}>`;
  return `<${String(node.tagName)}${attrs}>${kids}</${String(node.tagName)}>`;
}

function out(...children: Node[]): string {
  const result = run(root(...children));
  assert.equal(result.failure, undefined, `unexpected failure ${String(result.failure)}`);
  return ser(result.tree as never);
}

function find(node: Node, tagName: string): Node[] {
  const found: Node[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if (n.type === 'element' && n.tagName === tagName) found.push(n);
    for (const c of ((n.children as Node[] | undefined) ?? []).slice().reverse()) stack.push(c);
  }
  return found;
}

describe('strict HTML policy', () => {
  describe('strict-corpus', () => {
    it('removes script/style/iframe content and drops event, style and class attributes', () => {
      const html = out(el('p', {}, [text('a'), rawHtml('<script>alert(1)</script>'), rawHtml('<b class="x" style="color:red" onclick="x()">b</b>')]));
      assert.equal(html, '<p>a<b>b</b></p>');
      assert.equal(out(rawHtml('<style>body{display:none}</style><div>ok</div>')), '<div>ok</div>');
      assert.equal(out(rawHtml('<iframe src="https://evil.example/"></iframe><p>x</p>')), '<p>x</p>');
    });

    it('drops srcdoc, is, data-* and aria/role/tabindex written by an author', () => {
      const html = out(rawHtml('<div is="x-y" data-crowi-alert-variant="note" role="button" aria-label="L" tabindex="0" contenteditable srcdoc="x">t</div>'));
      assert.equal(html, '<div>t</div>');
    });

    it('keeps the document allow-list: ruby/rt/rp/wbr/bdi/bdo/time', () => {
      const html = out(rawHtml('<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>a<wbr>b<bdi>x</bdi><bdo dir="rtl">y</bdo><time datetime="2026-01-02">d</time>'));
      assert.equal(html, '<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>a<wbr>b<bdi>x</bdi><bdo dir="rtl">y</bdo><time dateTime="2026-01-02">d</time>');
    });

    it('bdo requires dir ltr/rtl; time dateTime is a bounded string', () => {
      assert.equal(out(rawHtml('<bdo dir="ltr">a</bdo><bdo dir="auto">b</bdo><bdo>c</bdo>')), '<bdo dir="ltr">a</bdo>bc');
      assert.equal(out(rawHtml('<time datetime="">a</time>')), '<time>a</time>');
      assert.equal(out(rawHtml(`<time datetime="${'x'.repeat(257)}">a</time>`)), '<time>a</time>');
      assert.equal(out(rawHtml(`<time datetime="${'x'.repeat(256)}">a</time>`)), `<time dateTime="${'x'.repeat(256)}">a</time>`);
    });

    it('align is a presentational value, never a style', () => {
      assert.equal(out(rawHtml('<p align="center">x</p>')), '<p align="center">x</p>');
      assert.equal(out(rawHtml('<h1 align="justify">x</h1>')), '<h1 align="justify">x</h1>');
      assert.equal(out(rawHtml('<div align="middle">x</div>')), '<div>x</div>');
    });

    it('ol type/start/reversed and li value are validated', () => {
      assert.equal(out(rawHtml('<ol type="a" start="3" reversed><li value="2">x</li></ol>')), '<ol reversed start="3" type="a"><li value="2">x</li></ol>');
      assert.equal(out(rawHtml('<ol type="z" start="x"><li value="9999999999">x</li></ol>')), '<ol><li>x</li></ol>');
    });

    it('td/th spans and scope are validated; headers is dropped', () => {
      assert.equal(
        out(rawHtml('<table><tr><th scope="col" colspan="2" headers="a">h</th><td rowspan="0" colspan="1001" align="right">d</td></tr></table>')),
        '<table><tbody><tr><th colSpan="2" scope="col">h</th><td align="right">d</td></tr></tbody></table>',
      );
    });

    it('unwraps non-allow-listed wrappers but keeps their surviving children', () => {
      assert.equal(out(rawHtml('<object><p>fallback</p></object>')), '<p>fallback</p>');
      assert.equal(out(rawHtml('<form action="/x"><button>go</button></form>')), 'go');
      assert.equal(out(rawHtml('<template><p>t</p></template>')), '<p>t</p>');
      assert.equal(out(rawHtml('<font color="red">f</font><center>c</center>')), 'fc');
      assert.equal(out(rawHtml('<svg><title>t</title><script>x()</script><g><text>s</text></g></svg>')), 's');
    });

    it('removes an author input but keeps the label text', () => {
      assert.equal(out(rawHtml('<label>a<input type="checkbox" disabled checked></label>')), 'a');
    });

    it('keeps a GFM checkbox the Markdown pipeline made', () => {
      const li = el('li', { className: ['task-list-item'] }, [el('input', { type: 'checkbox', checked: true, disabled: true }), text(' done')]);
      const html = out(el('ul', { className: ['contains-task-list'] }, [li]));
      assert.equal(html, '<ul className="contains-task-list"><li className="task-list-item"><input checked disabled type="checkbox"> done</li></ul>');
    });

    it('does not grant owner properties to the same class written by an author', () => {
      assert.equal(out(rawHtml('<ul class="contains-task-list"><li class="task-list-item">x</li></ul>')), '<ul><li>x</li></ul>');
      assert.equal(out(rawHtml('<span role="img" aria-label="x">e</span>')), '<span>e</span>');
      assert.equal(out(rawHtml('<section data-section-id="x"><h2 id="x">h</h2></section>')), '<section><h2 id="x">h</h2></section>');
      assert.equal(out(rawHtml('<figure class="crowi-figure" data-crowi-image-align="center">f</figure>')), '<figure>f</figure>');
      assert.equal(out(rawHtml('<a class="mention" href="/u">@u</a>')), '<a href="/u">@u</a>');
    });

    it('restores owner properties on structure Markdown made, including source lines', () => {
      const html = out(
        el('aside', { 'data-crowi-alert-variant': 'tip', 'data-source-line': '3' }, [el('p', {}, [text('hi')])]),
        el('dl', { className: ['crowi-frontmatter'], 'data-source-line': 7 }, [el('dt', {}, [text('k')]), el('dd', {}, [text('v')])]),
        el('span', { role: 'img', ariaLabel: 'smile' }, [text('😀')]),
        el('code', { className: ['language-ts'] }, [text('x')]),
      );
      assert.equal(
        html,
        '<aside dataCrowiAlertVariant="tip" dataSourceLine="3"><p>hi</p></aside><dl className="crowi-frontmatter" dataSourceLine="7"><dt>k</dt><dd>v</dd></dl><span ariaLabel="smile" role="img">😀</span><code className="language-ts">x</code>',
      );
    });

    it('rejects an invalid source line', () => {
      assert.equal(out(el('p', { 'data-source-line': '03' }, [text('x')])), '<p>x</p>');
      assert.equal(out(el('p', { 'data-source-line': '0' }, [text('x')])), '<p>x</p>');
      assert.equal(out(el('p', { 'data-source-line': 'abc' }, [text('x')])), '<p>x</p>');
    });

    it('keeps footnote structure owned by the Markdown pipeline', () => {
      const ref = el('sup', {}, [
        el('a', { href: '#user-content-fn-1', id: 'user-content-fnref-1', dataFootnoteRef: true, ariaDescribedBy: ['footnote-label'] }, [text('1')]),
      ]);
      const section = el('section', { dataFootnotes: true, className: ['footnotes'] }, [
        el('h2', { id: 'footnote-label', className: ['sr-only'] }, [text('Footnotes')]),
        el('ol', {}, [
          el('li', { id: 'user-content-fn-1' }, [
            el('p', {}, [
              text('n '),
              el('a', { href: '#user-content-fnref-1', dataFootnoteBackref: true, ariaLabel: 'Back', className: ['data-footnote-backref'] }, [text('↩')]),
            ]),
          ]),
        ]),
      ]);
      const html = out(el('p', {}, [ref]), section);
      assert.equal(
        html,
        '<p><sup><a ariaDescribedBy="footnote-label" dataFootnoteRef="" href="#user-content-fn-1" id="user-content-fnref-1">1</a></sup></p><section className="footnotes" dataFootnotes=""><h2 className="sr-only" id="footnote-label">Footnotes</h2><ol><li id="user-content-fn-1"><p>n <a ariaLabel="Back" className="data-footnote-backref" dataFootnoteBackref="" href="#user-content-fnref-1">↩</a></p></li></ol></section>',
      );
    });

    it('unknown-leading chunks are literal text (placeholders survive)', () => {
      assert.equal(out(el('p', {}, [text('ssh '), rawHtml('<user>'), text('@'), rawHtml('<host>')])), '<p>ssh <user>@<host></p>');
      assert.equal(out(el('p', {}, [text('No '), rawHtml('<thing>'), text(' yet')])), '<p>No <thing> yet</p>');
      for (const tag of ['math', 'applet', 'plaintext']) {
        assert.equal(out(el('p', {}, [rawHtml(`<${tag}>x</${tag}>`)])), `<p><${tag}>x</${tag}></p>`);
        assert.equal(out(el('p', {}, [rawHtml(`<${tag}>x`), text(' tail')])), `<p><${tag}>x tail</p>`);
      }
    });

    it('nested unknown wrappers inside a known chunk are unwrapped', () => {
      assert.equal(out(rawHtml('<div><o:p>x</o:p><foo-bar>y</foo-bar></div>')), '<div>xy</div>');
    });

    it('image src rejection becomes alt text; allowed raster data images stay', () => {
      assert.equal(out(rawHtml('<img src="javascript:x" alt="A">')), 'A');
      assert.equal(out(rawHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="S">')), 'S');
      assert.equal(out(rawHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="P">')), '<img alt="P" src="data:image/png;base64,iVBORw0KGgo=">');
      assert.equal(
        out(rawHtml('<img src="/files/my shot.png" alt="r" width="10" height="5000" srcset="a 1x" sizes="1">')),
        '<img alt="r" src="/files/my shot.png" width="10">',
      );
    });

    it('raw-space link and image URLs are kept verbatim', () => {
      assert.equal(out(rawHtml('<a href="/Team/My Page">p</a>')), '<a href="/Team/My Page">p</a>');
    });

    it('link attributes other than href/name are removed', () => {
      assert.equal(out(rawHtml('<a href="https://x.example/" target="_blank" rel="x" download ping="https://y/">l</a>')), '<a href="https://x.example/">l</a>');
    });
  });

  describe('url-matrix', () => {
    const href = (v: unknown) => sanitizeDisplayUrl(v, 'href');
    const src = (v: unknown) => sanitizeDisplayUrl(v, 'src');

    it('href keeps ordinary schemes verbatim and rejects only javascript/vbscript/data', () => {
      for (const ok of [
        'tel:+81312345678',
        'file:///etc/hosts',
        'slack://open',
        'ftp://h/x',
        'blob:https://x/1',
        '/Team/My Page',
        '//cdn.example/x',
        '#frag',
        'https://x.example/a b',
        'mailto:a@b.c',
        '',
      ]) {
        assert.equal(href(ok), ok);
      }
      assert.equal(href('  /x  '), '/x');
      for (const bad of [
        'javascript:alert(1)',
        'JaVaScRiPt:x',
        ' java\tscript:x',
        'java\nscript:x',
        'vbscript:x',
        'data:text/html,x',
        'data:image/png;base64,AAAA',
        '\u0001javascript:x',
      ]) {
        assert.equal(href(bad), undefined, bad);
      }
      assert.equal(href(5), undefined);
      assert.equal(href(undefined), undefined);
    });

    it('href through HTML and Markdown element shapes behaves the same', () => {
      const viaHtml = (v: string) => out(rawHtml(`<a href="${v}">l</a>`));
      const viaMd = (v: string) => out(el('a', { href: v }, [text('l')]));
      for (const v of ['tel:+1', 'file:///x', 'slack://x', 'javascript:alert(1)', 'vbscript:x', 'data:text/html,x']) {
        assert.equal(viaHtml(v), viaMd(v), v);
      }
      assert.equal(viaMd('javascript:alert(1)'), '<a>l</a>');
      assert.equal(viaHtml('&#106;avascript:x'), '<a>l</a>');
      assert.equal(viaHtml('JAVASCRIPT:x'), '<a>l</a>');
      assert.equal(viaMd('tel:+1'), '<a href="tel:+1">l</a>');
    });

    it('src accepts relative/http(s)/raster data and rejects the rest', () => {
      for (const ok of [
        '/a.png',
        'a/b.png',
        './x.png',
        'https://x.example/a.png',
        'http://x.example/a.png',
        '//cdn.example/a.png',
        'data:image/png;base64,AAAA',
        'DATA:IMAGE/JPEG;BASE64,AAAA',
        'data:image/webp;base64,AA==',
      ]) {
        assert.equal(src(ok), ok, ok);
      }
      for (const bad of [
        '',
        '#x',
        'javascript:x',
        'file:///x',
        'blob:https://x/1',
        'ftp://x/y.png',
        'data:image/svg+xml;base64,AAAA',
        'data:image/png;base64,',
        'data:image/png,AAAA',
        'data:text/html;base64,AAAA',
        'https://',
      ]) {
        assert.equal(src(bad), undefined, bad);
      }
    });

    it('URL list attributes are removed', () => {
      assert.equal(out(rawHtml('<img src="/a.png" srcset="javascript:x 1x" sizes="1" usemap="#m" ismap alt="a">')), '<img alt="a" src="/a.png">');
    });

    it('Markdown image elements use the same src rule', () => {
      assert.equal(
        out(el('p', {}, [el('img', { src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'p' })])),
        '<p><img alt="p" src="data:image/png;base64,iVBORw0KGgo="></p>',
      );
      assert.equal(out(el('p', {}, [el('img', { src: 'data:image/svg+xml;base64,AAAA', alt: 'svg' })])), '<p>svg</p>');
    });
  });

  describe('code-content-direct-input', () => {
    it('removes a closed code-content region inside one chunk and keeps text around it', () => {
      for (const tag of ['script', 'style', 'iframe', 'noembed', 'noframes', 'noscript', 'xmp', 'textarea', 'title']) {
        assert.equal(out(rawHtml(`<div>a<${tag}>x</${tag}>b</div>`)), '<div>ab</div>', tag);
      }
      assert.equal(out(rawHtml('<div>a<plaintext>x</plaintext>b</div>')), '<div>ab</div>');
    });

    it('is case-insensitive and tolerates attributes and close-tag whitespace', () => {
      assert.equal(out(rawHtml('<div>a<SCRIPT type="x">1</ScRiPt >b</div>')), '<div>ab</div>');
    });

    it('does not treat look-alike closers as closed', () => {
      for (const closer of ['</scriptx>', '&lt;/script>', '</script']) {
        const html = out(el('p', {}, [rawHtml('<div>a<script>x' + closer + 'b'), text(' tail')]));
        assert.ok(html.includes('<script>'), `${closer} -> ${html}`);
        assert.ok(html.includes('tail'), `${closer} -> ${html}`);
      }
    });

    it('a closer inside quotes/comments before the start is not a closer; one after it is raw-text', () => {
      assert.equal(out(rawHtml('<div title="</script>">a<script>if(a<"</b>")x</script>b</div>')), '<div title="</script>">ab</div>');
      assert.equal(out(rawHtml('<!-- <script> --><div>a</div>')), '<div>a</div>');
    });

    it('an unclosed start token is literal text and the following content survives', () => {
      const html = out(rawHtml('<div>a<script>b</div>'));
      assert.equal(html, '<div>a<script>b</div>');
    });

    it('a closer in a different raw chunk does not close', () => {
      const html = out(
        el('p', {}, [rawHtml('<div>a<title>')]),
        el('h2', { id: 'h' }, [text('Heading')]),
        el('pre', {}, [el('code', {}, [text('code')])]),
        el('p', {}, [rawHtml('</title>')]),
      );
      assert.ok(html.includes('<title>'));
      assert.ok(html.includes('<h2 id="h">Heading</h2>'));
      assert.ok(html.includes('<code>code</code>'));
    });

    it('a start token split across chunks is unclosed', () => {
      const html = out(el('p', {}, [rawHtml('<div><scr'), rawHtml('ipt>x</script>'), text('after')]));
      assert.ok(html.includes('after'));
    });

    it('plaintext leading chunk is inert text, closed or not', () => {
      assert.equal(out(rawHtml('<plaintext>x</plaintext>')), '<plaintext>x</plaintext>');
      assert.equal(out(rawHtml('<plaintext>x'), el('p', {}, [text('next')])), '<plaintext>x<p>next</p>');
    });

    it('does not search closers inside a leading-unknown chunk', () => {
      assert.equal(out(rawHtml('<applet><script>x</script>')), '<applet><script>x</script>');
    });
  });

  describe('context-boundaries', () => {
    it('split open/close raw chunks around Markdown elements keep the wrapper', () => {
      const html = out(el('p', {}, [rawHtml('<em>'), el('strong', {}, [text('b')]), rawHtml('</em>')]));
      assert.equal(html, '<p><em><strong>b</strong></em></p>');
    });

    it('an unfinished tag/attribute/comment before a fenced code block is shown as text and the code survives', () => {
      for (const unfinished of ['<div title="note', '<!--', '<div', '</div', '<a href=x']) {
        const result = run(root(rawHtml(unfinished), gen('<pre class="shiki">CODE</pre>'), rawHtml('<p>after</p>')));
        assert.equal(result.failure, undefined, unfinished);
        const html = ser(result.tree as never);
        assert.ok(html.includes('CODE'), `${unfinished} -> ${html}`);
        assert.ok(html.includes('<p>after</p>'), `${unfinished} -> ${html}`);
        assert.ok(html.includes(unfinished), `${unfinished} -> ${html}`);
        assert.ok(!html.includes('\u0000'));
      }
    });

    it('DOCTYPE/CDATA/bogus-comment/charref leftovers do not swallow later raw', () => {
      for (const unfinished of ['<div>\n<?php echo $x', '<!DOCTYPE html', '<![CDATA[ x', '<!x', '</ x', 'Q&A']) {
        const html = out(el('aside', {}, [rawHtml(unfinished), gen('<pre class="shiki">CODE</pre>'), rawHtml('<p>after</p>')]));
        assert.ok(html.includes('CODE'), `${unfinished} -> ${html}`);
        assert.ok(html.includes('<p>after</p>'), `${unfinished} -> ${html}`);
      }
    });

    it('does not leave synthetic reset newlines in the output', () => {
      const result = run(root(el('p', {}, [text('a')]), rawHtml('<div>x</div>'), el('p', {}, [text('b')]), gen('<span>g</span>')));
      assert.equal(ser(result.tree as never), '<p>a</p><div>x</div><p>b</p><span>g</span>');
    });

    it('a leading <col> is shown as text and later structure is preserved', () => {
      const html = out(rawHtml('<col>'), el('h2', { id: 'b' }, [text('B')]), gen('<pre>CODE</pre>'), el('p', {}, [text('Z')]));
      assert.equal(html, '<col><h2 id="b">B</h2><pre>CODE</pre><p>Z</p>');
    });

    it('a <col> after another element is parsed normally', () => {
      const html = out(el('p', {}, [text('x')]), rawHtml('<table><colgroup><col span="2"></colgroup><tr><td>c</td></tr></table>'));
      assert.ok(html.includes('<col span="2">'));
    });

    it('forged carriers earn nothing', () => {
      const fake = rawHtml(
        `<span data-crowi-generated-slot="${'0'.repeat(32)}:0">x</span><span data-crowi-generated-slot="other:0">y</span><span data-crowi-generated-slot="${NONCE}:7">w</span>`,
      );
      const html = out(fake, gen('<pre>REAL</pre>'));
      assert.equal(html, '<span>x</span><span>y</span><span>w</span><pre>REAL</pre>');
      const unissued = out(rawHtml(`<span data-crowi-generated-slot="${NONCE}:5">z</span>`));
      assert.equal(unissued, '<span>z</span>');
      assert.ok(!JSON.stringify(run(root(fake)).tree).includes(NONCE));
    });

    it('a slot is not reachable from author HTML even with the right nonce shape but another call', () => {
      const first = run(root(gen('<pre>ONE</pre>')), NONCE);
      assert.equal(ser(first.tree as never), '<pre>ONE</pre>');
      const forged = run(root(rawHtml(`<span data-crowi-generated-slot="${NONCE}:0"></span>`)), NONCE);
      assert.equal(ser(forged.tree as never), '<span></span>');
    });

    it('table foster parenting keeps source order: A, X, CODE, Y, B, Z', () => {
      const html = out(
        el('h2', { id: 'a' }, [text('A')]),
        rawHtml('<table>'),
        el('p', {}, [text('X')]),
        gen('<pre>CODE</pre>'),
        el('p', {}, [text('Y')]),
        el('h2', { id: 'b' }, [text('B')]),
        el('p', {}, [text('Z')]),
      );
      const order = ['A', 'X', 'CODE', 'Y', 'B', 'Z'].map((s) => html.indexOf(s));
      assert.deepEqual(
        order.slice().sort((x, y) => x - y),
        order,
        html,
      );
      assert.ok(order.every((n) => n >= 0));
      assert.ok(html.includes('<h2 id="b">B</h2>'));
    });

    it('a generated block inside a paragraph splits it', () => {
      const html = out(el('p', {}, [text('a '), gen('<pre>CODE</pre>'), text(' b')]));
      assert.equal(html, '<p>a </p><pre>CODE</pre><p> b</p>');
    });

    it('a generated block inside em/strong/p splits every phrasing ancestor', () => {
      const html = out(el('p', {}, [el('em', {}, [text('a'), gen('<div>BLK</div>'), text('b')])]));
      assert.equal(html, '<p><em>a</em></p><div>BLK</div><p><em>b</em></p>');
    });

    it('a generated inline fragment stays in place', () => {
      const html = out(el('p', {}, [text('see '), gen('<span class="katex">x</span>'), text(' now')]));
      assert.equal(html, '<p>see <span className="katex">x</span> now</p>');
    });

    it('a generated block inside a flow container is not split', () => {
      const html = out(rawHtml('<article>'), gen('<pre>CODE</pre>'), rawHtml('</article>'));
      assert.equal(html, '<article><pre>CODE</pre></article>');
    });

    it('a generated block between raw article/dl>dd text keeps order', () => {
      const html = out(rawHtml('<article>before'), gen('<div>CARD</div>'), rawHtml('after</article>'));
      assert.equal(html, '<article>before<div>CARD</div>after</article>');
      const dl = out(rawHtml('<dl><dt>t</dt><dd>pre '), gen('<div>CARD</div>'), rawHtml(' post</dd></dl>'));
      assert.equal(dl, '<dl><dt>t</dt><dd>pre <div>CARD</div> post</dd></dl>');
    });

    it('a generated block inside a heading moves out and keeps id/source line on the first surviving clone', () => {
      const heading = el('h2', { id: 'setup', 'data-source-line': 4 }, [gen('<div class="crowi-link-card">CARD</div>'), text(' Setup')]);
      const html = out(heading);
      assert.equal(html, '<div className="crowi-link-card">CARD</div><h2 dataSourceLine="4" id="setup"> Setup</h2>');
    });

    it('a heading that is only a card keeps one empty id-bearing heading', () => {
      const html = out(el('h2', { id: 'only' }, [gen('<div>CARD</div>')]));
      assert.equal(html, '<h2 id="only"></h2><div>CARD</div>');
    });

    it('a generated link fragment splits an outer anchor', () => {
      const html = out(el('p', {}, [el('a', { href: 'https://outer.example/' }, [text('o '), gen('<a href="https://inner.example/">in</a>'), text(' p')])]));
      assert.equal(html, '<p><a href="https://outer.example/">o </a><a href="https://inner.example/">in</a><a href="https://outer.example/"> p</a></p>');
    });

    it('generated fragments keep producer style/class and are not filtered as author HTML', () => {
      const html = out(gen('<span class="katex" style="color:red" data-x="1" onclick="x">k</span>'));
      assert.ok(html.includes('style="color:red"'));
      assert.ok(html.includes('className="katex"'));
    });

    it('closed code-content in author raw removes the region; nothing is rescued from it', () => {
      const html = out(rawHtml('<div>a<script>x</script>b</div>'), gen('<pre>CODE</pre>'));
      assert.equal(html, '<div>ab</div><pre>CODE</pre>');
    });
  });

  describe('select-insertion-mode', () => {
    it('an unclosed select shows its start tag and keeps later structure', () => {
      const html = out(rawHtml('<select>'), el('section', {}, [el('h2', { id: 'b' }, [text('B')])]), gen('<pre>CODE</pre>'), el('p', {}, [text('Z')]));
      assert.ok(html.startsWith('<select>'), html);
      assert.ok(html.includes('<h2 id="b">B</h2>'));
      assert.ok(html.includes('<pre>CODE</pre>'));
      assert.ok(html.endsWith('<p>Z</p>'));
    });

    it('a closed select keeps text only', () => {
      const html = out(
        rawHtml('<select>'),
        el('h2', { id: 'in' }, [text('B')]),
        gen('<pre>CODE</pre>'),
        rawHtml('</select>'),
        el('h2', { id: 'out' }, [text('C')]),
        gen('<pre>AFTER</pre>'),
      );
      assert.ok(!html.includes('id="in"'), html);
      assert.ok(!html.includes('CODE'), html);
      assert.ok(html.includes('B'), html);
      assert.ok(html.includes('<h2 id="out">C</h2>'));
      assert.ok(html.includes('<pre>AFTER</pre>'));
      assert.ok(!html.includes('<select'));
    });

    it('select inside one raw chunk, closed or not, respects its end tag', () => {
      assert.equal(out(rawHtml('<div><select><option>a</option><option>b</option></select>x</div>')), '<div>abx</div>');
      assert.ok(out(rawHtml('<div><select>'), el('p', {}, [text('P')])).includes('<p>P</p>'));
      assert.ok(out(rawHtml('<div><SELECT/>'), el('p', {}, [text('P')])).includes('<p>P</p>'));
    });

    it('a fake end tag inside an attribute or comment does not close a select', () => {
      const html = out(rawHtml('<select>'), rawHtml('<!-- </select> -->'), rawHtml('<div title="</select>">x</div>'), el('p', {}, [text('P')]));
      assert.ok(html.includes('<p>P</p>'), html);
      assert.ok(html.includes('<select>'), html);
    });

    it('stand-alone option/optgroup/datalist/frameset do not swallow later structure', () => {
      for (const start of ['<option>', '<optgroup>', '<datalist>', '<frameset>']) {
        const html = out(rawHtml(start), el('section', {}, [el('h2', { id: 'b' }, [text('B')])]), gen('<pre>CODE</pre>'), el('p', {}, [text('Z')]));
        assert.ok(html.includes('<h2 id="b">B</h2>'), `${start} -> ${html}`);
        assert.ok(html.includes('CODE'), `${start} -> ${html}`);
        assert.ok(html.includes('<p>Z</p>'), `${start} -> ${html}`);
      }
    });

    it('document-mode skeleton input is rejected', () => {
      assert.equal(run(root({ type: 'doctype' }, el('p', {}, [text('x')]))).failure, 'invalid-input');
      assert.equal(run(root(el('html', {}, [el('body', {}, [])]))).failure, 'invalid-input');
      assert.equal(run(root(rawHtml('<!doctype html><html><body><p>x</p></body></html>'))).failure, undefined);
    });
  });

  describe('clobbering-names', () => {
    it('drops clobbering names and the app-owned ids but keeps unrelated ones', () => {
      const html = out(
        rawHtml(
          '<span id="location">a</span><span id="rename-new-path">b</span><a name="cookie">c</a><span id="comments-heading">d</span><span id="backlinks-heading">e</span><span id="faq">f</span><a name="anchor-1">g</a>',
        ),
      );
      assert.equal(html, '<span>a</span><span>b</span><a>c</a><span>d</span><span>e</span><span id="faq">f</span><a name="anchor-1">g</a>');
      assert.ok(CLOBBERING_NAMES.has('constructor') && CLOBBERING_NAMES.has('__proto__'));
      assert.ok(!CLOBBERING_NAMES.has('faq'));
    });

    it('applies the size/emptiness bounds', () => {
      assert.equal(
        out(rawHtml(`<span id="${'a'.repeat(256)}">1</span><span id="${'a'.repeat(257)}">2</span><span id="">3</span>`)),
        `<span id="${'a'.repeat(256)}">1</span><span>2</span><span>3</span>`,
      );
      assert.equal(out(rawHtml(`<span id="${'あ'.repeat(86)}">x</span>`)), '<span>x</span>');
    });

    it('keeps only the first of duplicate author values; id and name share one space', () => {
      assert.equal(
        out(rawHtml('<span id="d">1</span><span id="d">2</span><a name="d">3</a><span id="e" ></span>')),
        '<span id="d">1</span><span>2</span><a>3</a><span id="e"></span>',
      );
      assert.equal(out(rawHtml('<a id="x" name="x">v</a>')), '<a id="x">v</a>');
    });

    it('collides with generated ids (heading, footnote, section, fragment) and drops the author attribute only', () => {
      const html = out(
        rawHtml('<span id="intro">a</span>'),
        el('h2', { id: 'intro' }, [text('Intro')]),
        rawHtml('<span id="svgid">b</span>'),
        gen('<svg><defs><marker id="arrowhead"></marker></defs></svg><div id="svgid"></div>'),
      );
      assert.ok(html.startsWith('<span>a</span><h2 id="intro">Intro</h2><span>b</span>'), html);
      assert.ok(html.includes('id="svgid"'));
    });

    it('duplicate generated ids are kept (not a failure)', () => {
      const result = run(root(el('h2', { id: 'dup' }, [text('1')]), el('h2', { id: 'dup' }, [text('2')])));
      assert.equal(result.failure, undefined);
      assert.equal(ser(result.tree as never), '<h2 id="dup">1</h2><h2 id="dup">2</h2>');
    });

    it('does not mutate its input and is deterministic across calls', () => {
      const input = root(rawHtml('<span id="faq">a</span>'), el('h2', { id: 'x' }, [text('X')]));
      const snapshot = JSON.stringify(input);
      const a = ser(run(input).tree as never);
      const b = ser(run(input, 'f'.repeat(32)).tree as never);
      assert.equal(JSON.stringify(input), snapshot);
      assert.equal(a, b);
    });
  });

  describe('safe-fragment-decode', () => {
    it('decodes once and falls back to the raw value on a malformed escape', () => {
      assert.equal(safeDecodeFragment('%E3%81%82'), 'あ');
      assert.equal(safeDecodeFragment('a%2520b'), 'a%20b');
      assert.equal(safeDecodeFragment('%'), '%');
      assert.equal(safeDecodeFragment('%E0%A4%A'), '%E0%A4%A');
      assert.equal(safeDecodeFragment(''), '');
    });

    it('author fragment hrefs are validated like any href, not decoded or rewritten', () => {
      assert.equal(
        out(rawHtml('<a href="#%E3%81%82">x</a><a href="#missing">y</a><a href="#%">z</a>')),
        '<a href="#%E3%81%82">x</a><a href="#missing">y</a><a href="#%">z</a>',
      );
    });
  });

  describe('image display values', () => {
    it('validates and normalises the four transport values; kebab wins over camel', () => {
      assert.deepEqual(
        validateImageDisplayProps({
          'data-crowi-image-width': '60%',
          dataCrowiImageHeight: '120px',
          'data-crowi-image-align': 'center',
          'data-crowi-image-float': 'right',
        }),
        {
          width: '60%',
          height: '120px',
          align: 'center',
          float: 'right',
        },
      );
      assert.deepEqual(validateImageDisplayProps({ 'data-crowi-image-width': '50%', dataCrowiImageWidth: '70%' }), { width: '50%' });
      assert.deepEqual(
        validateImageDisplayProps({
          'data-crowi-image-width': '0%',
          'data-crowi-image-height': '101%',
          'data-crowi-image-align': 'middle',
          'data-crowi-image-float': 'center',
        }),
        {},
      );
      assert.deepEqual(validateImageDisplayProps({ dataCrowiImageWidth: '4097px', dataCrowiImageHeight: '1px' }), { height: '1px' });
      assert.deepEqual(validateImageDisplayProps({ dataCrowiImageWidth: '12.5%' }), { width: '12.5%' });
      assert.deepEqual(validateImageDisplayProps({ dataCrowiImageWidth: 'calc(1px)', dataCrowiImageHeight: 5 }), {});
    });

    it('a standalone raw image with layout values becomes a figure; inline ones do not', () => {
      const standalone = out(rawHtml('<img src="/a.png" alt="a" data-crowi-image-align="center" data-crowi-image-width="50%">'));
      assert.equal(standalone, '<figure className="crowi-figure" dataCrowiImageAlign="center"><img alt="a" dataCrowiImageWidth="50%" src="/a.png"></figure>');
      const inline = out(
        el('p', {}, [text('see '), rawHtml('<img src="/a.png" alt="a" data-crowi-image-align="center" data-crowi-image-width="50%">'), text(' here')]),
      );
      assert.equal(inline, '<p>see <img alt="a" dataCrowiImageWidth="50%" src="/a.png"> here</p>');
      const inLink = out(rawHtml('<a href="/x"><img src="/a.png" alt="a" data-crowi-image-align="center"></a>'));
      assert.ok(!inLink.includes('Align'), inLink);
    });

    it('a paragraph holding only an aligned image becomes a figure; float wins over align', () => {
      const html = out(rawHtml('<p><img src="/a.png" alt="a" data-crowi-image-align="left" data-crowi-image-float="right"></p>'));
      assert.ok(html.startsWith('<figure className="crowi-figure" dataCrowiImageFloat="right">'), html);
      assert.ok(!html.includes('dataCrowiImageAlign'), html);
    });

    it('an existing figure whose only child is an image is not wrapped twice', () => {
      const html = out(rawHtml('<figure><img src="/a.png" alt="a" data-crowi-image-align="center"></figure>'));
      assert.equal(html.match(/<figure/g)?.length, 1, html);
      assert.ok(html.includes('dataCrowiImageAlign="center"'));
    });

    it('layout values on two images stay inline and are dropped', () => {
      const html = out(rawHtml('<img src="/a.png" data-crowi-image-align="center"><img src="/b.png" data-crowi-image-align="center">'));
      assert.ok(!html.includes('figure') && !html.includes('Align'), html);
    });
  });

  describe('limits-and-purity', () => {
    it('rejects cycles, malformed nodes and bad nonces without throwing', () => {
      const cyclic: Node = { type: 'element', tagName: 'div', properties: {}, children: [] };
      (cyclic.children as Node[]).push(cyclic);
      assert.equal(run(root(cyclic)).failure, 'invalid-input');
      assert.equal(run({ type: 'root', children: [{ type: 'element', properties: {}, children: [] }] }).failure, 'invalid-input');
      assert.equal(run({ type: 'root', children: [{ type: 'text', value: 5 }] }).failure, 'invalid-input');
      assert.equal(run(root(text('x')), 'not-a-nonce').failure, 'invalid-input');
      assert.equal(run(root(text('x')), NONCE.toUpperCase()).failure, 'invalid-input');
      assert.equal(validateWebRenderInput(null), 'invalid-input');
      assert.equal(validateWebRenderInput({ type: 'root', children: [] }), undefined);
    });

    it('caps total string size and returns an empty root with the failure code', () => {
      const big = 'x'.repeat(1024 * 1024);
      const children: Node[] = [];
      for (let i = 0; i < 65; i += 1) children.push(text(big));
      const result = run(root(...children));
      assert.equal(result.failure, 'resource-limit');
      assert.deepEqual(result.tree, { type: 'root', children: [] });
      // 64 MiB of one-byte strings is exactly at the limit and passes validation.
      assert.equal(validateWebRenderInput(root(...children.slice(0, 63))), undefined);
      const multibyte = text('あ'.repeat(30 * 1024 * 1024));
      assert.equal(validateWebRenderInput(root(multibyte)), 'resource-limit');
    });

    it('has no fixed depth cap and fails closed when the parser cannot recurse further', () => {
      let node = el('span', {}, [text('deep')]);
      for (let i = 0; i < 500; i += 1) node = el('div', {}, [node]);
      assert.equal(run(root(node)).failure, undefined);
      // Past what the HTML parser itself can recurse through, the result fails closed.
      for (let i = 0; i < 60000; i += 1) node = el('div', {}, [node]);
      const failed = run(root(node));
      assert.equal(failed.failure, 'resource-limit');
      assert.deepEqual(failed.tree, { type: 'root', children: [] });
    });

    it('never shares slot state between calls', () => {
      const tree = root(gen('<pre>ONE</pre>'));
      const a = ser(run(tree, 'a'.repeat(32)).tree as never);
      const b = ser(run(tree, 'b'.repeat(32)).tree as never);
      assert.equal(a, b);
    });

    it('a generated fragment that cannot parse still returns a tree or a fail-closed result', () => {
      const result = run(root(gen('<div><span>unclosed')));
      assert.ok(result.failure === undefined || result.failure === 'parse-failed');
    });

    it('frozen input is accepted', () => {
      const tree = Object.freeze(root(rawHtml('<b>x</b>')));
      assert.equal(run(tree as Node).failure, undefined);
    });

    it('an unknown policy value is treated as strict', () => {
      for (const policy of ['Relaxed', 'loose', '', undefined, null, 1]) {
        const result = sanitizeWebHast(root(rawHtml('<center style="color:red">y</center>')) as never, { policy: policy as never, slotNonce: NONCE });
        assert.equal(ser(result.tree as never), 'y', String(policy));
      }
    });
  });

  describe('generated-vs-authored provenance', () => {
    it('an author copy of generated markup gets the strict treatment', () => {
      const authored = out(rawHtml('<pre class="shiki" style="color:red"><span style="color:#fff">x</span></pre>'));
      assert.equal(authored, '<pre><span>x</span></pre>');
      const generated = out(gen('<pre class="shiki" style="color:red"><span style="color:#fff">x</span></pre>'));
      assert.ok(generated.includes('style="color:red"'));
    });

    it('generated svg keeps internal references and ids even when an author id collides', () => {
      const svg =
        '<svg><defs><marker id="arrowhead"><path d="M0 0"/></marker><linearGradient id="gradient"><stop offset="0"/></linearGradient><path id="shape" d="M1 1"/></defs><path marker-end="url(#arrowhead)" fill="url(#gradient)"/><use href="#shape"/></svg>';
      const html = out(rawHtml('<span id="arrowhead">a</span><span id="shape">s</span>'), gen(svg));
      assert.ok(html.startsWith('<span>a</span><span>s</span>'), html);
      for (const needle of ['id="arrowhead"', 'id="gradient"', 'id="shape"', 'url(#arrowhead)', 'url(#gradient)', 'href="#shape"'])
        assert.ok(html.includes(needle), needle);
    });
  });

  describe('heading section structure', () => {
    it('restores a generated section target only when the child heading id survives', () => {
      const ok = out(el('section', { dataSectionId: 'a' }, [el('h2', { id: 'a' }, [text('A')])]));
      assert.equal(ok, '<section dataSectionId="a"><h2 id="a">A</h2></section>');
      const mismatch = out(el('section', { dataSectionId: 'zzz' }, [el('h2', { id: 'a' }, [text('A')])]));
      assert.equal(mismatch, '<section><h2 id="a">A</h2></section>');
    });

    it('keeps the section/heading pair after an unclosed wrapper', () => {
      for (const open of ['<object>', '<applet>', '<template>', '<details>', '<div>', '<blockquote>']) {
        const html = out(rawHtml(open), el('section', { dataSectionId: 'h' }, [el('h2', { id: 'h' }, [text('H')]), el('p', {}, [text('body')])]));
        assert.ok(html.includes('<section dataSectionId="h"><h2 id="h">H</h2>'), `${open} -> ${html}`);
      }
    });

    it('a heading raw chunk is not a section', () => {
      const html = out(rawHtml('<h2 id="setup">S</h2>'));
      assert.equal(html, '<h2 id="setup">S</h2>');
    });
  });

  describe('contract-subpath-exports', () => {
    it('the built package entry exposes the same behaviour for CJS and ESM', async () => {
      const entry: string = '@crowi/api-contract/html-sanitizer';
      const cjs: unknown = createRequire(import.meta.url)(entry);
      const esm: unknown = await import(entry);
      const tree = root(rawHtml('<a href="javascript:x">l</a><script>1</script>'), gen('<pre>G</pre>'));
      const results = [cjs, esm].map((mod) => {
        const api = mod as { sanitizeWebHast?: unknown; sanitizeDisplayUrl?: unknown; safeDecodeFragment?: unknown };
        assert.equal(typeof api.sanitizeWebHast, 'function');
        assert.equal(typeof api.sanitizeDisplayUrl, 'function');
        assert.equal(typeof api.safeDecodeFragment, 'function');
        const result = (api.sanitizeWebHast as (t: unknown, o: unknown) => { tree: unknown; failure?: string })(tree, { policy: 'strict', slotNonce: NONCE });
        assert.equal(result.failure, undefined);
        return JSON.stringify(result.tree);
      });
      assert.equal(results[0], results[1]);
      assert.equal(ser(JSON.parse(results[0] as string)), '<a>l</a><pre>G</pre>');
    });
  });
});

const ORIGINS = { webOrigin: 'https://wiki.example', apiOrigin: 'https://api.example:8443', artifactOrigin: 'https://artifact.example' };

function runRelaxed(tree: Node, ...rest: unknown[]) {
  const iframeOrigins = rest.length > 0 ? rest[0] : ORIGINS;
  return sanitizeWebHast(tree as never, { policy: 'relaxed', slotNonce: NONCE, iframeOrigins: iframeOrigins as never });
}

function outRelaxed(...children: Node[]): string {
  const result = runRelaxed(root(...children));
  assert.equal(result.failure, undefined, `unexpected failure ${String(result.failure)}`);
  return ser(result.tree as never);
}

function hasTag(children: Node[], tag: string, ...origins: unknown[]): boolean {
  const result = runRelaxed(root(...children), origins.length > 0 ? origins[0] : ORIGINS);
  assert.equal(result.failure, undefined);
  return find(result.tree as never, tag).length > 0;
}

describe('relaxed HTML policy', () => {
  describe('relaxed-shells', () => {
    const EXTRA = ['address', 'hgroup', 'search', 'menu', 'center', 'font', 'big', 'tt', 'strike', 'acronym', 'nobr', 'rb', 'rtc', 'data', 'listing'];

    it('keeps every passive layout tag that strict unwraps', () => {
      for (const tag of EXTRA) {
        const html = `<${tag} style="color:red" class="x">t</${tag}>`;
        assert.ok(outRelaxed(rawHtml(html)).includes(`<${tag}`), tag);
        assert.ok(!out(rawHtml(html)).includes(`<${tag}`), `strict ${tag}`);
      }
    });

    it('keeps style and class on ordinary tags and drops them in strict', () => {
      const html = '<div style="display:flex;gap:4px" class="a b">x</div>';
      assert.equal(outRelaxed(rawHtml(html)), '<div className="a b" style="display:flex;gap:4px">x</div>');
      assert.equal(out(rawHtml(html)), '<div>x</div>');
    });

    it('removes only the reserved class tokens, deduplicating in order', () => {
      const html =
        '<span class="  b crowi-x language-js katex-html katex shiki mention  b a sr-only footnotes diagram-embed wikilink-broken contains-task-list task-list-item data-footnote-backref">t</span>';
      assert.equal(outRelaxed(rawHtml(html)), '<span className="b a">t</span>');
      assert.equal(outRelaxed(rawHtml('<span class="crowi-x katex">t</span>')), '<span>t</span>');
    });

    it('drops a style whose parsers disagree but keeps the element and its text', () => {
      const html = String.raw`<p style="a\;b:1">kept</p>`;
      assert.equal(outRelaxed(rawHtml(html)), '<p>kept</p>');
    });

    it('drops background images and variables from style', () => {
      assert.equal(outRelaxed(rawHtml('<div style="color:red;background:url(https://e/x)">x</div>')), '<div style="color:red">x</div>');
      assert.equal(outRelaxed(rawHtml('<div style="--a:1;width:var(--a)">x</div>')), '<div>x</div>');
    });

    it('never allows code-content, form, embed, media or SVG elements', () => {
      const html =
        '<script>a</script><meta><base><link><form><input name=a><button>b</button><select><option>o</option></select><textarea>t</textarea><fieldset><legend>l</legend></fieldset><label>l</label><object></object><embed><param><frame><audio></audio><video></video><canvas></canvas><template>tt</template><svg><circle/></svg><math></math></form><style>p{}</style>';
      const result = outRelaxed(rawHtml(html));
      for (const tag of [
        'script',
        'meta',
        'base',
        'link',
        'form',
        'input',
        'button',
        'select',
        'option',
        'textarea',
        'fieldset',
        'legend',
        'label',
        'object',
        'embed',
        'param',
        'frame',
        'audio',
        'video',
        'canvas',
        'template',
        'svg',
        'math',
        'style',
      ])
        assert.ok(!result.includes(`<${tag}`), tag);
    });

    it('does not allow event handlers, srcdoc, data attributes or custom elements', () => {
      assert.equal(outRelaxed(rawHtml('<div onclick="x()" data-a="1" srcdoc="s" is="x" role="button" aria-label="l" tabindex="0">t</div>')), '<div>t</div>');
      assert.equal(hasTag([rawHtml('<my-widget>w</my-widget>')], 'my-widget'), false);
    });

    it('does not let an author forge reserved attributes or generated markup', () => {
      const authored = outRelaxed(
        rawHtml('<pre class="shiki" style="color:red"><code class="language-js">x</code></pre><span data-crowi-generated-slot="x">y</span>'),
      );
      assert.ok(!authored.includes('shiki'));
      assert.ok(!authored.includes('language-js'));
      assert.ok(!authored.includes('data-crowi'));
      const generated = outRelaxed(gen('<pre class="shiki" style="color:red"><span style="color:#fff">x</span></pre>'));
      assert.ok(generated.includes('class="shiki"') || generated.includes('shiki'));
    });

    it('keeps generated fragments after an unclosed passive tag', () => {
      const result = outRelaxed(rawHtml('<center>a'), gen('<div>generated</div>'));
      assert.ok(result.includes('generated'));
    });

    it('applies the same URL rules to links and images', () => {
      assert.equal(outRelaxed(rawHtml('<a href="javascript:alert(1)">l</a>')), '<a>l</a>');
      assert.equal(outRelaxed(rawHtml('<img src="data:image/svg+xml;base64,AAAA" alt="a">')), 'a');
      assert.equal(outRelaxed(rawHtml('<a href="https://e.example/">l</a>')), '<a href="https://e.example/">l</a>');
    });

    it('keeps the raw image display transport attributes', () => {
      const result = outRelaxed(rawHtml('<img src="https://e.example/a.png" alt="a" data-crowi-image-width="50%" style="border:1px solid red">'));
      assert.ok(result.includes('dataCrowiImageWidth="50%"'));
      assert.ok(result.includes('style="border:1px solid red"'));
    });

    it('does not mutate a frozen input', () => {
      const tree = Object.freeze(root(rawHtml('<center style="color:red">x</center>')));
      assert.equal(runRelaxed(tree as Node).failure, undefined);
    });

    it('is deterministic across nonces', () => {
      const tree = root(rawHtml('<center class="a" style="color:red">x</center>'), gen('<div>g</div>'));
      const a = ser(runRelaxed(tree).tree as never);
      const b = ser(sanitizeWebHast(tree as never, { policy: 'relaxed', slotNonce: 'b'.repeat(32), iframeOrigins: ORIGINS }).tree as never);
      assert.equal(a, b);
    });

    it('keeps an owner-fixed class and the author class together', () => {
      const table = el('table', { className: ['x'], style: 'width:10px' }, [el('tbody', {}, [el('tr', {}, [el('td', {}, [text('c')])])])]);
      const result = outRelaxed(table);
      assert.ok(result.includes('className="x"'));
      const task = el('ul', { className: ['contains-task-list', 'mine'] }, [el('li', { className: ['task-list-item'] }, [text('t')])]);
      assert.ok(outRelaxed(task).includes('className="contains-task-list mine"'));
    });
  });

  describe('relaxed-iframe', () => {
    const YT = 'https://www.youtube.com/embed/abc';

    it('builds an iframe shell with fixed attributes from a YouTube-style embed', () => {
      const result = outRelaxed(
        rawHtml(
          `<iframe src="${YT}" width="560" height="315" title="Video" style="border:0" class="v" srcdoc="x" sandbox="" allow="camera" name="n" referrerpolicy="no-referrer" loading="eager" allowfullscreen>fallback</iframe>`,
        ),
      );
      assert.equal(
        result,
        `<iframe allowFullScreen className="v" height="315" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation" src="${YT}" style="border:0" title="Video" width="560"></iframe>`,
      );
    });

    it('never grants forms or top navigation and never emits allow', () => {
      const result = outRelaxed(rawHtml(`<iframe src="${YT}" allow="geolocation"></iframe>`));
      assert.ok(!result.includes('allow-forms'));
      assert.ok(!result.includes('allow-top-navigation'));
      assert.ok(!/ allow="/.test(result));
    });

    it('rejects Web, API (with port) and artifact origins and unwraps the fallback', () => {
      for (const src of ['https://wiki.example/x', 'https://WIKI.example:443/y', 'https://api.example:8443/z', 'https://artifact.example/a']) {
        assert.equal(outRelaxed(rawHtml(`<iframe src="${src}">fb</iframe><p>after</p>`)), 'fb<p>after</p>', src);
      }
      // Same host on another port is a different origin.
      assert.ok(outRelaxed(rawHtml('<iframe src="https://api.example/z"></iframe>')).includes('<iframe'));
    });

    it('rejects http, relative, network-path, fragment, empty, scheme-less and dangerous src', () => {
      for (const src of [
        'http://e.example/',
        '/x',
        '//e.example/',
        '#a',
        '',
        'e.example/x',
        'data:text/html,x',
        'blob:https://e.example/x',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'https://u:p@e.example/',
        'https://',
        'ht\ntps://e.example/',
        ' \u0001https://e.example/',
      ]) {
        const result = outRelaxed(rawHtml(`<iframe src="${src}"></iframe>`));
        assert.ok(!result.includes('<iframe'), JSON.stringify(src));
      }
    });

    it('accepts an uppercase scheme and keeps the author spelling', () => {
      const result = outRelaxed(rawHtml('<iframe src="HTTPS://Maps.Example/Embed?q=1"></iframe>'));
      assert.ok(result.includes('src="HTTPS://Maps.Example/Embed?q=1"'));
    });

    it('rejects every iframe when origin information is missing or invalid', () => {
      for (const origins of [
        undefined,
        null,
        {},
        { webOrigin: 'x', apiOrigin: 'https://a.example', artifactOrigin: null },
        { webOrigin: 'https://w.example', apiOrigin: 'https://a.example' },
        { webOrigin: 'https://w.example', apiOrigin: 'https://a.example', artifactOrigin: 'nope' },
      ]) {
        assert.equal(hasTag([rawHtml(`<iframe src="${YT}"></iframe>t`)], 'iframe', origins), false, JSON.stringify(origins));
      }
      assert.equal(hasTag([rawHtml(`<iframe src="${YT}"></iframe>`)], 'iframe'), true);
      assert.equal(
        hasTag([rawHtml(`<iframe src="${YT}"></iframe>`)], 'iframe', { webOrigin: 'https://w.example', apiOrigin: 'https://a.example', artifactOrigin: null }),
        true,
      );
    });

    it('strict never keeps an iframe, even with origins supplied', () => {
      const result = sanitizeWebHast(root(rawHtml(`<iframe src="${YT}">x</iframe>t`)) as never, { policy: 'strict', slotNonce: NONCE, iframeOrigins: ORIGINS });
      assert.equal(ser(result.tree as never), 't');
    });

    it('validates title, width and height', () => {
      const attrs = (extra: string) => outRelaxed(rawHtml(`<iframe src="${YT}" ${extra}></iframe>`));
      assert.ok(attrs('title="ok"').includes('title="ok"'));
      assert.ok(!attrs('title=""').includes('title='));
      assert.ok(!attrs(`title="${'a'.repeat(257)}"`).includes('title='));
      assert.ok(attrs(`title="${'a'.repeat(256)}"`).includes('title='));
      assert.ok(!attrs('title="a&#10;b"').includes('title='));
      assert.ok(attrs('width="4096" height="1"').includes('width="4096"'));
      for (const bad of ['0', '4097', '1.5', '10px', '-3', '']) assert.ok(!attrs(`width="${bad}"`).includes('width='), bad);
    });

    it('unwraps a rejected iframe whose body is inert text, restoring no author style or class', () => {
      const children = [rawHtml('<iframe src="http://x/"><b style="color:red" class="c">in</b><script>s</script></iframe>after')];
      for (const tag of ['iframe', 'b', 'script']) assert.equal(hasTag(children, tag), false, tag);
      assert.ok(outRelaxed(...children).endsWith('after'));
    });

    it('treats a closed iframe whose first terminator candidate is incomplete as text', () => {
      const html = `<iframe src="${YT}"></iframe x='</iframe>after`;
      assert.equal(hasTag([rawHtml(html)], 'iframe'), false);
      assert.ok(outRelaxed(rawHtml(html)).includes('after'));
    });

    it('does not let a later complete closer repair an incomplete first candidate, and keeps what follows', () => {
      const html = `<iframe src="${YT}"></iframe x='</iframe>`;
      const trailing = gen('<div>generated block</div>');
      const result = runRelaxed(root(rawHtml(html), trailing));
      assert.equal(result.failure, undefined);
      const rendered = ser(result.tree as never);
      assert.equal(find(result.tree as never, 'iframe').length, 0);
      assert.ok(rendered.includes('generated block'));
    });

    it('demotes an unclosed iframe or one closed in another chunk, preserving following content', () => {
      const unclosed = runRelaxed(root(rawHtml(`<iframe src="${YT}">`), gen('<div>g</div>'), text('t')));
      const rendered = ser(unclosed.tree as never);
      assert.equal(find(unclosed.tree as never, 'iframe').length, 0);
      assert.ok(rendered.includes('<div>g</div>'));

      const split = runRelaxed(root(rawHtml(`<iframe src="${YT}">`), rawHtml('</iframe>'), gen('<div>g2</div>')));
      assert.equal(find(split.tree as never, 'iframe').length, 0);
      assert.ok(ser(split.tree as never).includes('g2'));
    });

    it('recognises the end tag case-insensitively and with attributes', () => {
      assert.ok(outRelaxed(rawHtml(`<IFRAME src="${YT}">x</IFRAME >`)).includes('<iframe'));
      assert.ok(outRelaxed(rawHtml(`<iframe src="${YT}">x</iframe\n>`)).includes('<iframe'));
    });

    it('keeps generated slots that follow a valid iframe', () => {
      const result = runRelaxed(root(rawHtml(`<iframe src="${YT}"></iframe>`), gen('<div>after</div>')));
      const rendered = ser(result.tree as never);
      assert.ok(rendered.includes('<iframe'));
      assert.ok(rendered.includes('<div>after</div>'));
    });

    it('validates an iframe that is already a HAST element with the same rules', () => {
      assert.ok(outRelaxed(el('iframe', { src: YT, srcDoc: 'x', sandbox: ['allow-forms'] }, [])).includes('<iframe'));
      assert.ok(!outRelaxed(el('iframe', { src: 'https://wiki.example/' }, [text('fb')])).includes('<iframe'));
      assert.ok(!outRelaxed(el('iframe', { src: YT, srcDoc: 'x', sandbox: ['allow-forms'] }, [])).includes('allow-forms'));
    });

    it('is exposed through sanitizeIframeSrc with the same decisions', () => {
      assert.equal(sanitizeIframeSrc(YT, ORIGINS), YT);
      assert.equal(sanitizeIframeSrc(`  ${YT}  `, ORIGINS), YT);
      assert.equal(sanitizeIframeSrc('https://wiki.example/', ORIGINS), undefined);
      assert.equal(sanitizeIframeSrc(YT, undefined), undefined);
      assert.equal(sanitizeIframeSrc(1, ORIGINS), undefined);
    });
  });
});
