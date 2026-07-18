/**
 * `sanitize-svg.ts` is a thin adapter with no sanitization logic of its
 * own (spec §1) — `@crowi/plugin-renderer-svg-sanitize`'s own test suite
 * (`packages/plugin-renderer-svg-sanitize/src/sanitize.test.ts`) is where
 * the sanitizer's *rules* are exhaustively covered. This file's job is
 * narrower but still load-bearing: prove the Mermaid package's own wiring
 * — `sanitizeMermaidSvg` calling the shared sanitizer with the strict
 * (`allowSafeHref: false`) policy — actually rejects the malicious
 * root-namespace vectors and preserves a benign diagram, so a future
 * change to this adapter (e.g. accidentally flipping the policy, or
 * swapping the shared sanitizer for something else) is caught here, not
 * only in the shared package's own suite. `index.test.ts` covers the
 * same invariant end-to-end through real `mermaid.render()` output (which
 * can never itself carry an attacker-controlled root namespace — Mermaid
 * always emits a genuine `<svg xmlns="...">`), so the malicious-root
 * vectors specifically must be exercised here, at the adapter level,
 * where a raw SVG string can be handed in directly.
 */
import { sanitizeMermaidSvg } from './sanitize-svg';

const SVG_NS_ATTRS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

describe('sanitizeMermaidSvg — Mermaid-package wiring over the shared sanitizer', () => {
  it('preserves a benign, diagram-shaped SVG with its structure intact (regression)', () => {
    const benign = [
      `<svg ${SVG_NS_ATTRS} viewBox="0 0 200 100">`,
      '<style>.node rect { fill: #eee; stroke: #333; }</style>',
      '<defs><marker id="arrowhead"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>',
      '<g class="node" transform="translate(10,10)"><rect width="60" height="30"/><text x="30" y="18"><tspan>Start</tspan></text></g>',
      '<path marker-end="url(#arrowhead)" d="M40,40 L40,70"/>',
      '</svg>',
    ].join('');
    const result = sanitizeMermaidSvg(benign);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).toContain('<style>');
    expect(result.svg).toContain('class="node"');
    expect(result.svg).toContain('<tspan>Start</tspan>');
    expect(result.svg).toContain('marker-end="url(#arrowhead)"');
    expect(result.svg).toMatch(/^<svg[^]*<\/svg>$/);
  });

  it('rejects a root whose localName is "svg" but whose namespace is attacker-controlled (prefixed root)', () => {
    const result = sanitizeMermaidSvg('<evil:svg xmlns:evil="urn:evil"><evil:g/></evil:svg>');
    expect(result.ok).toBe(false);
  });

  it('rejects a root whose namespace URI is not the SVG namespace even when unprefixed', () => {
    const result = sanitizeMermaidSvg('<svg xmlns="urn:evil"><g/></svg>');
    expect(result.ok).toBe(false);
  });

  it('rejects a prefixed root even when the prefix legitimately resolves to the real SVG namespace', () => {
    const result = sanitizeMermaidSvg('<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:g/></svg:svg>');
    expect(result.ok).toBe(false);
  });

  it('applies the strict (allowSafeHref: false) policy — even a safe https href does not survive', () => {
    const result = sanitizeMermaidSvg(`<svg ${SVG_NS_ATTRS}><a href="https://example.com"><text x="0" y="0">link</text></a></svg>`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).not.toContain('href="https://example.com"');
  });
});
