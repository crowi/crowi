import { renderCard, renderFallbackCard } from './render-card';

/**
 * `stripUnknownElements` structural-preservation fixture (spec
 * §"カード HTML(sanitize 経路との整合)"). The web editor's sanitizer
 * (`packages/web/src/components/editor/render-mdast.ts:stripUnknownElements`)
 * unwraps (drops the wrapper, keeps children) any element whose tag
 * name isn't in `known-tags.ts`'s allow-list. Rather than pulling the
 * web app's mdast/hast toolchain into this api-side module (wrong
 * dependency direction), this scans the raw HTML for every opening tag
 * and asserts each one is a member of the exact allow-listed subset
 * this renderer is documented to use (`figure` / `a` / `div` / `img` /
 * `span` — all confirmed present in `known-tags.ts`'s `HTML_TAGS`).
 * If every emitted tag is already allow-listed, `stripUnknownElements`
 * is a no-op on this output by construction — nothing to strip, so the
 * structure survives unchanged.
 *
 * This file only checks the STRING this module builds. The actual
 * front-end pipeline (`toHast -> raw -> stripUnknownElements ->
 * toJsxRuntime`) is exercised separately, against a literal copy of
 * this output, in
 * `packages/web/src/components/editor/render-mdast.test.tsx`'s "link-card
 * embed HTML" describe block — see that file if the two ever need to
 * be kept in sync after a `renderCard`/`renderFallbackCard` shape change.
 */
const KNOWN_TAGS = new Set(['figure', 'a', 'div', 'img', 'span']);
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b/g;

function tagNamesIn(html: string): string[] {
  return [...html.matchAll(OPEN_TAG_RE)].map((m) => m[1]);
}

describe('renderCard / renderFallbackCard — every emitted tag is known-tags-allow-listed', () => {
  it('a full card (title/description/domain/site-name/image) uses only known tags', () => {
    const html = renderCard('https://example.test/page', {
      title: 'Title',
      description: 'Description',
      image: 'https://example.test/img.png',
      siteName: 'Example',
    });
    const tags = tagNamesIn(html);
    // figure > a > div(body) > [div(title), div(description), div(meta) > [span(site-name), span(domain)]] + img
    expect(tags).toEqual(['figure', 'a', 'div', 'div', 'div', 'div', 'span', 'span', 'img']);
    expect(tags.every((t) => KNOWN_TAGS.has(t))).toBe(true);
  });

  it('a domain-only (no meta) card uses only known tags', () => {
    const tags = tagNamesIn(renderCard('https://example.test/page'));
    expect(tags.every((t) => KNOWN_TAGS.has(t))).toBe(true);
    expect(tags).toContain('figure');
  });

  it('a fallback card uses only known tags', () => {
    const tags = tagNamesIn(renderFallbackCard('https://example.test/page'));
    // figure > a > div(body) > div(title)
    expect(tags).toEqual(['figure', 'a', 'div', 'div']);
    expect(tags.every((t) => KNOWN_TAGS.has(t))).toBe(true);
  });

  it('every <a>/<figure>/<div>/<span> is well-formed (balanced open/close tags)', () => {
    const html = renderCard('https://example.test/page', { title: 'x', description: 'y', image: 'https://example.test/a.png' });
    for (const tag of ['a', 'figure', 'div', 'span']) {
      const opens = (html.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length;
      const closes = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});

describe('renderCard — XSS sanitisation', () => {
  it('escapes a <script> tag injected via the title', () => {
    const html = renderCard('https://example.test/page', { title: '<script>alert(1)</script>' });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes an attribute-breakout attempt in the description (no live <img> tag is created)', () => {
    const html = renderCard('https://example.test/page', { title: 'x', description: '"><img src=x onerror=alert(1)>' });
    // The breakout text survives as inert escaped text — critically, it
    // never becomes a real `<img onerror=...>` element (the `<` is escaped).
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(tagNamesIn(html)).not.toContain('img');
  });

  it('escapes an attribute-breakout attempt in site_name', () => {
    const html = renderCard('https://example.test/page', { title: 'x', siteName: '"><script>alert(2)</script>' });
    expect(html).not.toMatch(/<script/i);
  });

  it('drops a javascript: og:image rather than emitting it as an <img src>', () => {
    const html = renderCard('https://example.test/page', { title: 'x', image: 'javascript:alert(1)' });
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/javascript:/);
  });

  it('drops a data: og:image rather than emitting it as an <img src>', () => {
    const html = renderCard('https://example.test/page', { title: 'x', image: 'data:text/html,<script>alert(1)</script>' });
    expect(html).not.toContain('<img');
  });

  it('keeps a safe https og:image as the <img> src', () => {
    const html = renderCard('https://example.test/page', { title: 'x', image: 'https://example.test/a.png' });
    expect(html).toContain('<img class="crowi-link-card-image" alt="" loading="lazy" src="https://example.test/a.png">');
  });

  it('renders an inert href (not the raw scheme) when the card URL itself is a non-http(s) scheme', () => {
    const html = renderCard('javascript:alert(1)', { title: 'x' });
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).toContain('href="#"');
  });

  it('escapes an XSS attempt embedded in the target URL itself', () => {
    const html = renderCard('https://example.test/page?q="><script>alert(1)</script>', { title: 'x' });
    expect(html).not.toMatch(/<script/i);
  });
});

describe('renderCard — content shape', () => {
  it('uses the domain as the title when no og:title/description/image is available', () => {
    const html = renderCard('https://example.test/some/page');
    expect(html).toContain('<div class="crowi-link-card-title">example.test</div>');
    expect(html).not.toContain('crowi-link-card-description');
    expect(html).not.toContain('<img');
  });

  it('omits the description block when absent but keeps the domain', () => {
    const html = renderCard('https://example.test/page', { title: 'Has title, no description' });
    expect(html).not.toContain('crowi-link-card-description');
    expect(html).toContain('<span class="crowi-link-card-domain">example.test</span>');
  });

  it('shows og:site_name as an ADDITIONAL element alongside the domain, never replacing it', () => {
    const html = renderCard('https://example.test/page', { title: 'x', siteName: 'Example Site' });
    expect(html).toContain('<span class="crowi-link-card-site-name">Example Site</span>');
    // The domain itself must still be present — it is derived from the URL,
    // not from author/OGP-supplied data, and must never disappear (reviewer
    // finding: og:site_name previously silently replaced the domain).
    expect(html).toContain('<span class="crowi-link-card-domain">example.test</span>');
  });

  it('omits the site-name element when og:site_name is just the domain again (avoids a redundant duplicate)', () => {
    const html = renderCard('https://example.test/page', { title: 'x', siteName: 'example.test' });
    expect(html).not.toContain('crowi-link-card-site-name');
    expect(html).toContain('<span class="crowi-link-card-domain">example.test</span>');
  });

  it('opens the card link in a new tab with noopener/noreferrer', () => {
    const html = renderCard('https://example.test/page', { title: 'x' });
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('renderFallbackCard — unified fallback contract (spec §6.1/§6.2)', () => {
  it('renders a working link to the original URL', () => {
    const html = renderFallbackCard('https://example.test/unreachable');
    expect(html).toContain('href="https://example.test/unreachable"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('shows the URL itself (not the domain) as the title — matches the editor live-preview placeholder contract', () => {
    const html = renderFallbackCard('https://example.test/some/deep/page?x=1');
    expect(html).toContain('<div class="crowi-link-card-title">https://example.test/some/deep/page?x=1</div>');
  });

  it('carries the crowi-link-card class vocabulary shared with renderCard()', () => {
    const html = renderFallbackCard('https://example.test/x');
    expect(html).toContain('class="crowi-link-card"');
    expect(html).toContain('class="crowi-link-card-body"');
    expect(html).toContain('class="crowi-link-card-title"');
  });

  it('never emits an error-specific class or label — the old crowi-link-card-error / "Preview unavailable" variant is retired', () => {
    const html = renderFallbackCard('https://example.test/x');
    expect(html).not.toContain('crowi-link-card-error');
    expect(html).not.toMatch(/Preview unavailable/i);
  });

  it('never emits OGP fields (no description, no image, no site-name)', () => {
    const html = renderFallbackCard('https://example.test/x');
    expect(html).not.toContain('crowi-link-card-description');
    expect(html).not.toContain('crowi-link-card-image');
    expect(html).not.toContain('crowi-link-card-site-name');
    expect(html).not.toContain('crowi-link-card-domain');
    expect(html).not.toContain('<img');
  });

  it('never emits the raw url as href when it is a non-http(s) scheme', () => {
    const html = renderFallbackCard('javascript:alert(1)');
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).toContain('href="#"');
  });

  it('escapes an XSS attempt embedded in the url itself (title = escaped url)', () => {
    const html = renderFallbackCard('https://example.test/page?q="><script>alert(1)</script>');
    expect(html).not.toMatch(/<script/i);
  });

  it('is byte-identical for the same url across repeated calls (fetch-failure path and toggle-off path share this exact builder)', () => {
    const url = 'https://example.test/same-url';
    expect(renderFallbackCard(url)).toBe(renderFallbackCard(url));
  });
});
