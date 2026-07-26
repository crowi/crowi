import type { SanitizeSvgPolicy } from './policy';
import { sanitizeSvg } from './sanitize';

const STRICT: SanitizeSvgPolicy = { allowSafeHref: false };
const ALLOW_SAFE_HREF: SanitizeSvgPolicy = { allowSafeHref: true };

const SVG_NS_ATTRS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

function expectOk(svg: string, policy: SanitizeSvgPolicy = STRICT): string {
  const result = sanitizeSvg(svg, policy);
  if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
  return result.svg;
}

describe('sanitizeSvg — malicious vectors', () => {
  it('strips <script> blocks', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><script>alert(1)</script><path d="M0 0"/></svg>`);
    expect(out).not.toMatch(/script/i);
    expect(out).toContain('<path');
  });

  it('strips <foreignObject> (and its HTML children) entirely', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><foreignObject><div onclick="x">html</div></foreignObject><path d="M0 0"/></svg>`);
    expect(out).not.toMatch(/foreignObject/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain('<path');
  });

  it('strips on* event-handler attributes regardless of casing', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><rect onclick="a()" onLoad="b()" ONERROR="c()" x="0" y="0" width="1" height="1"/></svg>`);
    expect(out).not.toMatch(/on\w+\s*=/i);
  });

  it('strips javascript: URLs from href and xlink:href (single + double quoted)', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><a href="javascript:alert(1)">x</a><use xlink:href="javascript:alert(2)"/></svg>`, ALLOW_SAFE_HREF);
    expect(out).not.toMatch(/javascript:/i);
  });

  it('strips data: URIs from href', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><image href="data:image/png;base64,AAAA"/></svg>`, ALLOW_SAFE_HREF);
    expect(out).not.toMatch(/data:/i);
  });

  it('strips protocol-relative URLs from href', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><a href="//evil.example/x">x</a></svg>`, ALLOW_SAFE_HREF);
    expect(out).not.toContain('//evil.example');
  });

  it('strips @import and non-local url() inside <style> element text, but preserves local url(#id) references', () => {
    const out = expectOk(
      `<svg ${SVG_NS_ATTRS}><style>@import url(evil.css); .node { fill: url(#grad); background: url("https://evil.example/x.png"); }</style></svg>`,
    );
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toMatch(/url\(\s*["']?(evil\.css|https:\/\/evil\.example)/i);
    // Mermaid's own `<style>` output wires gradients/markers via local
    // url(#id) references (verified against real `mermaid@11` output) —
    // stripping these too would leave every diagram's real coloring
    // broken even though nothing unsafe was ever present.
    expect(out).toContain('url(#grad)');
  });

  it('strips a comment-obfuscated @import inside <style> element text (comments removed before pattern matching)', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><style>/* sneaky */@import/**/url(evil.css);.node{fill:#eee}</style></svg>`);
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toMatch(/evil\.css/i);
    expect(out).toContain('.node{fill:#eee}');
  });

  it('does NOT drop the <style> element itself — Mermaid output carries all node/edge coloring as class-based CSS there, not as SVG presentation attributes', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><style>.node rect { fill: #eee; }</style><g class="node"><rect/></g></svg>`);
    expect(out).toContain('<style>');
    expect(out).toContain('.node rect');
  });

  it('strips the style attribute', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><rect style="fill:url(https://evil.example/x.png)" x="0" y="0" width="1" height="1"/></svg>`);
    expect(out).not.toMatch(/style\s*=/i);
  });

  it('strips external image/font references (href on <image>)', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><image href="https://evil.example/icon.png" x="0" y="0" width="1" height="1"/></svg>`);
    expect(out).not.toMatch(/https:\/\/evil\.example/);
    expect(out).toContain('<image');
  });

  it('strips external url() references from presentation attributes (fill, filter, ...)', () => {
    const out = expectOk(
      `<svg ${SVG_NS_ATTRS}><rect fill="url(https://evil.example/paint.svg)" x="0" y="0" width="1" height="1"/><g filter="url(data:image/svg+xml;base64,AAAA)"><path d="M0 0"/></g></svg>`,
    );
    expect(out).not.toMatch(/fill\s*=/i);
    expect(out).not.toMatch(/filter\s*=/i);
    expect(out).not.toMatch(/evil\.example/i);
    expect(out).not.toMatch(/data:image/i);
  });

  it('strips external url() references from clip-path/mask/cursor/marker-* attributes', () => {
    const out = expectOk(
      [
        `<svg ${SVG_NS_ATTRS}>`,
        '<rect clip-path="url(https://evil.example/clip.svg#c)" x="0" y="0" width="1" height="1"/>',
        '<rect mask="url(//evil.example/mask.svg#m)" x="0" y="0" width="1" height="1"/>',
        '<rect cursor="url(https://evil.example/cursor.png)" x="0" y="0" width="1" height="1"/>',
        '<path marker-start="url(https://evil.example/m.svg#s)" marker-mid="url(data:image/svg+xml,x)" marker-end="url(javascript:alert(1))" d="M0 0"/>',
        '</svg>',
      ].join(''),
    );
    expect(out).not.toMatch(/clip-path\s*=/i);
    expect(out).not.toMatch(/mask\s*=/i);
    expect(out).not.toMatch(/cursor\s*=/i);
    expect(out).not.toMatch(/marker-start\s*=/i);
    expect(out).not.toMatch(/marker-mid\s*=/i);
    expect(out).not.toMatch(/marker-end\s*=/i);
    expect(out).not.toMatch(/evil\.example/i);
  });

  it('preserves local-fragment url(#id) references in presentation attributes', () => {
    const out = expectOk(
      `<svg ${SVG_NS_ATTRS}><defs><linearGradient id="grad"/><marker id="arrow"/></defs><rect fill="url(#grad)" x="0" y="0" width="1" height="1"/><path marker-end="url(#arrow)" d="M0 0"/></svg>`,
    );
    expect(out).toContain('fill="url(#grad)"');
    expect(out).toContain('marker-end="url(#arrow)"');
  });

  it('preserves plain keyword/color values on url()-capable presentation attributes', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><rect fill="none" stroke="#333333" x="0" y="0" width="1" height="1"/></svg>`);
    expect(out).toContain('fill="none"');
    expect(out).toContain('stroke="#333333"');
  });

  it('strips xmlns declarations on non-root elements', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><g xmlns:evil="http://evil.example/ns"><path d="M0 0"/></g></svg>`);
    expect(out).not.toMatch(/evil/i);
  });

  it('strips a nonessential xmlns:* declaration on the root element', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS} xmlns:evil="http://evil.example/ns"><path d="M0 0"/></svg>`);
    expect(out).not.toMatch(/evil/i);
    // The essential declarations survive unchanged — this is a targeted
    // strip of the extra one, not a regression on the root namespace
    // declarations every other test in this file relies on.
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it('strips a root xmlns:xlink declaration that is rebound away from the real XLink namespace', () => {
    const out = expectOk('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="urn:evil"><path d="M0 0"/></svg>');
    expect(out).not.toMatch(/urn:evil/i);
    expect(out).not.toMatch(/xmlns:xlink/i);
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('drops a foreign-namespace child element even though its localName is allowlisted', () => {
    // `<evil:g>` has `localName === 'g'` (allowlisted) but lives in the
    // attacker-controlled `urn:evil` namespace via its own `xmlns:evil`
    // declaration — a localName-only allowlist check lets it through.
    // Stripping just the `xmlns:evil` attribute is not sufficient either:
    // `XMLSerializer` re-derives and re-emits whatever namespace
    // declaration a prefixed element's own namespace requires regardless
    // of which attribute nodes survived, so the element itself must be
    // dropped.
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><evil:g xmlns:evil="urn:evil"><path d="M0 0"/></evil:g><rect x="0" y="0" width="1" height="1"/></svg>`);
    expect(out).not.toMatch(/evil/i);
    expect(out).not.toContain('<path');
    expect(out).toContain('<rect');
  });

  it('drops a child element whose default xmlns was overridden to a foreign namespace (no prefix)', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><g xmlns="urn:evil"><path d="M0 0"/></g><rect x="0" y="0" width="1" height="1"/></svg>`);
    expect(out).not.toMatch(/evil/i);
    expect(out).not.toContain('<path');
    expect(out).toContain('<rect');
  });

  it('neutralises a CSS-escape-obfuscated url()/@import inside <style> element text (real CSS tokenizers decode `\\72` to "r" before matching function names)', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><style>.x{fill:u\\72l(https://evil.example/a)}</style></svg>`);
    expect(out).not.toMatch(/evil\.example/i);
    expect(out).not.toMatch(/url\(\s*https:/i);
  });

  it('neutralises a CSS-escape-obfuscated @import inside <style> element text', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><style>\\40 import url(evil.css);.node{fill:#eee}</style></svg>`);
    expect(out).not.toMatch(/@?import/i);
    expect(out).not.toMatch(/evil\.css/i);
    expect(out).toContain('.node{fill:#eee}');
  });

  it('strips processing instructions', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><?xml-stylesheet href="evil.css" type="text/css"?><path d="M0 0"/></svg>`);
    expect(out).not.toMatch(/xml-stylesheet/i);
  });

  it('rejects a DOCTYPE declaration', () => {
    const result = sanitizeSvg(`<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg ${SVG_NS_ATTRS}>&xxe;</svg>`, STRICT);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed XML', () => {
    const result = sanitizeSvg('<svg><path></svg>', STRICT);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-svg root', () => {
    const result = sanitizeSvg('<div>not an svg</div>', STRICT);
    expect(result.ok).toBe(false);
  });

  it('rejects a root whose localName is "svg" but whose namespace is attacker-controlled (prefixed root)', () => {
    // `localName` alone would accept this: xmldom resolves it from the
    // QName's local part regardless of namespace, so an unvalidated
    // `localName === 'svg'` check lets `<evil:svg>` through unchanged,
    // retaining an attacker-controlled XML namespace structure.
    const result = sanitizeSvg('<evil:svg xmlns:evil="urn:evil"><evil:g/></evil:svg>', STRICT);
    expect(result.ok).toBe(false);
  });

  it('rejects a root whose namespace URI is not the SVG namespace even when unprefixed', () => {
    const result = sanitizeSvg('<svg xmlns="urn:evil"><g/></svg>', STRICT);
    expect(result.ok).toBe(false);
  });

  it('rejects a prefixed root even when the prefix legitimately resolves to the real SVG namespace', () => {
    // Namespace-correct but not the literal single `<svg>` root every
    // caller of this sanitizer treats as the invariant — the serialized
    // output would read `<svg:svg>...</svg:svg>`, not `<svg>...</svg>`.
    const result = sanitizeSvg('<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:g/></svg:svg>', STRICT);
    expect(result.ok).toBe(false);
  });

  it('strips xml:base on the root — otherwise it silently redirects a local #id fragment reference to an attacker-controlled external URL', () => {
    const out = expectOk(
      `<svg ${SVG_NS_ATTRS} xml:base="https://evil.example/"><defs><marker id="arrow"/></defs><use xlink:href="#arrow"/></svg>`,
      ALLOW_SAFE_HREF,
    );
    expect(out).not.toMatch(/xml:base/i);
    expect(out).not.toMatch(/evil\.example/i);
    // The local-fragment reference itself must survive unchanged — this
    // is a targeted strip of xml:base, not a regression on href handling.
    expect(out).toContain('xlink:href="#arrow"');
  });

  it('strips xml:base on a descendant element (XML Base composes through nested elements, not just the root)', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><g xml:base="https://evil.example/"><use xlink:href="#arrow"/></g></svg>`, ALLOW_SAFE_HREF);
    expect(out).not.toMatch(/xml:base/i);
    expect(out).not.toMatch(/evil\.example/i);
  });

  it('strips SMIL animation elements that historically smuggled javascript: via attribute animation', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><a href="#safe"><animate attributeName="xlink:href" values="javascript:alert(1)" /></a></svg>`, ALLOW_SAFE_HREF);
    expect(out).not.toMatch(/animate/i);
  });

  it('is idempotent', () => {
    const input = `<svg ${SVG_NS_ATTRS}><script>x</script><a href="javascript:y" onclick="z"></a></svg>`;
    const once = expectOk(input);
    const twice = expectOk(once);
    expect(twice).toBe(once);
  });
});

describe('sanitizeSvg — preserves legitimate content', () => {
  it('preserves local fragment references (#id) via use/xlink:href', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><defs><marker id="arrow"/></defs><use xlink:href="#arrow"/></svg>`);
    expect(out).toContain('xlink:href="#arrow"');
  });

  it('preserves https href when policy.allowSafeHref is true (PlantUML policy)', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><a href="https://example.com">x</a></svg>`, ALLOW_SAFE_HREF);
    expect(out).toContain('href="https://example.com"');
  });

  it('strips https href when policy.allowSafeHref is false (Mermaid strict policy)', () => {
    const out = expectOk(`<svg ${SVG_NS_ATTRS}><a href="https://example.com">x</a></svg>`, STRICT);
    expect(out).not.toContain('href="https://example.com"');
  });

  it('produces a single well-formed <svg> root and reports the sanitized SVG', () => {
    const result = sanitizeSvg(`<svg ${SVG_NS_ATTRS}><path d="M0 0"/></svg>`, STRICT);
    expect(result.ok).toBe(true);
  });
});

describe('sanitizeSvg — benign diagram-shaped regression corpus', () => {
  // Structurally representative of real Mermaid/PlantUML output (class-
  // based <style>, <marker> arrowheads via <defs>, grouped <g> nodes,
  // multi-<tspan> text labels, local-fragment <use>). The actual 8
  // diagram-type corpus (real `mermaid.render()` output) is exercised
  // end-to-end against this exact sanitizer in
  // `packages/plugin-renderer-mermaid/src/index.test.ts` — this package
  // stays free of a runtime dependency on `mermaid` itself (spec §9:
  // "MermaidともPlantUMLとも非対称な依存関係を作らない中立パッケージ").
  const FLOWCHART_SHAPED = [
    `<svg ${SVG_NS_ATTRS} viewBox="0 0 200 100">`,
    '<style>.node rect { fill: #eee; stroke: #333; } .edgeLabel { background: #fff; }</style>',
    '<defs><marker id="arrowhead" markerWidth="10" markerHeight="10"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>',
    '<g class="root">',
    '<g class="node" transform="translate(10,10)"><rect width="60" height="30"/><text x="30" y="18"><tspan>Start</tspan></text></g>',
    '<g class="edgePaths"><path marker-end="url(#arrowhead)" d="M40,40 L40,70"/></g>',
    '<use xlink:href="#arrowhead" x="5" y="5"/>',
    '</g>',
    '</svg>',
  ].join('');

  it('flowchart-shaped SVG survives sanitization with its structure intact', () => {
    const out = expectOk(FLOWCHART_SHAPED);
    expect(out).toContain('<svg');
    expect(out).toContain('class="node"');
    expect(out).toContain('<tspan>Start</tspan>');
    expect(out).toContain('marker-end="url(#arrowhead)"');
    expect(out).toContain('xlink:href="#arrowhead"');
    expect(out).toMatch(/^<svg[^]*<\/svg>$/);
  });

  it('plantuml-shaped SVG (safe https link) survives sanitization with its structure intact', () => {
    const plantumlShaped = [
      `<svg ${SVG_NS_ATTRS} viewBox="0 0 100 50">`,
      '<g><rect x="0" y="0" width="80" height="30" fill="#FEFECE"/><text x="10" y="20">Alice</text></g>',
      '<a href="https://plantuml.com"><text x="10" y="40">link</text></a>',
      '</svg>',
    ].join('');
    const out = expectOk(plantumlShaped, ALLOW_SAFE_HREF);
    expect(out).toContain('<rect');
    expect(out).toContain('Alice');
    expect(out).toContain('href="https://plantuml.com"');
  });
});
