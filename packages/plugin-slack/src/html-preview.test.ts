import { extractHtmlPreview, HTML_EXCERPT_MAX_CHARS } from './html-preview';

const doc = (head: string, body: string) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('extractHtmlPreview', () => {
  it('returns the collapsed <title>, null when missing or blank', () => {
    expect(extractHtmlPreview(doc('<title>  A \n B </title>', '')).title).toBe('A B');
    expect(extractHtmlPreview(doc('', '')).title).toBeNull();
    expect(extractHtmlPreview(doc('<title>   </title>', '')).title).toBeNull();
  });

  it('reads meta description case-insensitively; blank content is null', () => {
    expect(extractHtmlPreview(doc('<meta name="Description" content=" hi  there ">', '')).description).toBe('hi there');
    expect(extractHtmlPreview(doc('<meta name="description" content="   ">', '')).description).toBeNull();
  });

  it('excludes non-visible elements and head text', () => {
    const body = '<style>.x{}</style><script>var a=1</script><noscript>ns</noscript><template>tpl</template><svg><text>sv</text></svg><math>mm</math>shown';
    const r = extractHtmlPreview(doc('<title>T</title>', body));
    expect(r.text).toBe('shown');
  });

  it('separates blocks but not inline elements; collapses whitespace', () => {
    expect(extractHtmlPreview(doc('', '<h1>A</h1><p>B</p>')).text).toBe('A B');
    expect(extractHtmlPreview(doc('', '<b>H</b>2O')).text).toBe('H2O');
    expect(extractHtmlPreview(doc('', 'a \n\t  b')).text).toBe('a b');
  });

  it('clips body and description at 300 code points; leaves title intact', () => {
    const emoji = '😀'.repeat(HTML_EXCERPT_MAX_CHARS + 5);
    const r = extractHtmlPreview(doc(`<title>${'t'.repeat(500)}</title><meta name="description" content="${emoji}">`, `<p>${emoji}</p>`));
    expect(r.text).toBe(`${'😀'.repeat(HTML_EXCERPT_MAX_CHARS)}…`);
    expect(r.description).toBe(`${'😀'.repeat(HTML_EXCERPT_MAX_CHARS)}…`);
    expect(r.title).toHaveLength(500);
  });

  it('still extracts everything when the input exceeds the scan limit', () => {
    const r = extractHtmlPreview(doc('<title>T</title><meta name="description" content="D">', `<p>start</p>${'z'.repeat(300_000)}`));
    expect(r).toMatchObject({ title: 'T', description: 'D' });
    expect(r.text?.startsWith('start')).toBe(true);
  });
});
