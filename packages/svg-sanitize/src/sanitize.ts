import type { Attr, Element } from '@xmldom/xmldom';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { SanitizeSvgPolicy } from './policy';

export type SanitizeSvgResult = { ok: true; svg: string } | { ok: false; reason: string };

/**
 * DOM-based SVG sanitizer shared by `@crowi/plugin-renderer-mermaid` and
 * (from Phase 3) `@crowi/plugin-renderer-plantuml`. Spec §2 layer 2 / §9.
 *
 * Design: allowlist-first for elements (unknown/unexpected element names
 * are dropped with their whole subtree — safer than trying to enumerate
 * every dangerous tag), then a small set of attribute-level rules that
 * apply uniformly to every surviving element. This is a from-scratch DOM
 * walk, not a regex pass (`packages/plugin-renderer-plantuml/src/
 * sanitize.ts`'s existing implementation is explicitly documented there
 * as "not a substitute for DOMPurify" — this package is the replacement
 * both renderers converge on, PlantUML starting Phase 3).
 *
 * What gets removed:
 *   - Any element not in `ALLOWED_ELEMENTS` (`script`, `foreignObject`,
 *     `iframe`, `object`, `embed`, SMIL `animate*`/`set`/`discard`, ...) —
 *     dropped together with its entire subtree.
 *   - `on*` event-handler attributes (any casing).
 *   - The `style` attribute (inline styles). Mermaid/PlantUML's real
 *     styling lives in the `<style>` *element* (class-based), which is
 *     sanitized separately below rather than dropped — dropping inline
 *     `style=""` is a deliberate hardening tradeoff (removes a CSS-value
 *     injection vector) the regression tests confirm does not break
 *     either renderer's *structural* output.
 *   - `@import` at-rules and non-local-fragment `url(...)` function
 *     values inside `<style>` element text content (external stylesheet
 *     / font / image loads) — see `sanitizeStyleText` below for why the
 *     element itself is not dropped wholesale.
 *   - `xmlns` / `xmlns:*` declarations on any non-root element (namespace
 *     declarations only ever legitimately live on the root `<svg>`).
 *   - Any root-level `xmlns:*` declaration other than a correctly-bound
 *     `xmlns:xlink` (see `isEssentialRootNamespaceDeclaration`). These are
 *     already functionally inert under the strict unprefixed-SVG-element
 *     invariant enforced elsewhere in this file, but are dropped anyway
 *     as defence-in-depth against relying on that invariant alone.
 *   - `xml:base` on any element (root or descendant). Left in place, it
 *     would silently change the base URI every *local-fragment* `href` /
 *     `xlink:href` / `url(#id)` reference in its subtree resolves
 *     against — turning an in-document `#id` reference into an external
 *     `https://evil.example/#id` fetch some SVG consumers follow,
 *     defeating the local-fragment-only guarantees above even though
 *     every individual `href`/`url()` value still looks safe in
 *     isolation.
 *   - `ProcessingInstruction` nodes anywhere in the tree
 *     (`<?xml-stylesheet ...?>` etc).
 *   - `href` / `xlink:href` values that are not a local fragment
 *     reference (`#id`) and not allowed by `policy.allowSafeHref`.
 *     `javascript:`, `data:`, and protocol-relative (`//...`) values are
 *     ALWAYS stripped regardless of policy.
 *   - `url(...)` references inside SVG *presentation attributes* that
 *     accept a `<FuncIRI>` (`fill`, `stroke`, `filter`, `clip-path`,
 *     `mask`, `cursor`, `marker-start`, `marker-mid`, `marker-end`) when
 *     the reference target is not a local fragment (`#id`) — e.g.
 *     `fill="url(https://evil.example/paint.svg)"` or
 *     `filter="url(data:image/svg+xml;base64,...)"`. These are the same
 *     class of external-resource load as `href`/`style` but reachable via
 *     a different attribute name, so they get the same href-style
 *     drop-the-attribute treatment. `url(#localId)` references (the
 *     normal way Mermaid/PlantUML wire arrowhead markers and gradients)
 *     are always preserved.
 *
 * What is explicitly preserved:
 *   - `href` / `xlink:href` local fragment references (`#id`) — legitimate
 *     internal `<use>` / gradient / clip-path wiring.
 *   - `https:` `href` values when `policy.allowSafeHref` is `true`.
 *   - `url(#id)` local fragment references in presentation attributes
 *     (`fill="url(#gradient)"`, `marker-end="url(#arrowhead)"`, ...).
 *
 * A parse failure (malformed XML) or a sanitized result whose root is not
 * a single `<svg>` element both return `{ ok: false }` — callers must
 * treat that as "invalid output" (spec §2 layer 2), never fall back to
 * the unsanitized input.
 */
export function sanitizeSvg(input: string, policy: SanitizeSvgPolicy): SanitizeSvgResult {
  const doc = parseXml(input);
  if (!doc) return { ok: false, reason: 'malformed_xml' };

  if (doc.doctype) {
    // Legitimate Mermaid/PlantUML output never carries a DOCTYPE. Reject
    // outright rather than trying to strip it — a DOCTYPE is a plausible
    // XXE / entity-expansion vector this sanitizer does not otherwise
    // need to reason about.
    return { ok: false, reason: 'doctype_not_allowed' };
  }
  const root = doc.documentElement;
  if (!isUnprefixedSvgElement(root)) {
    return { ok: false, reason: 'root_is_not_svg' };
  }

  sanitizeElementTree(root, policy, true);

  const serializer = new XMLSerializer();
  const serialized = serializer.serializeToString(root);

  // Defensive re-parse: confirm the sanitized string round-trips back to
  // a single well-formed <svg> root. Should be unreachable in practice
  // (we only ever removed nodes/attributes from an already-well-formed
  // tree) but this is the actual mechanical check spec §2 requires
  // ("サニタイズ後のルートが厳密に単一の<svg>であることを検証").
  const verifyDoc = parseXml(serialized);
  if (!verifyDoc || !isUnprefixedSvgElement(verifyDoc.documentElement)) {
    return { ok: false, reason: 'sanitized_output_not_single_root_svg' };
  }

  return { ok: true, svg: serialized };
}

const SVG_NAMESPACE_URI = 'http://www.w3.org/2000/svg';

/**
 * The `xml:` prefix is permanently bound to this namespace URI by the XML
 * Namespaces spec — `@xmldom/xmldom` resolves it even with no explicit
 * `xmlns:xml` declaration in the source (verified empirically), so a
 * namespace-URI check here is exactly as robust as the
 * `isSvgNamespaceElement` check above, not a name-string match an
 * attacker could route around by declaring `xml` to mean something else
 * (they can't — `xml`/`xmlns` are the two prefixes XML forbids rebinding).
 */
const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';

/**
 * The one non-SVG namespace Mermaid/PlantUML output legitimately
 * references: `xlink:href` (`<use xlink:href="#id">` local-fragment
 * wiring — see `sanitizeAttributes`'s `localName === 'href'` branch,
 * which sanitizes the value by localName regardless of namespace, so
 * this URI is only consulted here for the root `xmlns:xlink` allowlist
 * check below, not for attribute-value sanitization itself).
 */
const XLINK_NAMESPACE_URI = 'http://www.w3.org/1999/xlink';

/**
 * An element genuinely belongs to the (unprefixed) SVG namespace.
 * `localName` alone is not enough: `@xmldom/xmldom` resolves `localName`
 * from the QName's local part regardless of namespace, so `<evil:g
 * xmlns:evil="urn:evil">` also has `localName === 'g'` while actually
 * living in an attacker-controlled namespace — and stripping only the
 * `xmlns:evil` declaration does not help, because `XMLSerializer`
 * re-derives and re-emits whatever namespace declaration a prefixed
 * element's own namespace requires, regardless of which attribute nodes
 * survived sanitization (verified empirically: removing the `xmlns:evil`
 * attribute node still serializes `<evil:g xmlns:evil="urn:evil"/>`).
 * The only correct defense is to never allow-list a foreign-namespace or
 * prefixed element by localName in the first place.
 */
function isSvgNamespaceElement(el: Element): boolean {
  return el.namespaceURI === SVG_NAMESPACE_URI && el.prefix == null;
}

/**
 * The root (and only the root — see the invariant this guards) must be a
 * literal, unprefixed `<svg>` element in the SVG namespace (even when the
 * namespace URI legitimately resolves to the SVG namespace via a
 * `<svg:svg xmlns:svg="...">`-style prefix, the serialized output would
 * read `<svg:svg>...</svg:svg>`, not the literal `<svg>` single-root
 * output every caller of this sanitizer treats as the invariant).
 */
function isUnprefixedSvgElement(el: Element | null | undefined): el is Element {
  return el != null && el.localName === 'svg' && isSvgNamespaceElement(el);
}

/**
 * Parse an XML string with `@xmldom/xmldom`. Returns `null` on any
 * malformed input — `DOMParser.parseFromString` throws a `ParseError` for
 * fatal issues (mismatched tags, unbound namespace prefixes, ...) rather
 * than the browser convention of returning a document with a synthetic
 * `<parsererror>` element, so this wraps that in a try/catch. `onError`
 * is always supplied (even though we only act on the thrown case) to
 * suppress xmldom's default behaviour of printing warnings to stderr.
 */
function parseXml(source: string) {
  try {
    return new DOMParser({ onError: () => undefined }).parseFromString(source, 'image/svg+xml');
  } catch {
    return null;
  }
}

/**
 * SVG (+ common filter primitive) elements Mermaid/PlantUML output
 * legitimately uses. Anything else is dropped with its subtree —
 * notably `script`, `foreignObject`, `iframe`, `object`, `embed`, `link`,
 * `meta`, `base`, and the SMIL animation elements (`animate`,
 * `animateMotion`, `animateTransform`, `animateColor`, `set`,
 * `discard` — historically abused to smuggle `javascript:` into an
 * `href` via attribute animation).
 */
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'metadata',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'tref',
  'marker',
  'clipPath',
  'mask',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
  'image',
  'style',
  'a',
  'switch',
  'filter',
  'feGaussianBlur',
  'feOffset',
  'feMerge',
  'feMergeNode',
  'feColorMatrix',
  'feComposite',
  'feFlood',
  'feBlend',
  'feDropShadow',
  'feMorphology',
  'feTurbulence',
  'feDisplacementMap',
]);

const PROCESSING_INSTRUCTION_NODE = 7;
const ELEMENT_NODE = 1;

function sanitizeElementTree(el: Element, policy: SanitizeSvgPolicy, isRoot: boolean): void {
  sanitizeAttributes(el, policy, isRoot);

  if (el.localName === 'style') {
    // `<style>` carries CSS text, not element children — sanitize the
    // text content in place and stop (no element subtree to walk).
    el.textContent = sanitizeStyleText(el.textContent ?? '');
    return;
  }

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === PROCESSING_INSTRUCTION_NODE) {
      el.removeChild(child);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue; // text / comment / cdata — left as-is
    const childEl = child as Element;
    // Both the localName allowlist AND the SVG-namespace/no-prefix check
    // are required (spec §2/AC1) — a foreign-namespace element such as
    // `<evil:g xmlns:evil="urn:evil">` has `localName === 'g'` and would
    // otherwise pass the allowlist unchanged, retaining an
    // attacker-controlled XML namespace structure in the output.
    if (!isSvgNamespaceElement(childEl) || !ALLOWED_ELEMENTS.has(childEl.localName ?? childEl.nodeName)) {
      el.removeChild(childEl);
      continue;
    }
    sanitizeElementTree(childEl, policy, false);
  }
}

function sanitizeAttributes(el: Element, policy: SanitizeSvgPolicy, isRoot: boolean): void {
  for (const attr of Array.from(el.attributes)) {
    const localName = attr.localName ?? attr.name;
    if (/^on/i.test(localName)) {
      el.removeAttributeNode(attr);
      continue;
    }
    if (localName === 'style') {
      el.removeAttributeNode(attr);
      continue;
    }
    if (localName === 'base' && attr.namespaceURI === XML_NAMESPACE_URI) {
      // `xml:base` changes the effective base URI every relative
      // reference in its subtree (including this file's own
      // local-fragment-only `href`/`xlink:href`/`url(#id)` values)
      // resolves against — an attacker-controlled `xml:base` on the
      // root defeats the "fragment references are always local"
      // guarantee those checks otherwise provide, since `href="#id"`
      // combined with `xml:base="https://evil.example/"` resolves to
      // `https://evil.example/#id`, a reference some SVG
      // consumers/viewers follow as an external document fetch. Strip
      // it everywhere (not just the root — XML Base composes through
      // nested `xml:base` on descendant elements too), unconditionally
      // (no policy ever legitimately needs it; neither Mermaid nor
      // PlantUML output ever emits it).
      el.removeAttributeNode(attr);
      continue;
    }
    if (localName === 'href') {
      const sanitizedValue = sanitizeHrefValue(attr.value, policy);
      if (sanitizedValue === null) {
        el.removeAttributeNode(attr);
      } else {
        attr.value = sanitizedValue;
      }
      continue;
    }
    if (URL_VALUED_PRESENTATION_ATTRS.has(localName)) {
      if (!isUrlFuncIriSafe(attr.value)) {
        el.removeAttributeNode(attr);
      }
      continue;
    }
    if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) {
      if (!isRoot || !isEssentialRootNamespaceDeclaration(attr)) {
        el.removeAttributeNode(attr);
      }
    }
  }
}

/**
 * Root namespace declarations this sanitizer keeps: the default `xmlns`
 * (already guaranteed to be exactly `SVG_NAMESPACE_URI` by
 * `isUnprefixedSvgElement`'s root check — a document that reaches this
 * function with any other default namespace, or none, was already
 * rejected before sanitization started) and `xmlns:xlink` when it is
 * correctly bound to the real XLink namespace.
 *
 * Every other root `xmlns:*` declaration (`xmlns:evil="urn:evil"`, or
 * even `xmlns:xlink` rebound to a non-XLink URI) is already functionally
 * inert: `isSvgNamespaceElement` / the `ALLOWED_ELEMENTS` walk only ever
 * admits unprefixed SVG-namespace elements, and attribute handling
 * (`href`, `xml:base`, ...) matches by `localName`, not by which prefix
 * declares which namespace. Stripping these nonessential declarations
 * anyway is defence-in-depth against relying solely on that invariant,
 * and avoids serializing an attacker-chosen namespace URI string in the
 * output at all.
 */
function isEssentialRootNamespaceDeclaration(attr: Attr): boolean {
  if (attr.name === 'xmlns') return true;
  return attr.name === 'xmlns:xlink' && attr.value === XLINK_NAMESPACE_URI;
}

/**
 * SVG presentation attributes whose value grammar is (or includes) a
 * `<FuncIRI>` — `url(...)` — reference: https://www.w3.org/TR/SVG11/types.html#DataTypeFuncIRI.
 * A CSS-style external resource load is reachable through any of these,
 * not just `href`, so they all get the same local-fragment-only policy.
 */
const URL_VALUED_PRESENTATION_ATTRS = new Set([
  'fill',
  'stroke',
  'filter',
  'clip-path',
  'mask',
  'cursor',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
]);

const URL_FUNC_PATTERN = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/**
 * A presentation-attribute value is safe when it either contains no
 * `url(...)` reference at all (the common case — a plain keyword/color
 * like `fill="none"` or `stroke="#333333"`), or every `url(...)`
 * reference it does contain targets a local fragment (`#id`). Any
 * external/`data:`/protocol-relative target makes the whole attribute
 * unsafe and it is dropped (mirrors `sanitizeHrefValue`'s treatment of
 * `href`).
 */
function isUrlFuncIriSafe(rawValue: string): boolean {
  // Decode CSS escapes first — same rationale as `sanitizeStyleText`'s
  // `cssUnescape` call: a browser's CSS value parser (which is what actually
  // interprets a `<FuncIRI>`-valued presentation attribute) decodes `\72` to
  // "r" before matching the `url(` function name, so `u\72l(` and `url(` are
  // the same token to it even though they're different substrings to a naive
  // regex on the raw attribute text.
  const matches = Array.from(cssUnescape(rawValue).matchAll(URL_FUNC_PATTERN));
  if (matches.length === 0) return true;
  return matches.every(([, , target]) => target.trim().startsWith('#'));
}

/** Returns the sanitized value to keep, or `null` if the attribute must be dropped. */
function sanitizeHrefValue(rawValue: string, policy: SanitizeSvgPolicy): string | null {
  const value = rawValue.trim();
  if (value.startsWith('#')) return value; // local fragment reference — always safe, always kept
  if (/^javascript:/i.test(value)) return null;
  if (/^data:/i.test(value)) return null;
  if (value.startsWith('//')) return null; // protocol-relative
  if (policy.allowSafeHref && /^https:\/\//i.test(value)) return value;
  return null;
}

/**
 * Sanitize a `<style>` element's CSS text content in place: strip CSS
 * comments first (so a comment-split token like `u/*x*` + `/rl(...)`
 * can't defeat the pattern matches below), remove every `@import`
 * at-rule (external stylesheet loads), and neutralise every `url(...)`
 * function value UNLESS its target is a local fragment reference
 * (`#id`) — the exact same local-fragment-only policy
 * `isUrlFuncIriSafe` applies to `fill`/`stroke`/... presentation
 * attributes above, reused here (`URL_FUNC_PATTERN`) rather than
 * re-deriving a second rule for CSS text.
 *
 * Full `<style>`-element removal (drop it like `script`/`foreignObject`
 * instead of sanitizing its text) was considered and rejected: real
 * Mermaid output (`mermaid@11`, `theme:'base'`, the only theme layer 1
 * ever configures) carries essentially ALL of a diagram's visual
 * styling — node fills, edge strokes, text color — as class-based rules
 * inside this element; the shapes themselves carry no `fill`/`stroke`
 * presentation attributes of their own. Dropping the element wholesale
 * does not keep the diagram "structurally intact" (this file's own
 * regression-corpus requirement) so much as make it illegible (every
 * shape defaults to solid black fill, text indistinguishable from its
 * background) — worse for spec §2's "良性出力を壊さない" guarantee than
 * the CSS-injection risk this function closes. That risk is also
 * already closed upstream for Mermaid: the only realistic vector for
 * attacker-controlled `<style>` content is Mermaid's `themeCSS` /
 * `%%{init:...}%%` config, and layer 1's forced init config (never
 * overridable per-call) plus `reject-patterns.ts`'s full-source scan
 * reject ANY `%%{init:...}%%` / frontmatter directive before rendering
 * is even attempted — this function is defence-in-depth for the
 * residual case (an unknown Mermaid CSS-injection vector, or a
 * different generation path once PlantUML (Phase 3) starts sharing this
 * sanitizer), so it stays surgical like every other rule in this file
 * rather than a blunt drop of otherwise-legitimate output.
 *
 * Decodes CSS escape sequences (`sanitize.test.ts`'s `u\72l(...)` vector)
 * BEFORE the `@import`/`url(...)` pattern matches run — real CSS
 * tokenizers interpret `\72` as the code point `U+0072` ("r") at the
 * character-stream level, before any keyword/function-name matching
 * happens, so `u\72l(` and `url(` are the same token to a browser/CSS
 * engine even though they are different substrings to a naive regex.
 * Matching only the raw (still-escaped) text would let that exact
 * class of obfuscation through unneutralized.
 */
function sanitizeStyleText(css: string): string {
  // Comments are token separators in real CSS (`@import/**/url(x)` tokenizes
  // the same as `@import url(x)`) — replace with a single space, not an
  // empty string, or a comment sitting between two keyword fragments would
  // splice them into one unmatched token (`@import` + `url` -> `importurl`)
  // and defeat the `@import` match below instead of merely hiding it.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  let out = cssUnescape(withoutComments);
  out = out.replace(/@import\b[^;]*;?/gi, '');
  out = out.replace(URL_FUNC_PATTERN, (match, _quote, target) => (target.trim().startsWith('#') ? match : 'none'));
  return out;
}

/**
 * Decode CSS escape sequences (https://www.w3.org/TR/css-syntax-3/#consume-escaped-code-point):
 * a backslash followed by 1-6 hex digits (optionally followed by one
 * whitespace character, consumed as part of the escape) represents that
 * Unicode code point; a backslash followed by any other single character
 * (not a hex digit, not a newline) represents that character literally.
 * This is intentionally a normalizing pass, not a format-preserving one
 * — output text that used escapes comes back decoded, which is fine for
 * a security sanitizer (real Mermaid/PlantUML `<style>` output never
 * contains CSS escapes in practice, so benign output is unaffected).
 */
function cssUnescape(css: string): string {
  return css.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\f\r]?|\\([^\r\n\f])|\\$/g, (_match, hex: string | undefined, literal: string | undefined) => {
    if (hex !== undefined) {
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '�';
      return String.fromCodePoint(codePoint);
    }
    if (literal !== undefined) return literal;
    return '�'; // a lone trailing backslash at end-of-string
  });
}
