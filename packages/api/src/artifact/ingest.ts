/**
 * RFC-0020 Phase 2a-1 — the pure boundary that decides whether an author's
 * HTML/CSS/inline-script "artifact" document may be stored, and if so,
 * returns the exact bytes to persist. This module knows nothing about
 * Page/Revision/HTTP; callers own the create/update/revert plumbing and the
 * HTTP envelope.
 *
 * The rule table (`ARTIFACT_INGEST_RULES`) is the single source of truth for
 * validation: every check is a data row (pass/source/priority/result), and
 * `runArtifactRules` is the only place that walks the table. The comments
 * here explain *why* a given line exists, not what the table already says.
 */

import { createHash } from 'node:crypto';
import { createJiti } from 'jiti';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { init as esModuleLexerInit, parse as parseEsModules, ImportType } from 'es-module-lexer';
import type { DefaultTreeAdapterMap, DefaultTreeAdapterTypes, TreeAdapter } from 'parse5';
import type { ArtifactIngestRejectionReason } from '@crowi/api-contract';
import {
  ARTIFACT_HARD_MAX_BYTES,
  ARTIFACT_MIN_MAX_BYTES,
  ARTIFACT_SCRIPT_DIGEST_META_NAME,
  ARTIFACT_STYLE_DIGEST_META_NAME,
  countOccurrences,
} from './constants';

// ---------------------------------------------------------------------------
// Namespaces (hardcoded rather than read from the loaded parse5 module: the
// `Parse5Runtime` pick below deliberately excludes the `html` namespace
// export, and these three URIs are stable web-platform constants).
// ---------------------------------------------------------------------------

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const ARTIFACT_NODE_BUDGET = 50_000;
export const ARTIFACT_MAX_TREE_DEPTH = 128;
export const ARTIFACT_CSS_MAX_BYTES = 1024 * 1024;
export const ARTIFACT_CSS_MAX_TOKENS = 300_000;
export const ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT = 100;
export const ARTIFACT_MAX_TOTAL_ATTRIBUTES = 100_000;
const ARTIFACT_CSS_MAX_PAREN_DEPTH = 64;
const ARTIFACT_CSS_MAX_VALUE_NODES = 100_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArtifactIngestOptions {
  source: 'author' | 'stored-revision';
  allowWebFonts: boolean;
  maxBytes: number;
}

export type ArtifactIngestResult =
  | { ok: true; bytes: Uint8Array; scriptDigests: readonly string[]; styleDigests: readonly string[] }
  | { ok: false; rejection: ArtifactIngestRejection };

export type ArtifactValidationPass = 'pre-parse' | 'source' | 'normalized';
export type ArtifactInputSource = 'author' | 'stored-revision';
export type ArtifactRuleId =
  | 'AI-R01'
  | 'AI-R01a'
  | 'AI-R02'
  | 'AI-R03'
  | 'AI-R04'
  | 'AI-R05'
  | 'AI-R07'
  | 'AI-R07a'
  | 'AI-R08'
  | 'AI-R09'
  | 'AI-R11'
  | 'AI-R11a'
  | 'AI-R11b'
  | 'AI-R12'
  | 'AI-R13'
  | 'AI-R14'
  | 'AI-R15'
  | 'AI-R16'
  | 'AI-R17'
  | 'AI-R18'
  | 'AI-R19'
  | 'AI-R20a'
  | 'AI-R20b'
  | 'AI-R20c'
  | 'AI-R21'
  | 'AI-R22';

export interface ArtifactRuleFailure {
  readonly target?: string;
}

export interface ArtifactWriteFailure {
  readonly ruleId: ArtifactRuleId | 'AI-D01' | 'AI-D02' | 'AI-D03';
  readonly reason: ArtifactIngestRejectionReason;
  readonly httpStatus: 400 | 413 | 422;
  readonly target?: string;
}

export interface ArtifactIngestRejection extends ArtifactWriteFailure {
  readonly ruleId: ArtifactRuleId;
}

export type ArtifactParseMode = 'source' | 'normalized';

export interface ParsedArtifactDocument {
  readonly document: DefaultTreeAdapterTypes.Document;
  /** Collected parse5 error codes. Message and source location never leave this module. */
  readonly parseErrorCodes: readonly string[];
  /**
   * Reserved digest markers stripped from the direct children of `<head>`
   * during a `'source'`-mode parse (recorded in tree order, always empty for
   * `'normalized'`-mode parses — see step 3 of the algorithm).
   */
  readonly removedReservedMarkers: readonly Readonly<{ name: string; attributeNames: readonly string[] }>[];
}

export type ArtifactTreeNode = DefaultTreeAdapterTypes.Node | DefaultTreeAdapterTypes.DocumentFragment;

export interface ArtifactRuleContext {
  readonly pass: ArtifactValidationPass;
  readonly source: ArtifactInputSource;
  /** The exact text `parsed.document` was parsed from for this pass (the raw author input pre-parse; the BOM/newline-normalized text for `'source'`; the step-6 `serialized` string for `'normalized'` — see `checkAiR22`, which relies on the last of these). */
  readonly input: string;
  readonly options: Readonly<ArtifactIngestOptions>;
  readonly parsed?: ParsedArtifactDocument;
  readonly ownership: Readonly<{ exemptReservedMarker: boolean }>;
}

export type ArtifactRuleCheck = (context: Readonly<ArtifactRuleContext>, definition: Readonly<ArtifactRuleDefinition>) => Promise<ArtifactRuleFailure | null>;

export interface ArtifactOwnedExemption {
  kind: 'normalizer-marker';
}

export interface ArtifactRuleDefinition {
  id: ArtifactRuleId;
  check: ArtifactRuleCheck;
  passes: readonly ArtifactValidationPass[];
  sources: readonly ('author' | 'stored-revision')[];
  ownedExemptions: readonly ArtifactOwnedExemption[];
  priority: number;
  result: Readonly<{ reason: ArtifactIngestRejectionReason; httpStatus: 400 | 413 }>;
}

export type Parse5Runtime = Readonly<Pick<typeof import('parse5'), 'parse' | 'serialize' | 'defaultTreeAdapter' | 'ErrorCodes' | 'Parser' | 'Tokenizer'>>;

export class ArtifactNodeBudgetExceeded extends Error {}

export class ArtifactInternalError extends Error {}

export type ArtifactInternalErrorResponse = { error: { code: 'INTERNAL_ERROR'; message: 'Internal server error' } };

// ---------------------------------------------------------------------------
// Test seam
//
// `postcss-value-parser`'s export is a bare function (no property for
// `jest.spyOn` to intercept), and under `isolatedModules` TS emits direct
// identifier references for module-scoped `const` imports, so a plain
// `postcss.parse(...)` call site is also immune to `jest.spyOn(postcss,
// 'parse')` patched from a different module instance in some bundling
// configurations. Routing the few calls the resource-guard tests need to
// assert "never ran" through one indirection object keeps the CSS analyzer
// and the pre-parse byte guard spy-able without full `jest.mock(...)`
// module replacement (which would also disable the real parser for the
// tests that DO need real CSS parsing in the same file).
// ---------------------------------------------------------------------------

export const artifactParserSeam = {
  parseStylesheet: (css: string) => postcss.parse(css),
  parseValue: (value: string) => valueParser(value),
  normalizeNewlines: (text: string) => text.replace(/\r\n|\r/g, '\n'),
  encodeArtifactBytes: (serialized: string) => new TextEncoder().encode(serialized),
};

// ---------------------------------------------------------------------------
// parse5 loading (ESM-only dependency — see spec §module の読み込み)
// ---------------------------------------------------------------------------

let cachedParse5Runtime: Parse5Runtime | null = null;

export function loadParse5Runtime(): Parse5Runtime {
  if (cachedParse5Runtime) return cachedParse5Runtime;
  const jiti = createJiti(__filename, { interopDefault: true });
  const mod = jiti('parse5') as typeof import('parse5');
  cachedParse5Runtime = {
    parse: mod.parse,
    serialize: mod.serialize,
    defaultTreeAdapter: mod.defaultTreeAdapter,
    ErrorCodes: mod.ErrorCodes,
    Parser: mod.Parser,
    Tokenizer: mod.Tokenizer,
  };
  return cachedParse5Runtime;
}

const DOCTYPE_ERROR_CODES_CACHE = new WeakMap<Parse5Runtime['ErrorCodes'], ReadonlySet<string>>();

/**
 * Derives the doctype-related parse5 error codes from the `ErrorCodes`
 * enum instead of a hand-written allowlist, so a parse5 upgrade that adds a
 * new doctype error code is picked up automatically rather than silently
 * falling through to AI-R03's generic `HTML_PARSE_ERROR`.
 */
export function isDoctypeParseError(code: string, runtime: Parse5Runtime = loadParse5Runtime()): boolean {
  let set = DOCTYPE_ERROR_CODES_CACHE.get(runtime.ErrorCodes);
  if (!set) {
    set = new Set(Object.values<string>(runtime.ErrorCodes).filter((value) => value.includes('doctype')));
    DOCTYPE_ERROR_CODES_CACHE.set(runtime.ErrorCodes, set);
  }
  return set.has(code);
}

// ---------------------------------------------------------------------------
// Budget-guarded tokenizer/parser (AI-R02)
//
// parse5 marks `Parser`/`Tokenizer` `@internal` (not semver-protected), so
// this is a deliberate internal dependency pinned by an exact version
// (`packages/api/package.json`: `"parse5": "8.0.1"`, no caret) and guarded
// by the AC-AI-8 tokenizer-boundary tests. Update procedure: bump the
// pinned version, re-run those tests, and only then relax the pin.
// ---------------------------------------------------------------------------

/**
 * parse5's `Parser<T extends TreeAdapterTypeMap>` is generic; subclassing it
 * via a value obtained through `loadParse5Runtime()` (rather than a
 * statically-imported, type-argument-bound reference) needs a narrower,
 * non-generic surface to extend from. This is exactly the subset the
 * subclass actually touches (`options` to hand to the tokenizer, the
 * mutable `tokenizer` field, and the static `parse` entry point used
 * throughout this module) — a deliberately loose re-typing of an
 * already-`@internal` API, not a claim that this is `Parser`'s full shape.
 */
interface ArtifactParserInstance {
  options: Readonly<Record<string, unknown>>;
  tokenizer: InstanceType<Parse5Runtime['Tokenizer']>;
  readonly document: DefaultTreeAdapterTypes.Document;
}
export interface ArtifactParserConstructor {
  new (options?: Readonly<Record<string, unknown>>): ArtifactParserInstance;
  parse(input: string, options?: Readonly<Record<string, unknown>>): DefaultTreeAdapterTypes.Document;
}

export interface ArtifactBudgetClasses {
  readonly Parser: ArtifactParserConstructor;
}

let cachedBudgetClasses: ArtifactBudgetClasses | null = null;

/** Exported for `ingest.test.ts`'s AC-AI-8 tokenizer-guard invariant tests only — production code always goes through `parseArtifactDocument`. */
export function getArtifactBudgetClasses(runtime: Parse5Runtime): ArtifactBudgetClasses {
  if (cachedBudgetClasses) return cachedBudgetClasses;

  class ArtifactBudgetTokenizer extends runtime.Tokenizer {
    private lastCountedToken: unknown = null;
    private observedAttrsForCurrentTag = 0;

    protected override _leaveAttrName(): void {
      if (this.currentToken !== this.lastCountedToken) {
        this.lastCountedToken = this.currentToken;
        this.observedAttrsForCurrentTag = 0;
      }
      this.observedAttrsForCurrentTag += 1;
      if (this.observedAttrsForCurrentTag > ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT) {
        throw new ArtifactNodeBudgetExceeded();
      }
      super._leaveAttrName();
    }
  }

  const BaseParser = runtime.Parser as unknown as ArtifactParserConstructor;

  class ArtifactBudgetParser extends BaseParser {
    constructor(options?: Readonly<Record<string, unknown>>) {
      super(options);
      this.tokenizer = new ArtifactBudgetTokenizer(this.options as never, this as never) as InstanceType<Parse5Runtime['Tokenizer']>;
    }
  }

  cachedBudgetClasses = { Parser: ArtifactBudgetParser };
  return cachedBudgetClasses;
}

// ---------------------------------------------------------------------------
// Counting tree adapter (AI-R02 during-parse guard)
// ---------------------------------------------------------------------------

export function createCountingTreeAdapter(
  runtime: Parse5Runtime,
  limits: Readonly<{ nodeBudget: number; maxDepth: number; maxTotalAttributes: number }>,
): TreeAdapter<DefaultTreeAdapterMap> {
  const base = runtime.defaultTreeAdapter;
  let nodeCount = 0;
  let totalAttributes = 0;
  const depths = new WeakMap<object, number>();

  const bumpNodeCount = () => {
    nodeCount += 1;
    if (nodeCount > limits.nodeBudget) throw new ArtifactNodeBudgetExceeded();
  };

  const recordDepth = (node: object, depth: number) => {
    depths.set(node, depth);
    if (depth > limits.maxDepth) throw new ArtifactNodeBudgetExceeded();
  };

  // `template` elements attach their content fragment to `.content` BEFORE
  // the element itself is attached to the tree (parse5 calls
  // `setTemplateContent` ahead of `appendChild`/`insertBefore` — see
  // `parser/index.js`), so the content fragment's depth can only be derived
  // once we know where the template element itself lands.
  const anchorTemplateContentDepth = (node: unknown, elementDepth: number) => {
    if (node !== null && typeof node === 'object' && 'content' in node) {
      const content = (node as { content?: object }).content;
      if (content) recordDepth(content, elementDepth + 1);
    }
  };

  const adapter: TreeAdapter<DefaultTreeAdapterMap> = {
    ...base,
    createElement(tagName, namespaceURI, attrs) {
      bumpNodeCount();
      totalAttributes += attrs.length;
      if (totalAttributes > limits.maxTotalAttributes) throw new ArtifactNodeBudgetExceeded();
      return base.createElement(tagName, namespaceURI, attrs);
    },
    createCommentNode(data) {
      bumpNodeCount();
      return base.createCommentNode(data);
    },
    createDocumentFragment() {
      bumpNodeCount();
      return base.createDocumentFragment();
    },
    setDocumentType(document, name, publicId, systemId) {
      const hasExisting = base.getChildNodes(document).some((node) => base.isDocumentTypeNode(node));
      if (!hasExisting) bumpNodeCount();
      base.setDocumentType(document, name, publicId, systemId);
    },
    insertText(parentNode, text) {
      const children = base.getChildNodes(parentNode);
      const last = children[children.length - 1];
      const createsNewNode = !(last && base.isTextNode(last));
      if (createsNewNode) bumpNodeCount();
      base.insertText(parentNode, text);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      const children = base.getChildNodes(parentNode);
      const idx = children.indexOf(referenceNode);
      const prev = idx > 0 ? children[idx - 1] : undefined;
      const createsNewNode = !(prev && base.isTextNode(prev));
      if (createsNewNode) bumpNodeCount();
      base.insertTextBefore(parentNode, text, referenceNode);
    },
    appendChild(parentNode, newNode) {
      base.appendChild(parentNode, newNode);
      const parentDepth = depths.has(parentNode as object) ? depths.get(parentNode as object)! : -1;
      const newDepth = parentDepth + 1;
      recordDepth(newNode as object, newDepth);
      anchorTemplateContentDepth(newNode, newDepth);
    },
    insertBefore(parentNode, newNode, referenceNode) {
      base.insertBefore(parentNode, newNode, referenceNode);
      const parentDepth = depths.has(parentNode as object) ? depths.get(parentNode as object)! : -1;
      const newDepth = parentDepth + 1;
      recordDepth(newNode as object, newDepth);
      anchorTemplateContentDepth(newNode, newDepth);
    },
  };
  return adapter;
}

/**
 * Authoritative (post-parse) recount via an explicit stack — never parse5's
 * own recursive helpers — so a pathological but budget-passing tree can't
 * blow the call stack while we're re-verifying it. Counts the same node set
 * as the live adapter guard: elements, comments, newly-created text nodes,
 * `template` content fragments, and the doctype. Document node itself is
 * not counted.
 */
export function countTreeBudget(
  root: DefaultTreeAdapterTypes.Document,
): Readonly<{ nodes: number; depth: number; totalAttributes: number; maxAttributes: number }> {
  let nodes = 0;
  let maxDepthSeen = -1;
  let totalAttributes = 0;
  let maxAttributesPerElement = 0;
  const stack: Array<{ node: ArtifactTreeNode; depth: number }> = [];
  for (const child of root.childNodes) stack.push({ node: child, depth: 0 });

  while (stack.length > 0) {
    const entry = stack.pop()!;
    const { node, depth } = entry;
    nodes += 1;
    if (depth > maxDepthSeen) maxDepthSeen = depth;

    if ('attrs' in node) {
      totalAttributes += node.attrs.length;
      if (node.attrs.length > maxAttributesPerElement) maxAttributesPerElement = node.attrs.length;
    }
    if ('content' in node && node.content) {
      nodes += 1;
      const contentDepth = depth + 1;
      if (contentDepth > maxDepthSeen) maxDepthSeen = contentDepth;
      for (const child of node.content.childNodes) stack.push({ node: child, depth: contentDepth + 1 });
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return { nodes, depth: maxDepthSeen, totalAttributes, maxAttributes: maxAttributesPerElement };
}

// ---------------------------------------------------------------------------
// Shared tree walking (explicit stack — never recursion)
// ---------------------------------------------------------------------------

function isElementLike(node: ArtifactTreeNode): node is DefaultTreeAdapterTypes.Element | DefaultTreeAdapterTypes.Template {
  return 'tagName' in node;
}

function isTemplateLike(node: ArtifactTreeNode): node is DefaultTreeAdapterTypes.Template {
  return 'content' in node;
}

function isTextNodeLike(node: ArtifactTreeNode): node is DefaultTreeAdapterTypes.TextNode {
  return 'nodeName' in node && (node as { nodeName: string }).nodeName === '#text';
}

function isCommentNodeLike(node: ArtifactTreeNode): node is DefaultTreeAdapterTypes.CommentNode {
  return 'nodeName' in node && (node as { nodeName: string }).nodeName === '#comment';
}

function isDocumentTypeNodeLike(node: ArtifactTreeNode): node is DefaultTreeAdapterTypes.DocumentType {
  return 'nodeName' in node && (node as { nodeName: string }).nodeName === '#documentType';
}

/** An ordinary element — excludes `<template>`, whose children live in `.content`, not `.childNodes`. */
function isPlainElement(node: ArtifactTreeNode): node is DefaultTreeAdapterTypes.Element {
  return isElementLike(node) && !isTemplateLike(node);
}

/** The two namespaces an inline `<script>`/`<style>` element is honored in (HTML and inline SVG). */
function isHtmlOrSvgNamespace(namespaceURI: string): boolean {
  return namespaceURI === HTML_NS || namespaceURI === SVG_NS;
}

/**
 * Pre-order traversal of a document/fragment, descending into every
 * `template.content` fragment as if it were an ordinary child. Shared by
 * every rule that needs to look at "every element/text/comment node
 * anywhere in the document", by normalization (attribute sort), and by
 * digest computation.
 */
export function* walkArtifactTree(root: DefaultTreeAdapterTypes.Document | DefaultTreeAdapterTypes.DocumentFragment): Generator<ArtifactTreeNode> {
  const stack: ArtifactTreeNode[] = [...root.childNodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    yield node;
    if (isTemplateLike(node)) {
      const contentChildren = node.content.childNodes;
      for (let i = contentChildren.length - 1; i >= 0; i -= 1) stack.push(contentChildren[i]);
    } else if ('childNodes' in node) {
      const children = node.childNodes;
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

interface ArtifactAttribute {
  readonly name: string;
  readonly value: string;
  readonly namespace?: string;
  readonly prefix?: string;
}

function byteCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** `(namespace, prefix, name)` stable sort — the cross-leaf byte-format contract depends on this exact order. */
function compareArtifactAttributes(a: ArtifactAttribute, b: ArtifactAttribute): number {
  return byteCompare(a.namespace ?? '', b.namespace ?? '') || byteCompare(a.prefix ?? '', b.prefix ?? '') || byteCompare(a.name, b.name);
}

function findAttr(attrs: readonly ArtifactAttribute[], predicate: (attr: ArtifactAttribute) => boolean): ArtifactAttribute | undefined {
  return attrs.find(predicate);
}

function isHrefLikeAttr(attr: ArtifactAttribute): boolean {
  return (attr.prefix === 'xlink' && attr.name === 'href') || (!attr.prefix && attr.name === 'href');
}

// ---------------------------------------------------------------------------
// CSS identifier decoding
// ---------------------------------------------------------------------------

/** CSS escape decode (`\XX` hex runs, `\<char>` literal escapes) without case folding. */
function decodeCssEscapes(value: string): string {
  let result = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (/[0-9a-fA-F]/.test(next)) {
        let hex = '';
        let j = i + 1;
        while (j < value.length && hex.length < 6 && /[0-9a-fA-F]/.test(value[j])) {
          hex += value[j];
          j += 1;
        }
        if (j < value.length && /[ \t\n\f\r]/.test(value[j])) j += 1;
        const codePoint = Number.parseInt(hex, 16);
        result += codePoint === 0 || codePoint > 0x10ffff ? '�' : String.fromCodePoint(codePoint);
        i = j;
      } else {
        result += next;
        i += 2;
      }
    } else {
      result += ch;
      i += 1;
    }
  }
  return result;
}

/** CSS escape decode + ASCII lowercase — the comparison form used for at-rule/function name matching. */
export function normalizeCssIdentifier(value: string): string {
  return decodeCssEscapes(value).toLowerCase();
}

function stripVendorPrefix(name: string): string {
  return name.replace(/^-(webkit|moz|o|ms)-/, '');
}

export function truncateArtifactIdentifier(value: string): string {
  const codePoints = Array.from(value);
  return codePoints.length > 128 ? codePoints.slice(0, 128).join('') : value;
}

// ---------------------------------------------------------------------------
// URL classification (shared by HTML/SVG/MathML attributes and CSS `url()`)
// ---------------------------------------------------------------------------

type ArtifactUrlClassification =
  | { kind: 'fragment'; fragment: string }
  | { kind: 'data'; mimeType: string }
  | { kind: 'external'; href: string; hasExplicitPort: boolean }
  | { kind: 'invalid' };

const ARTIFACT_URL_BASE = 'https://artifact.invalid/';

/**
 * The WHATWG URL parser drops a port that equals the scheme's default (e.g.
 * `https://fonts.googleapis.com:443/` and `https://fonts.googleapis.com/`
 * both yield `.port === ''`), so `isExactOriginMatch` alone can't see that a
 * port was written at all. This scans the raw, pre-parse text for an
 * authority with an explicit `:<port>` so a written default port still
 * counts as a near-miss (§規則表 AI-R11/AI-R12: "port ... の near-miss は
 * Google Fonts ではない").
 */
const EXPLICIT_PORT_PATTERN = /^(?:[a-zA-Z][a-zA-Z\d+.-]*:)?\/\/(?:[^/?#@]*@)?(?:\[[^\]]*\]|[^/?#:]*):\d+(?=[/?#]|$)/;

function hasExplicitPort(rawValue: string): boolean {
  return EXPLICIT_PORT_PATTERN.test(rawValue.trim());
}

function classifyArtifactUrlValue(rawValue: string): ArtifactUrlClassification {
  const value = rawValue.trim();
  if (value.length === 0) return { kind: 'invalid' };
  if (value.startsWith('#')) {
    const fragment = value.slice(1);
    if (fragment.length === 0 || fragment.includes('?') || fragment.includes('#')) return { kind: 'invalid' };
    return { kind: 'fragment', fragment };
  }
  let parsed: URL;
  try {
    parsed = new URL(value, ARTIFACT_URL_BASE);
  } catch {
    return { kind: 'invalid' };
  }
  if (parsed.protocol === 'data:') {
    const mimeMatch = /^data:([^,;]*)/i.exec(value);
    const mimeType = (mimeMatch?.[1] ?? '').trim().toLowerCase();
    return { kind: 'data', mimeType };
  }
  return { kind: 'external', href: parsed.href, hasExplicitPort: hasExplicitPort(value) };
}

function isExactOriginMatch(href: string, hostname: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' && parsed.hostname === hostname && parsed.port === '' && parsed.username === '' && parsed.password === '' && parsed.hash === ''
  );
}

/** Google Fonts exact-origin admission is decided from the classification, not a bare href, so the explicit-port near-miss (see `hasExplicitPort`) can't be bypassed by a caller that only forwards `cls.href`. */
function isGoogleFontsOrigin(cls: ArtifactUrlClassification, hostname: string): boolean {
  return cls.kind === 'external' && !cls.hasExplicitPort && isExactOriginMatch(cls.href, hostname);
}
const isGoogleFontsStylesheetOrigin = (cls: ArtifactUrlClassification) => isGoogleFontsOrigin(cls, 'fonts.googleapis.com');
const isGoogleFontsStaticOrigin = (cls: ArtifactUrlClassification) => isGoogleFontsOrigin(cls, 'fonts.gstatic.com');

/** `true` when the fragment/data/external classification is allowed for a same-document-fragment-only attribute context (e.g. `a[href]`, SVG `href`/`xlink:href`). */
function isFragmentOnlyOk(cls: ArtifactUrlClassification): boolean {
  return cls.kind === 'fragment';
}

/** `data:image/*` only (SVG `image[href]`, HTML `img[src]`/`video[poster]`) — no fragment allowance, and no non-image MIME (mirrors AI-R19's `data:image/*` admission for CSS `url()`). */
function isDataOnlyOk(cls: ArtifactUrlClassification): boolean {
  return cls.kind === 'data' && cls.mimeType.startsWith('image/');
}

// value-parser node shapes we actually touch (subset of the library's real AST).
interface CssValueNode {
  readonly type: string;
  readonly value: string;
  readonly nodes?: readonly CssValueNode[];
  /** Set by postcss-value-parser on `function`/`string`/`comment` nodes whose closing delimiter was never found (e.g. `url(foo`, `'unterminated`, `/* x`). */
  readonly unclosed?: true;
}

function extractUrlArgumentValue(node: CssValueNode): string | null {
  const child = (node.nodes ?? []).find((n) => n.type === 'string' || n.type === 'word');
  if (!child) return null;
  return decodeCssEscapes(child.value);
}

/** Walks a single CSS value string (e.g. an SVG presentation attribute's value) looking for `url(...)`, allowing only same-document fragments. Used by AI-R11/AI-R11b. */
function valueContainsOnlyFragmentUrls(rawValue: string): boolean {
  let nodes: readonly CssValueNode[];
  try {
    nodes = artifactParserSeam.parseValue(rawValue).nodes as unknown as readonly CssValueNode[];
  } catch {
    return true; // not parseable as a CSS value — no `url()` to worry about, AI-R11's own value checks don't apply here.
  }
  const stack: CssValueNode[] = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type !== 'function') continue;
    const name = normalizeCssIdentifier(node.value);
    if (name === 'url') {
      const raw = extractUrlArgumentValue(node);
      const cls = raw === null ? ({ kind: 'invalid' } as const) : classifyArtifactUrlValue(raw);
      if (!isFragmentOnlyOk(cls)) return false;
      continue;
    }
    if (node.nodes) stack.push(...node.nodes);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rejection messages
// ---------------------------------------------------------------------------

export const ARTIFACT_REJECTION_MESSAGES = {
  BODY_TOO_LARGE: 'The artifact exceeds the configured size limit.',
  DOM_LIMIT_EXCEEDED: 'The artifact exceeds the document size or depth limits.',
  HTML_PARSE_ERROR: 'The artifact is not well-formed HTML.',
  DOCTYPE_INVALID: 'The artifact must start with exactly one `<!DOCTYPE html>`.',
  DOCUMENT_STRUCTURE_INVALID: 'The artifact must be a single html document with one head and one body.',
  ELEMENT_FORBIDDEN: 'The artifact contains an element that is not allowed.',
  INLINE_CODE_CONTENT_INVALID: 'An inline script or style element contains child nodes other than text.',
  ATTRIBUTE_FORBIDDEN: 'The artifact contains an attribute that is not allowed.',
  META_FORBIDDEN: 'The artifact contains a meta element that is not allowed.',
  EXTERNAL_REFERENCE: 'The artifact references a resource outside itself.',
  FONT_REFERENCE_FORBIDDEN: 'Web font references are not permitted by the current settings.',
  SCRIPT_TYPE_FORBIDDEN: 'The artifact contains a script type that is not allowed.',
  MODULE_SPECIFIER_FORBIDDEN: 'The artifact contains a module import, which is not allowed.',
  CSS_PARSE_ERROR: 'The artifact contains CSS that could not be parsed.',
  CSS_AT_RULE_FORBIDDEN: 'The artifact contains a CSS at-rule that is not allowed.',
  CSS_FUNCTION_FORBIDDEN: 'The artifact contains a CSS function that is not allowed.',
  CSS_STRING_ARGUMENT_FORBIDDEN: 'The artifact contains a CSS string argument that is not allowed.',
  URL_FORBIDDEN: 'The artifact contains a URL that is not allowed.',
  CSS_VALUE_NODE_LIMIT_EXCEEDED: 'The artifact exceeds the CSS complexity limit.',
  CSS_VALUE_DEPTH_EXCEEDED: 'The artifact exceeds the CSS nesting limit.',
  CSS_SOURCE_TOO_LARGE: "The artifact's CSS exceeds the size limit.",
  NORMALIZER_MARKER_INVALID: "The artifact's reserved digest markers are malformed.",
  NORMALIZATION_NOT_IDEMPOTENT: 'The artifact could not be normalised deterministically.',
  CONTENT_TYPE_INVALID: 'The page content type header is invalid.',
  CONTENT_TYPE_CONFLICT: "The requested content type does not match the page's current content type.",
  ARTIFACT_DELIVERY_NOT_CONFIGURED: 'Artifact delivery is not configured on this server, so artifact pages cannot be written.',
} as const satisfies Record<ArtifactIngestRejectionReason, string>;

// ---------------------------------------------------------------------------
// parseArtifactDocument
// ---------------------------------------------------------------------------

const RESERVED_MARKER_NAMES: readonly string[] = [ARTIFACT_SCRIPT_DIGEST_META_NAME, ARTIFACT_STYLE_DIGEST_META_NAME];

function findHtmlElement(document: DefaultTreeAdapterTypes.Document): DefaultTreeAdapterTypes.Element | null {
  for (const node of document.childNodes) {
    if (isPlainElement(node) && node.tagName === 'html' && node.namespaceURI === HTML_NS) return node;
  }
  return null;
}

function findHeadElement(document: DefaultTreeAdapterTypes.Document): DefaultTreeAdapterTypes.Element | null {
  const html = findHtmlElement(document);
  if (!html) return null;
  for (const node of html.childNodes) {
    if (isPlainElement(node) && node.tagName === 'head' && node.namespaceURI === HTML_NS) return node;
  }
  return null;
}

function findBodyElement(document: DefaultTreeAdapterTypes.Document): DefaultTreeAdapterTypes.Element | null {
  const html = findHtmlElement(document);
  if (!html) return null;
  for (const node of html.childNodes) {
    if (isPlainElement(node) && node.tagName === 'body' && node.namespaceURI === HTML_NS) return node;
  }
  return null;
}

function isReservedMarkerMetaCandidate(node: DefaultTreeAdapterTypes.Element): boolean {
  if (node.tagName !== 'meta' || node.namespaceURI !== HTML_NS) return false;
  const nameAttr = findAttr(node.attrs, (a) => !a.namespace && a.name === 'name');
  return nameAttr !== undefined && RESERVED_MARKER_NAMES.includes(nameAttr.value);
}

/**
 * Strips head-direct reserved-name `<meta>` markers unconditionally
 * (regardless of shape) and records what was removed. AI-R21's `'source'`
 * pass then judges the recording for duplicate names / extra attributes —
 * see spec §解析・正規化アルゴリズム step 3 for why the removal itself must
 * not be conditional on well-formedness.
 */
function stripReservedHeadMarkers(runtime: Parse5Runtime, document: DefaultTreeAdapterTypes.Document): ParsedArtifactDocument['removedReservedMarkers'] {
  const head = findHeadElement(document);
  if (!head) return [];
  const removed: Array<{ name: string; attributeNames: readonly string[] }> = [];
  const candidates = head.childNodes.filter((node): node is DefaultTreeAdapterTypes.Element => isPlainElement(node) && isReservedMarkerMetaCandidate(node));
  for (const node of candidates) {
    const nameAttr = findAttr(node.attrs, (a) => !a.namespace && a.name === 'name')!;
    removed.push({ name: nameAttr.value, attributeNames: node.attrs.map((a) => a.name) });
    runtime.defaultTreeAdapter.detachNode(node);
  }
  return removed;
}

export function parseArtifactDocument(input: string, mode: ArtifactParseMode): ParsedArtifactDocument | ArtifactIngestRejection {
  const runtime = loadParse5Runtime();
  const { Parser } = getArtifactBudgetClasses(runtime);
  const adapter = createCountingTreeAdapter(runtime, {
    nodeBudget: ARTIFACT_NODE_BUDGET,
    maxDepth: ARTIFACT_MAX_TREE_DEPTH,
    maxTotalAttributes: ARTIFACT_MAX_TOTAL_ATTRIBUTES,
  });
  const parseErrorCodes: string[] = [];
  let document: DefaultTreeAdapterTypes.Document;
  try {
    document = Parser.parse(input, {
      treeAdapter: adapter,
      onParseError: (error: { code: string }) => {
        parseErrorCodes.push(error.code);
      },
      scriptingEnabled: true,
    }) as DefaultTreeAdapterTypes.Document;
  } catch (error) {
    if (error instanceof ArtifactNodeBudgetExceeded) {
      return { ruleId: 'AI-R02', reason: 'DOM_LIMIT_EXCEEDED', httpStatus: 413 };
    }
    throw new ArtifactInternalError('parse5 failed unexpectedly while parsing an artifact document', { cause: error });
  }
  const removedReservedMarkers = mode === 'source' ? stripReservedHeadMarkers(runtime, document) : [];
  return { document, parseErrorCodes, removedReservedMarkers };
}

function isParsedDocument(value: ParsedArtifactDocument | ArtifactIngestRejection): value is ParsedArtifactDocument {
  return 'document' in value;
}

// ---------------------------------------------------------------------------
// serializeArtifactTree / normalizeArtifactTree
// ---------------------------------------------------------------------------

const LEADING_LF_FIX_TAGS = new Set(['pre', 'textarea', 'listing']);

/**
 * Wraps parse5's `serialize()` with the `pre`/`textarea`/`listing`
 * leading-LF compensation the HTML parsing algorithm requires but the
 * serializer doesn't supply on its own (parser drops one leading newline
 * after these elements' start tags; without re-adding it, serialize→reparse
 * loses a real newline and is not a fixed point — see spec step 6).
 * Mutates affected text nodes only for the duration of the call, so it is
 * safe to call more than once on the same tree.
 */
export function serializeArtifactTree(document: DefaultTreeAdapterTypes.Document): string {
  const runtime = loadParse5Runtime();
  const restorations: Array<{ node: DefaultTreeAdapterTypes.TextNode; original: string }> = [];
  for (const node of walkArtifactTree(document)) {
    if (!isPlainElement(node)) continue;
    if (node.namespaceURI !== HTML_NS || !LEADING_LF_FIX_TAGS.has(node.tagName)) continue;
    const first = node.childNodes[0];
    if (first && isTextNodeLike(first) && first.value.startsWith('\n')) {
      restorations.push({ node: first, original: first.value });
      first.value = `\n${first.value}`;
    }
  }
  try {
    return runtime.serialize(document, { treeAdapter: runtime.defaultTreeAdapter });
  } finally {
    for (const { node, original } of restorations) node.value = original;
  }
}

function concatenateTextChildren(node: DefaultTreeAdapterTypes.Element): string {
  let text = '';
  for (const child of node.childNodes) {
    if (isTextNodeLike(child)) text += child.value;
  }
  return text;
}

function computeArtifactDigests(document: DefaultTreeAdapterTypes.Document): { scriptDigests: string[]; styleDigests: string[] } {
  const scriptDigests: string[] = [];
  const styleDigests: string[] = [];
  for (const node of walkArtifactTree(document)) {
    if (!isPlainElement(node)) continue;
    if (!isHtmlOrSvgNamespace(node.namespaceURI)) continue;
    if (node.tagName !== 'script' && node.tagName !== 'style') continue;
    const text = concatenateTextChildren(node);
    const digest = `sha256-${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('base64')}`;
    if (node.tagName === 'script') scriptDigests.push(digest);
    else styleDigests.push(digest);
  }
  return { scriptDigests, styleDigests };
}

function canonicalizeArtifactTree(runtime: Parse5Runtime, document: DefaultTreeAdapterTypes.Document): void {
  for (const node of walkArtifactTree(document)) {
    if (isElementLike(node)) (node.attrs as ArtifactAttribute[]).sort(compareArtifactAttributes);
  }
  // AI-R04 already guarantees exactly one `html` doctype with empty
  // public/system IDs by the time normalization runs; this call is
  // defensive (matches spec step 4's "fix the doctype" instruction) rather
  // than load-bearing.
  runtime.defaultTreeAdapter.setDocumentType(document, 'html', '', '');
}

function insertReservedMarkers(
  runtime: Parse5Runtime,
  document: DefaultTreeAdapterTypes.Document,
  scriptDigests: readonly string[],
  styleDigests: readonly string[],
): void {
  const adapter = runtime.defaultTreeAdapter;
  const head = findHeadElement(document);
  if (!head) throw new ArtifactInternalError('normalizeArtifactTree: document has no <head> element after AI-R05 passed');
  const scriptAttrs: ArtifactAttribute[] = [
    { name: 'content', value: scriptDigests.join(' ') },
    { name: 'name', value: ARTIFACT_SCRIPT_DIGEST_META_NAME },
  ].sort(compareArtifactAttributes);
  const styleAttrs: ArtifactAttribute[] = [
    { name: 'content', value: styleDigests.join(' ') },
    { name: 'name', value: ARTIFACT_STYLE_DIGEST_META_NAME },
  ].sort(compareArtifactAttributes);
  const scriptMeta = adapter.createElement('meta', HTML_NS as never, scriptAttrs as never);
  const styleMeta = adapter.createElement('meta', HTML_NS as never, styleAttrs as never);
  adapter.appendChild(head, scriptMeta);
  adapter.appendChild(head, styleMeta);
}

export function normalizeArtifactTree(
  document: ParsedArtifactDocument,
): Readonly<{ serialized: string; bytes: Uint8Array; scriptDigests: readonly string[]; styleDigests: readonly string[] }> {
  const runtime = loadParse5Runtime();
  const tree = document.document;
  canonicalizeArtifactTree(runtime, tree);
  const { scriptDigests, styleDigests } = computeArtifactDigests(tree);
  insertReservedMarkers(runtime, tree, scriptDigests, styleDigests);
  const serialized = serializeArtifactTree(tree);
  const bytes = artifactParserSeam.encodeArtifactBytes(serialized);
  return { serialized, bytes, scriptDigests, styleDigests };
}

// ---------------------------------------------------------------------------
// CSS analysis (AI-R15 - AI-R20c) — one memoized 4-stage procedure per parsed
// document, per spec §解析・正規化アルゴリズム step 2's CSS paragraph.
// ---------------------------------------------------------------------------

export interface ArtifactCssAnalysis {
  readonly failure: Readonly<{ ruleId: ArtifactRuleId; target?: string }> | null;
  /** Set when a Google Fonts exact-origin `@import`/`@font-face src` reference was found (and exempted from AI-R16/AI-R19); AI-R12 reads this. */
  readonly hasExemptFontReference: boolean;
}

function collectStyleElements(document: DefaultTreeAdapterTypes.Document): DefaultTreeAdapterTypes.Element[] {
  const styles: DefaultTreeAdapterTypes.Element[] = [];
  for (const node of walkArtifactTree(document)) {
    if (!isPlainElement(node)) continue;
    if (node.tagName !== 'style') continue;
    if (!isHtmlOrSvgNamespace(node.namespaceURI)) continue;
    styles.push(node);
  }
  return styles;
}

/** 1 pass over raw `<style>` text — string/comment/escape-aware — measuring paren depth and CSS "word token" count before PostCSS/value-parser ever run (S2). Also flags an unmatched closing paren: PostCSS's own stylesheet tokenizer never validates bracket balance inside a declaration value or at-rule params (only unclosed *opens* surface as a `CssSyntaxError`; e.g. `a{p:calc(1px))}` and `a{p:foo)}` parse without error, and value-parser hands the stray `)` back as an inert `word` node that no AI-R17/18/19 check inspects), so without this flag a structurally malformed stylesheet is silently accepted instead of failing AI-R15. */
export function scanCssText(text: string): Readonly<{ maxParenDepth: number; wordTokens: number; hasUnbalancedClosingParen: boolean }> {
  const n = text.length;
  let i = 0;
  let depth = 0;
  let maxDepth = 0;
  let wordTokens = 0;
  let inWord = false;
  let hasUnbalancedClosingParen = false;

  const endWord = () => {
    if (inWord) {
      wordTokens += 1;
      inWord = false;
    }
  };
  const isDelimiter = (ch: string) =>
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === ',' || ch === '/' || ch === ':' || ch === ';' || ch === '{' || ch === '}';

  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      endWord();
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      endWord();
      const quote = ch;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '\\') {
      inWord = true;
      i += 1;
      if (i < n && /[0-9a-fA-F]/.test(text[i])) {
        let hexCount = 0;
        while (i < n && hexCount < 6 && /[0-9a-fA-F]/.test(text[i])) {
          i += 1;
          hexCount += 1;
        }
        if (i < n && /[ \t\n\f\r]/.test(text[i])) i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === '(') {
      endWord();
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
      i += 1;
      continue;
    }
    if (ch === ')') {
      endWord();
      if (depth === 0) hasUnbalancedClosingParen = true;
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (isDelimiter(ch)) {
      endWord();
      i += 1;
      continue;
    }
    inWord = true;
    i += 1;
  }
  endWord();
  return { maxParenDepth: maxDepth, wordTokens, hasUnbalancedClosingParen };
}

const ARTIFACT_CSS_AT_RULE_ALLOWLIST = new Set([
  'charset',
  'media',
  'supports',
  'layer',
  'container',
  'keyframes',
  'font-face',
  'property',
  'scope',
  'starting-style',
  'page',
  'counter-style',
]);

const ARTIFACT_CSS_FUNCTION_ALLOWLIST = new Set([
  'attr',
  'calc',
  'clamp',
  'min',
  'max',
  'var',
  'env',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'linear-gradient',
  'repeating-linear-gradient',
  'radial-gradient',
  'repeating-radial-gradient',
  'conic-gradient',
  'repeating-conic-gradient',
  'gradient',
  'matrix',
  'matrix3d',
  'translate',
  'translatex',
  'translatey',
  'translatez',
  'translate3d',
  'scale',
  'scalex',
  'scaley',
  'scalez',
  'scale3d',
  'rotate',
  'rotatex',
  'rotatey',
  'rotatez',
  'rotate3d',
  'skew',
  'skewx',
  'skewy',
  'perspective',
  'blur',
  'brightness',
  'contrast',
  'drop-shadow',
  'grayscale',
  'hue-rotate',
  'invert',
  'opacity',
  'saturate',
  'sepia',
  'circle',
  'ellipse',
  'inset',
  'polygon',
  'path',
  'counter',
  'counters',
  'abs',
  'sign',
  'round',
  'mod',
  'rem',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'pow',
  'sqrt',
  'hypot',
  'log',
  'exp',
  'local',
  'format',
  'repeat',
  'minmax',
  'fit-content',
  'cubic-bezier',
  'steps',
  'linear',
  'symbols',
  'selector',
]);

const ARTIFACT_CSS_STRING_LENGTH_LIMITS: Readonly<Record<string, number>> = {
  path: 4096,
  counters: 64,
  local: 128,
  format: 32,
};

interface AtRuleLikeNode {
  readonly type: string;
  readonly name?: string;
  readonly params?: string;
  readonly prop?: string;
  readonly value?: string;
  readonly selector?: string;
  readonly nodes?: readonly AtRuleLikeNode[];
  readonly parent?: AtRuleLikeNode;
}

interface CssWalkContext {
  readonly insideFontFaceSrc: boolean;
  readonly insideImportParams: boolean;
  readonly insideSelectorArg: boolean;
  /** Set only while analyzing an `@supports` at-rule's own params — `selector()` is a resource-free "condition" function exclusive to that context (§規則表 AI-R17), not a general-purpose value-position exemption. */
  readonly insideSupportsCondition: boolean;
}

interface CssWalkResult {
  readonly failure: Readonly<{ ruleId: ArtifactRuleId; target?: string }> | null;
  readonly hasExemptFontReference: boolean;
}

/**
 * S4's value-node budget (AI-R20a) is a document-wide total, not a
 * per-declaration one — two `<style>` blocks (or two declarations) each
 * under the limit can still sum past it. A single mutable counter threaded
 * through every `analyzeValueNodes`/`walkPostcssTree` call for one document
 * is what makes the budget document-wide instead of resetting per call.
 */
interface CssValueCounter {
  count: number;
}

/** C0 controls and DEL — never legitimate inside a CSS function-argument string. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codeUnit = value.charCodeAt(i);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function checkStringNode(node: CssValueNode, parentFunctionName: string | null): { ruleId: ArtifactRuleId; target?: string } | null {
  // AI-R18 governs strings that are *function arguments* ("function 内
  // string"). A bare/top-level string — `content: "→"`, `font-family:
  // "Helvetica Neue"`, an at-rule's own params like `@charset "UTF-8"` — is
  // inert (it can't reference or fetch anything) and is outside this
  // rule's scope entirely.
  if (parentFunctionName === null) return null;
  if (parentFunctionName === 'url') return null; // handled by AI-R19.
  const limit = parentFunctionName ? ARTIFACT_CSS_STRING_LENGTH_LIMITS[parentFunctionName] : undefined;
  if (limit === undefined) return { ruleId: 'AI-R18', target: parentFunctionName ? truncateArtifactIdentifier(parentFunctionName) : undefined };
  const decoded = parentFunctionName === 'format' ? node.value : decodeCssEscapes(node.value);
  const codePointCount = Array.from(decoded).length;
  if (codePointCount > limit) return { ruleId: 'AI-R18', target: truncateArtifactIdentifier(parentFunctionName!) };
  if (hasControlCharacter(node.value)) return { ruleId: 'AI-R18', target: truncateArtifactIdentifier(parentFunctionName!) };
  if (parentFunctionName === 'format' && !/^[A-Za-z0-9-]*$/.test(node.value)) return { ruleId: 'AI-R18', target: 'format' };
  return null;
}

function analyzeValueNodes(nodes: readonly CssValueNode[], baseCtx: CssWalkContext, counter: CssValueCounter): CssWalkResult {
  let hasExemptFontReference = false;
  const stack: Array<{ node: CssValueNode; parentFunctionName: string | null; ctx: CssWalkContext }> = [];
  for (let i = nodes.length - 1; i >= 0; i -= 1) stack.push({ node: nodes[i], parentFunctionName: null, ctx: baseCtx });

  while (stack.length > 0) {
    const { node, parentFunctionName, ctx } = stack.pop()!;
    counter.count += 1;
    if (counter.count > ARTIFACT_CSS_MAX_VALUE_NODES) return { failure: { ruleId: 'AI-R20a' }, hasExemptFontReference };
    // postcss-value-parser recovers from unbalanced input (`url(foo`,
    // `'unterminated`, `/* x`) instead of throwing, marking the affected
    // node `unclosed` rather than raising a `CssSyntaxError` the way
    // PostCSS's own stylesheet-level tokenizer would. Left unchecked, an
    // unclosed `url(...)`'s partial content falls through to the ordinary
    // URL/function checks below and gets judged (and often accepted) as if
    // it were well-formed.
    if (node.unclosed) return { failure: { ruleId: 'AI-R15' }, hasExemptFontReference };

    if (node.type === 'function') {
      const isParenGroup = node.value === '';
      const children = node.nodes ?? [];
      if (isParenGroup) {
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i], parentFunctionName, ctx });
        continue;
      }
      const normalizedName = stripVendorPrefix(normalizeCssIdentifier(node.value));
      // `selector()` is a resource-free CSS **condition** function scoped to
      // `@supports selector(...)` (§規則表 AI-R17) — outside that context it
      // falls through to the ordinary allowlist/children handling below, so
      // e.g. `a{color:selector(:has(b))}` judges the nested `:has()` like
      // any other CSS function instead of exempting it.
      if (normalizedName === 'selector' && ctx.insideSupportsCondition) {
        const selectorCtx: CssWalkContext = { ...ctx, insideSelectorArg: true };
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i], parentFunctionName: 'selector', ctx: selectorCtx });
        continue;
      }
      if (normalizedName === 'url') {
        const raw = extractUrlArgumentValue(node);
        const cls = raw === null ? ({ kind: 'invalid' } as const) : classifyArtifactUrlValue(raw);
        if (cls.kind === 'fragment') continue;
        if (cls.kind === 'data') {
          if (cls.mimeType.startsWith('image/')) continue;
          if (ctx.insideFontFaceSrc && cls.mimeType.startsWith('font/')) continue;
          return { failure: { ruleId: 'AI-R19' }, hasExemptFontReference };
        }
        if (cls.kind === 'external') {
          if (ctx.insideImportParams && isGoogleFontsStylesheetOrigin(cls)) {
            hasExemptFontReference = true;
            continue;
          }
          if (ctx.insideFontFaceSrc && isGoogleFontsStaticOrigin(cls)) {
            hasExemptFontReference = true;
            continue;
          }
          return { failure: { ruleId: 'AI-R19' }, hasExemptFontReference };
        }
        return { failure: { ruleId: 'AI-R19' }, hasExemptFontReference };
      }
      if (!ctx.insideSelectorArg && !ARTIFACT_CSS_FUNCTION_ALLOWLIST.has(normalizedName)) {
        return { failure: { ruleId: 'AI-R17', target: truncateArtifactIdentifier(normalizedName) }, hasExemptFontReference };
      }
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i], parentFunctionName: normalizedName, ctx });
      continue;
    }
    if (node.type === 'string') {
      if (ctx.insideSelectorArg) continue;
      // `@import "https://fonts.googleapis.com/x"` is the quoted-string form
      // of `@import url("https://fonts.googleapis.com/x")` — a bare
      // (non-nested) string directly in an `@import`'s params *is* the
      // import target, so it must receive the same exact-origin admission
      // the `url()` form gets above, not AI-R18's inert-string treatment.
      if (ctx.insideImportParams && parentFunctionName === null) {
        const cls = classifyArtifactUrlValue(decodeCssEscapes(node.value));
        if (cls.kind === 'external' && isGoogleFontsStylesheetOrigin(cls)) {
          hasExemptFontReference = true;
          continue;
        }
        return { failure: { ruleId: 'AI-R19' }, hasExemptFontReference };
      }
      const failure = checkStringNode(node, parentFunctionName);
      if (failure) return { failure, hasExemptFontReference };
      continue;
    }
    // 'word' / 'div' / 'space' / other leaf node kinds need no further validation on their own.
  }
  return { failure: null, hasExemptFontReference };
}

/**
 * The only vendor-prefixed at-rule name the contract accepts is
 * `keyframes` (§規則表 AI-R16: "ベンダー接頭辞つきの`keyframes`... だけ") —
 * every other at-rule, including `font-face`, is matched on its raw,
 * unstripped folded name. `@-webkit-media` must not resolve to `media`, and
 * there is no such thing as a vendor-prefixed `@font-face`.
 */
function resolveAtRuleAllowlistName(rawName: string): string {
  const folded = normalizeCssIdentifier(rawName);
  const stripped = stripVendorPrefix(folded);
  return stripped === 'keyframes' ? 'keyframes' : folded;
}

/** `@font-face { src: ... }` admits a Google Fonts static-origin `url()`/`data:font/*`; a same-named `src` declaration in an ordinary rule (`a { src: url(data:font/woff2;...) }`) is not `@font-face` and must not inherit that exemption — hence checking the *parent* at-rule's name rather than the declaration's own property name alone. */
function isFontFaceSrcDecl(node: AtRuleLikeNode): boolean {
  if (node.prop?.toLowerCase() !== 'src') return false;
  const parent = node.parent;
  if (!parent || parent.type !== 'atrule') return false;
  return normalizeCssIdentifier(parent.name ?? '') === 'font-face';
}

function walkPostcssTree(root: AtRuleLikeNode, counter: CssValueCounter): CssWalkResult {
  let hasExemptFontReference = false;
  const stack: AtRuleLikeNode[] = [...(root.nodes ?? [])];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.type === 'atrule') {
      const rawName = node.name ?? '';
      const normalizedName = resolveAtRuleAllowlistName(rawName);
      if (normalizedName === 'import') {
        const paramsResult = analyzeValueNodes(
          (artifactParserSeam.parseValue(node.params ?? '').nodes as unknown as CssValueNode[]) ?? [],
          { insideFontFaceSrc: false, insideImportParams: true, insideSelectorArg: false, insideSupportsCondition: false },
          counter,
        );
        // A URL-shaped failure inside `@import`'s params carries its own
        // ruleId, exactly like the non-`@import` branch below — it must not
        // be relabelled as AI-R16. This applies uniformly to every non-exempt
        // external target, not only ones shaped like a Google Fonts near-miss
        // (§規則表 AI-R19: "near-miss は Google Fonts ではないのでここで拒否する",
        // i.e. by AI-R19 itself — the same URL rule any other `url()`/string
        // target is judged by).
        if (paramsResult.failure) return { failure: paramsResult.failure, hasExemptFontReference };
        // Only an `@import` whose params analysis found neither a failure nor
        // a Google Fonts exact-origin reference (e.g. a same-document
        // fragment or an admissible `data:image/*` URL, which AI-R19 itself
        // doesn't reject) falls through to being forbidden as an at-rule.
        if (paramsResult.hasExemptFontReference) hasExemptFontReference = true;
        else return { failure: { ruleId: 'AI-R16', target: 'import' }, hasExemptFontReference };
      } else if (!ARTIFACT_CSS_AT_RULE_ALLOWLIST.has(normalizedName)) {
        return { failure: { ruleId: 'AI-R16', target: truncateArtifactIdentifier(normalizedName) }, hasExemptFontReference };
      } else {
        const paramsResult = analyzeValueNodes(
          (artifactParserSeam.parseValue(node.params ?? '').nodes as unknown as CssValueNode[]) ?? [],
          { insideFontFaceSrc: false, insideImportParams: false, insideSelectorArg: false, insideSupportsCondition: normalizedName === 'supports' },
          counter,
        );
        if (paramsResult.failure) return { failure: paramsResult.failure, hasExemptFontReference };
        if (paramsResult.hasExemptFontReference) hasExemptFontReference = true;
      }
      if (node.nodes) stack.unshift(...node.nodes);
      continue;
    }
    if (node.type === 'decl') {
      const declResult = analyzeValueNodes(
        (artifactParserSeam.parseValue(node.value ?? '').nodes as unknown as CssValueNode[]) ?? [],
        { insideFontFaceSrc: isFontFaceSrcDecl(node), insideImportParams: false, insideSelectorArg: false, insideSupportsCondition: false },
        counter,
      );
      if (declResult.failure) return { failure: declResult.failure, hasExemptFontReference };
      if (declResult.hasExemptFontReference) hasExemptFontReference = true;
      continue;
    }
    if (node.type === 'rule') {
      // A plain rule's own selector is analyzed the same way a value is
      // (§規則表 AC-AI-7: "selector() の外の :has(a) が拒否される") — a
      // pseudo-class function like `:has()`/`:not()` parses as an ordinary
      // value-parser `function` node once the leading `:` is stripped off
      // as a `div`, so the shared function-name allowlist applies here too.
      const selectorResult = analyzeValueNodes(
        (artifactParserSeam.parseValue(node.selector ?? '').nodes as unknown as CssValueNode[]) ?? [],
        { insideFontFaceSrc: false, insideImportParams: false, insideSelectorArg: false, insideSupportsCondition: false },
        counter,
      );
      if (selectorResult.failure) return { failure: selectorResult.failure, hasExemptFontReference };
      if (node.nodes) stack.unshift(...node.nodes);
    }
  }
  return { failure: null, hasExemptFontReference };
}

const cssAnalysisCache = new WeakMap<ParsedArtifactDocument, ArtifactCssAnalysis>();

function computeArtifactCssAnalysis(document: DefaultTreeAdapterTypes.Document): ArtifactCssAnalysis {
  const styleElements = collectStyleElements(document);
  const styleTexts = styleElements.map((el) => concatenateTextChildren(el));

  const totalBytes = styleTexts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
  if (totalBytes > ARTIFACT_CSS_MAX_BYTES) return { failure: { ruleId: 'AI-R20c' }, hasExemptFontReference: false };

  let maxParenDepth = 0;
  let totalWordTokens = 0;
  let hasUnbalancedClosingParen = false;
  for (const text of styleTexts) {
    const scan = scanCssText(text);
    if (scan.maxParenDepth > maxParenDepth) maxParenDepth = scan.maxParenDepth;
    totalWordTokens += scan.wordTokens;
    if (scan.hasUnbalancedClosingParen) hasUnbalancedClosingParen = true;
  }
  if (maxParenDepth > ARTIFACT_CSS_MAX_PAREN_DEPTH) return { failure: { ruleId: 'AI-R20b' }, hasExemptFontReference: false };
  // An unmatched closing paren is a structural CSS defect that neither PostCSS's
  // stylesheet parser nor value-parser treats as an error (§S2) — mapped to
  // AI-R15 (priority 32) here, ahead of the AI-R20a token-count pre-check
  // (priority 37), matching the table's stage ordering.
  if (hasUnbalancedClosingParen) return { failure: { ruleId: 'AI-R15' }, hasExemptFontReference: false };
  if (totalWordTokens > ARTIFACT_CSS_MAX_TOKENS) return { failure: { ruleId: 'AI-R20a' }, hasExemptFontReference: false };

  const roots: AtRuleLikeNode[] = [];
  for (const text of styleTexts) {
    try {
      roots.push(artifactParserSeam.parseStylesheet(text) as unknown as AtRuleLikeNode);
    } catch {
      return { failure: { ruleId: 'AI-R15' }, hasExemptFontReference: false };
    }
  }

  // Shared across every root/decl/at-rule/selector for this document, per
  // AI-R20a's document-wide (not per-declaration) value-node budget.
  const counter: CssValueCounter = { count: 0 };
  let hasExemptFontReference = false;
  for (const root of roots) {
    const result = walkPostcssTree(root, counter);
    if (result.hasExemptFontReference) hasExemptFontReference = true;
    if (result.failure) return { failure: result.failure, hasExemptFontReference };
  }
  return { failure: null, hasExemptFontReference };
}

export function analyzeArtifactCss(context: Readonly<ArtifactRuleContext>): ArtifactCssAnalysis {
  if (!context.parsed) throw new ArtifactInternalError('analyzeArtifactCss requires a parsed document');
  const cached = cssAnalysisCache.get(context.parsed);
  if (cached) return cached;
  const result = computeArtifactCssAnalysis(context.parsed.document);
  cssAnalysisCache.set(context.parsed, result);
  return result;
}

/**
 * The single predicate for "is this `<link>` the Google Fonts stylesheet
 * link AI-R12 governs" — shared by AI-R12's own document-wide scan and by
 * AI-R11's exemption (§規則表 AI-R11: the exemption is for `link[rel=stylesheet][href]`
 * specifically, not any `link[href]` that merely happens to resolve to the
 * origin). A single shared predicate means the two can't drift apart again.
 */
function isGoogleFontsStylesheetLinkElement(node: DefaultTreeAdapterTypes.Element): boolean {
  if (node.tagName !== 'link' || node.namespaceURI !== HTML_NS) return false;
  const attrs = node.attrs as ArtifactAttribute[];
  const rel = findAttr(attrs, (a) => !a.namespace && a.name === 'rel');
  if (!rel || rel.value.toLowerCase() !== 'stylesheet') return false;
  const href = findAttr(attrs, (a) => !a.namespace && a.name === 'href');
  if (!href) return false;
  const cls = classifyArtifactUrlValue(href.value);
  return cls.kind === 'external' && isGoogleFontsStylesheetOrigin(cls);
}

function hasGoogleFontsLinkReference(document: DefaultTreeAdapterTypes.Document): boolean {
  for (const node of walkArtifactTree(document)) {
    if (isPlainElement(node) && isGoogleFontsStylesheetLinkElement(node)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Module specifier validation (AI-R14)
// ---------------------------------------------------------------------------

export async function validateModuleSpecifiers(source: string): Promise<ArtifactRuleFailure | null> {
  try {
    await esModuleLexerInit;
  } catch (error) {
    throw new ArtifactInternalError('es-module-lexer failed to initialize', { cause: error });
  }
  let imports: ReadonlyArray<{ readonly n: string | undefined; readonly t: number }>;
  try {
    [imports] = parseEsModules(source);
  } catch {
    return { target: 'script' };
  }
  for (const record of imports) {
    if (record.t === ImportType.ImportMeta) continue;
    // `record.n` is the import specifier the author wrote (a path/URL
    // string) — AC-AI-9 forbids reflecting URLs/paths in `target`, so this
    // always returns the fixed `'script'` identifier the ingest-core spec
    // assigns to AI-R14, never the specifier itself.
    return { target: 'script' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule checks
// ---------------------------------------------------------------------------

async function checkAiR01(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  const reserialized = serializeArtifactTree(context.parsed!.document);
  const bytes = artifactParserSeam.encodeArtifactBytes(reserialized);
  return bytes.length > context.options.maxBytes ? {} : null;
}

async function checkAiR01a(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  return Buffer.byteLength(context.input, 'utf8') > ARTIFACT_HARD_MAX_BYTES ? {} : null;
}

async function checkAiR02(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  const budget = countTreeBudget(context.parsed!.document);
  if (budget.nodes > ARTIFACT_NODE_BUDGET) return {};
  if (budget.depth > ARTIFACT_MAX_TREE_DEPTH) return {};
  if (budget.totalAttributes > ARTIFACT_MAX_TOTAL_ATTRIBUTES) return {};
  if (budget.maxAttributes > ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT) return {};
  return null;
}

async function checkAiR03(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  const runtime = loadParse5Runtime();
  const hasNonDoctypeError = context.parsed!.parseErrorCodes.some((code) => !isDoctypeParseError(code, runtime));
  return hasNonDoctypeError ? {} : null;
}

async function checkAiR04(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  const runtime = loadParse5Runtime();
  if (context.parsed!.parseErrorCodes.some((code) => isDoctypeParseError(code, runtime))) return {};
  const doctypes = context.parsed!.document.childNodes.filter(isDocumentTypeNodeLike);
  if (doctypes.length !== 1) return {};
  const [doctype] = doctypes;
  if (doctype.name !== 'html' || doctype.publicId !== '' || doctype.systemId !== '') return {};
  return null;
}

async function checkAiR05(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  const document = context.parsed!.document;
  for (const node of document.childNodes) {
    if (isDocumentTypeNodeLike(node) || isCommentNodeLike(node)) continue;
    if (isPlainElement(node) && node.tagName === 'html' && node.namespaceURI === HTML_NS) continue;
    return { target: 'document' };
  }
  const html = findHtmlElement(document);
  if (!html) return { target: 'html' };
  for (const node of html.childNodes) {
    if (isCommentNodeLike(node)) continue;
    if (isTextNodeLike(node)) {
      if (node.value.trim().length === 0) continue;
      return { target: 'html' };
    }
    if (isPlainElement(node) && node.namespaceURI === HTML_NS && (node.tagName === 'head' || node.tagName === 'body')) continue;
    return { target: 'html' };
  }
  if (!findHeadElement(document)) return { target: 'head' };
  if (!findBodyElement(document)) return { target: 'body' };
  return null;
}

const FORBIDDEN_ELEMENT_TAGS = new Set(['base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'noscript']);

async function checkAiR07(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  for (const node of walkArtifactTree(context.parsed!.document)) {
    if (!isElementLike(node)) continue;
    if (FORBIDDEN_ELEMENT_TAGS.has(node.tagName)) return { target: truncateArtifactIdentifier(node.tagName) };
  }
  return null;
}

async function checkAiR07a(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  for (const node of walkArtifactTree(context.parsed!.document)) {
    if (!isPlainElement(node)) continue;
    if (node.tagName !== 'script' && node.tagName !== 'style') continue;
    if (!isHtmlOrSvgNamespace(node.namespaceURI)) continue;
    for (const child of node.childNodes) {
      if (!isTextNodeLike(child)) return { target: truncateArtifactIdentifier(node.tagName) };
    }
  }
  return null;
}

const FORBIDDEN_ATTRIBUTE_NAMES = new Set(['style', 'srcdoc', 'ping', 'manifest', 'referrerpolicy']);

async function checkAiR08(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  for (const node of walkArtifactTree(context.parsed!.document)) {
    if (!isElementLike(node)) continue;
    for (const attr of node.attrs as ArtifactAttribute[]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || FORBIDDEN_ATTRIBUTE_NAMES.has(name)) {
        return { target: truncateArtifactIdentifier(name) };
      }
    }
  }
  return null;
}

async function checkAiR09(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  const document = context.parsed!.document;
  const head = findHeadElement(document);
  let charsetCount = 0;
  let viewportCount = 0;
  for (const node of walkArtifactTree(document)) {
    if (!isPlainElement(node)) continue;
    if (node.tagName !== 'meta' || node.namespaceURI !== HTML_NS) continue;
    if (head && node.parentNode === head && isReservedMarkerMetaCandidate(node)) continue; // normalizer-owned marker.
    const attrs = node.attrs as ArtifactAttribute[];
    const charsetAttr = findAttr(attrs, (a) => !a.namespace && a.name === 'charset');
    const nameAttr = findAttr(attrs, (a) => !a.namespace && a.name === 'name');
    const httpEquivAttr = findAttr(attrs, (a) => !a.namespace && a.name === 'http-equiv');
    if (charsetAttr && !nameAttr && !httpEquivAttr && attrs.length === 1) {
      const value = charsetAttr.value.toLowerCase();
      if (value !== 'utf-8' && value !== 'utf8') return { target: 'meta[charset]' };
      charsetCount += 1;
      if (charsetCount > 1) return { target: 'meta[charset]' };
      continue;
    }
    if (nameAttr && nameAttr.value.toLowerCase() === 'viewport' && attrs.length === 2 && attrs.some((a) => a.name === 'content')) {
      viewportCount += 1;
      if (viewportCount > 1) return { target: 'meta[name=viewport]' };
      continue;
    }
    return { target: 'meta' };
  }
  return null;
}

const HTML_URL_ATTRS = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'imagesrcset',
  'longdesc',
  'poster',
  'profile',
  'src',
  'srcset',
  'usemap',
]);
const SVG_PRESENTATION_URL_ATTRS = new Set(['fill', 'stroke', 'filter', 'clip-path', 'mask', 'cursor', 'marker-start', 'marker-mid', 'marker-end']);
/**
 * `tagName` is an author-controlled identifier with no length limit (custom
 * element names in particular) — always truncate the combined `tag[attr]`
 * form to AC-AI-9's 128-code-point bound before returning it as a `target`.
 */
function elementAttributeTarget(tagName: string, attrName: string): string {
  return truncateArtifactIdentifier(`${tagName}[${attrName}]`);
}

function checkHtmlUrlAttr(tagName: string, attrName: string, value: string): boolean /* true = OK */ {
  const cls = classifyArtifactUrlValue(value);
  if ((tagName === 'a' || tagName === 'area') && attrName === 'href') return isFragmentOnlyOk(cls);
  if ((tagName === 'img' && attrName === 'src') || (tagName === 'video' && attrName === 'poster')) return isDataOnlyOk(cls);
  // Every other HTML URL-bearing (tag, attr) combination is rejected
  // outright: scheme-agnostic for the explicitly-listed dangerous
  // attributes, and "no allowance exists" by default for everything else
  // (allow is enumerate, deny is default).
  return false;
}

/**
 * The HTML url-bearing-attribute table applies "regardless of namespace" to
 * any (tag, attr) pair not already covered by the SVG href/xlink:href or
 * presentation-attribute rules, or the MathML href/definitionURL rules —
 * e.g. a plain (unprefixed) attribute on a MathML element that happens to
 * share a name with an HTML url attribute. `(namespace, tag)`-keyed
 * implementations would let `<math href>` slip through where `<a href>`
 * doesn't; matching by tag name only (as the real table does) closes that.
 */
function checkGenericHtmlUrlAttrs(
  node: DefaultTreeAdapterTypes.Element,
  attrs: readonly ArtifactAttribute[],
  skipHrefLike: boolean,
): ArtifactRuleFailure | null {
  for (const attr of attrs) {
    if (attr.namespace || attr.prefix) continue;
    if (skipHrefLike && isHrefLikeAttr(attr)) continue; // already judged by the MathML href branch above.
    if (!HTML_URL_ATTRS.has(attr.name)) continue;
    if (node.tagName === 'link' && attr.name === 'href' && isGoogleFontsStylesheetLinkElement(node)) continue; // AI-R12 decides.
    if (checkHtmlUrlAttr(node.tagName, attr.name, attr.value)) continue;
    return { target: elementAttributeTarget(node.tagName, attr.name) };
  }
  return null;
}

async function checkAiR11(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  for (const node of walkArtifactTree(context.parsed!.document)) {
    if (!isElementLike(node)) continue;
    const attrs = node.attrs as ArtifactAttribute[];
    const namespace = node.namespaceURI;

    if (namespace === SVG_NS) {
      for (const attr of attrs) {
        if (isHrefLikeAttr(attr)) {
          const cls = classifyArtifactUrlValue(attr.value);
          const target = elementAttributeTarget(node.tagName, `${attr.prefix ? `${attr.prefix}:` : ''}${attr.name}`);
          if (node.tagName === 'image') {
            if (!isDataOnlyOk(cls)) return { target };
          } else if (node.tagName === 'script') {
            return { target };
          } else if (!isFragmentOnlyOk(cls)) {
            return { target };
          }
          continue;
        }
        if (SVG_PRESENTATION_URL_ATTRS.has(attr.name) && !valueContainsOnlyFragmentUrls(attr.value)) {
          return { target: elementAttributeTarget(node.tagName, attr.name) };
        }
      }
      continue;
    }

    if (namespace === MATHML_NS) {
      for (const attr of attrs) {
        if (isHrefLikeAttr(attr)) {
          const cls = classifyArtifactUrlValue(attr.value);
          if (!isFragmentOnlyOk(cls)) return { target: elementAttributeTarget(node.tagName, attr.name) };
          continue;
        }
        if (!attr.prefix && attr.name === 'definitionURL') {
          return { target: elementAttributeTarget(node.tagName, 'definitionURL') };
        }
      }
      // MathML elements aren't otherwise covered — the HTML name table
      // still applies to any plain attribute name it shares with HTML
      // (href/xlink:href were already judged above, so exclude them here).
      const genericFailure = checkGenericHtmlUrlAttrs(node, attrs, true);
      if (genericFailure) return genericFailure;
      continue;
    }

    if (namespace !== HTML_NS) continue;
    const failure = checkGenericHtmlUrlAttrs(node, attrs, false);
    if (failure) return failure;
  }
  return null;
}

async function checkAiR11a(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  for (const node of walkArtifactTree(context.parsed!.document)) {
    if (!isElementLike(node)) continue;
    for (const attr of node.attrs as ArtifactAttribute[]) {
      if (!attr.namespace && attr.name.toLowerCase() === 'xml:base') return { target: 'xml:base' };
    }
  }
  return null;
}

const SVG_ANIMATION_TAGS = new Set(['animate', 'set', 'animateTransform', 'animateMotion']);

async function checkAiR11b(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  for (const node of walkArtifactTree(context.parsed!.document)) {
    if (!isPlainElement(node)) continue;
    if (node.namespaceURI !== SVG_NS || !SVG_ANIMATION_TAGS.has(node.tagName)) continue;
    const attrs = node.attrs as ArtifactAttribute[];
    const attributeNameAttr = findAttr(attrs, (a) => !a.namespace && a.name === 'attributeName');
    if (!attributeNameAttr) continue;
    const targetAttrName = attributeNameAttr.value.toLowerCase();
    const isHrefTarget = targetAttrName === 'href' || targetAttrName === 'xlink:href';
    const isPresentationTarget = SVG_PRESENTATION_URL_ATTRS.has(targetAttrName);
    if (!isHrefTarget && !isPresentationTarget) continue;

    const valuesToCheck: string[] = [];
    for (const key of ['from', 'to', 'by'] as const) {
      const attr = findAttr(attrs, (a) => !a.namespace && a.name === key);
      if (attr) valuesToCheck.push(attr.value);
    }
    const valuesAttr = findAttr(attrs, (a) => !a.namespace && a.name === 'values');
    if (valuesAttr) valuesToCheck.push(...valuesAttr.value.split(';').map((v) => v.trim()));

    for (const value of valuesToCheck) {
      if (isHrefTarget) {
        if (!isFragmentOnlyOk(classifyArtifactUrlValue(value))) return { target: targetAttrName };
      } else if (!valueContainsOnlyFragmentUrls(value)) {
        return { target: targetAttrName };
      }
    }
  }
  return null;
}

async function checkAiR12(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  const markupHasReference = hasGoogleFontsLinkReference(context.parsed!.document);
  const cssAnalysis = analyzeArtifactCss(context);
  const hasReference = markupHasReference || cssAnalysis.hasExemptFontReference;
  if (!hasReference) return null;
  return context.options.allowWebFonts ? null : {};
}

const ALLOWED_SCRIPT_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

async function checkAiR13(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  for (const node of walkArtifactTree(context.parsed!.document)) {
    if (!isPlainElement(node)) continue;
    if (node.tagName !== 'script') continue;
    if (!isHtmlOrSvgNamespace(node.namespaceURI)) continue;
    const attrs = node.attrs as ArtifactAttribute[];
    const typeAttr = findAttr(attrs, (a) => !a.namespace && a.name === 'type');
    const type = (typeAttr?.value ?? '').trim().toLowerCase();
    // `type` is the attribute VALUE the author wrote (e.g. an arbitrary
    // MIME-like string) — AC-AI-9 forbids reflecting attribute values in
    // `target`, so this returns the fixed attribute identifier instead,
    // matching the `meta[charset]` / `meta[name=viewport]` precedent below.
    if (!ALLOWED_SCRIPT_TYPES.has(type)) return { target: 'script[type]' };
  }
  return null;
}

async function checkAiR14(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  for (const node of walkArtifactTree(context.parsed!.document)) {
    if (!isPlainElement(node)) continue;
    if (node.tagName !== 'script') continue;
    if (!isHtmlOrSvgNamespace(node.namespaceURI)) continue;
    const source = concatenateTextChildren(node);
    const failure = await validateModuleSpecifiers(source);
    if (failure) return failure;
  }
  return null;
}

async function checkCssRuleStage(context: Readonly<ArtifactRuleContext>, ruleId: ArtifactRuleId): Promise<ArtifactRuleFailure | null> {
  const analysis = analyzeArtifactCss(context);
  if (analysis.failure && analysis.failure.ruleId === ruleId) return { target: analysis.failure.target };
  return null;
}

function checkAiR21Source(context: Readonly<ArtifactRuleContext>): ArtifactRuleFailure | null {
  const countByName = new Map<string, number>();
  for (const marker of context.parsed!.removedReservedMarkers) {
    countByName.set(marker.name, (countByName.get(marker.name) ?? 0) + 1);
    const validAttrs = marker.attributeNames.every((name) => name === 'name' || name === 'content');
    if (!validAttrs) return { target: truncateArtifactIdentifier(marker.name) };
  }
  for (const [name, count] of countByName) {
    if (count > 1) return { target: truncateArtifactIdentifier(name) };
  }
  return null;
}

function checkAiR21Normalized(context: Readonly<ArtifactRuleContext>): ArtifactRuleFailure | null {
  const document = context.parsed!.document;
  const head = findHeadElement(document);
  if (!head) return { target: 'head' };
  const markerMetas = head.childNodes.filter(
    (node): node is DefaultTreeAdapterTypes.Element => isPlainElement(node) && node.tagName === 'meta' && node.namespaceURI === HTML_NS,
  );
  const byName = new Map<string, DefaultTreeAdapterTypes.Element[]>();
  for (const meta of markerMetas) {
    const nameAttr = findAttr(meta.attrs as ArtifactAttribute[], (a) => !a.namespace && a.name === 'name');
    if (!nameAttr || !RESERVED_MARKER_NAMES.includes(nameAttr.value)) continue;
    const bucket = byName.get(nameAttr.value) ?? [];
    bucket.push(meta);
    byName.set(nameAttr.value, bucket);
  }
  for (const reservedName of RESERVED_MARKER_NAMES) {
    const bucket = byName.get(reservedName) ?? [];
    if (bucket.length !== 1) return { target: truncateArtifactIdentifier(reservedName) };
    const [meta] = bucket;
    const attrs = meta.attrs as ArtifactAttribute[];
    if (attrs.length !== 2 || !attrs.every((a) => a.name === 'name' || a.name === 'content')) {
      return { target: truncateArtifactIdentifier(reservedName) };
    }
  }
  const { scriptDigests, styleDigests } = computeArtifactDigests(document);
  const scriptMeta = byName.get(ARTIFACT_SCRIPT_DIGEST_META_NAME)![0];
  const styleMeta = byName.get(ARTIFACT_STYLE_DIGEST_META_NAME)![0];
  const scriptContent = findAttr(scriptMeta.attrs as ArtifactAttribute[], (a) => a.name === 'content')?.value ?? '';
  const styleContent = findAttr(styleMeta.attrs as ArtifactAttribute[], (a) => a.name === 'content')?.value ?? '';
  if (scriptContent !== scriptDigests.join(' ')) return { target: truncateArtifactIdentifier(ARTIFACT_SCRIPT_DIGEST_META_NAME) };
  if (styleContent !== styleDigests.join(' ')) return { target: truncateArtifactIdentifier(ARTIFACT_STYLE_DIGEST_META_NAME) };

  const reserialized = serializeArtifactTree(document);
  for (const reservedName of RESERVED_MARKER_NAMES) {
    if (countOccurrences(reserialized, reservedName) !== 1) return { target: truncateArtifactIdentifier(reservedName) };
  }
  return null;
}

async function checkAiR21(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  return context.pass === 'source' ? checkAiR21Source(context) : checkAiR21Normalized(context);
}

async function checkAiR22(context: Readonly<ArtifactRuleContext>): Promise<ArtifactRuleFailure | null> {
  // `context.input` is the exact text `context.parsed.document` was parsed
  // from for the current pass — the step-6 `serialized` string for the
  // `'normalized'` pass (see `ingestHtmlArtifact`). Re-serializing the
  // reparsed tree and comparing it to that string is the idempotency check
  // step 8 requires; comparing two `serializeArtifactTree` calls against
  // each other instead (the same deterministic function applied twice to
  // the same tree) can never disagree, so it never rejects anything.
  const reserialized = serializeArtifactTree(context.parsed!.document);
  return reserialized === context.input ? null : {};
}

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------

const BOTH_PARSED: readonly ArtifactValidationPass[] = ['source', 'normalized'];
const BOTH_SOURCES: readonly ('author' | 'stored-revision')[] = ['author', 'stored-revision'];

export const ARTIFACT_INGEST_RULES: readonly ArtifactRuleDefinition[] = [
  {
    id: 'AI-R01a',
    check: checkAiR01a,
    passes: ['pre-parse'],
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 0,
    result: { reason: 'BODY_TOO_LARGE', httpStatus: 413 },
  },
  {
    id: 'AI-R04',
    check: checkAiR04,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 10,
    result: { reason: 'DOCTYPE_INVALID', httpStatus: 400 },
  },
  {
    id: 'AI-R03',
    check: checkAiR03,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 20,
    result: { reason: 'HTML_PARSE_ERROR', httpStatus: 400 },
  },
  {
    id: 'AI-R02',
    check: checkAiR02,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 21,
    result: { reason: 'DOM_LIMIT_EXCEEDED', httpStatus: 413 },
  },
  {
    id: 'AI-R05',
    check: checkAiR05,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 22,
    result: { reason: 'DOCUMENT_STRUCTURE_INVALID', httpStatus: 400 },
  },
  {
    id: 'AI-R07',
    check: checkAiR07,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 23,
    result: { reason: 'ELEMENT_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R07a',
    check: checkAiR07a,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 24,
    result: { reason: 'INLINE_CODE_CONTENT_INVALID', httpStatus: 400 },
  },
  {
    id: 'AI-R08',
    check: checkAiR08,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 25,
    result: { reason: 'ATTRIBUTE_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R09',
    check: checkAiR09,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [{ kind: 'normalizer-marker' }],
    priority: 26,
    result: { reason: 'META_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R11',
    check: checkAiR11,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 27,
    result: { reason: 'EXTERNAL_REFERENCE', httpStatus: 400 },
  },
  {
    id: 'AI-R11a',
    check: checkAiR11a,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 28,
    result: { reason: 'EXTERNAL_REFERENCE', httpStatus: 400 },
  },
  {
    id: 'AI-R11b',
    check: checkAiR11b,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 29,
    result: { reason: 'EXTERNAL_REFERENCE', httpStatus: 400 },
  },
  {
    id: 'AI-R20c',
    check: (ctx) => checkCssRuleStage(ctx, 'AI-R20c'),
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 30,
    result: { reason: 'CSS_SOURCE_TOO_LARGE', httpStatus: 413 },
  },
  {
    id: 'AI-R20b',
    check: (ctx) => checkCssRuleStage(ctx, 'AI-R20b'),
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 31,
    result: { reason: 'CSS_VALUE_DEPTH_EXCEEDED', httpStatus: 413 },
  },
  {
    id: 'AI-R15',
    check: (ctx) => checkCssRuleStage(ctx, 'AI-R15'),
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 32,
    result: { reason: 'CSS_PARSE_ERROR', httpStatus: 400 },
  },
  {
    id: 'AI-R16',
    check: (ctx) => checkCssRuleStage(ctx, 'AI-R16'),
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 33,
    result: { reason: 'CSS_AT_RULE_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R17',
    check: (ctx) => checkCssRuleStage(ctx, 'AI-R17'),
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 34,
    result: { reason: 'CSS_FUNCTION_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R18',
    check: (ctx) => checkCssRuleStage(ctx, 'AI-R18'),
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 35,
    result: { reason: 'CSS_STRING_ARGUMENT_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R19',
    check: (ctx) => checkCssRuleStage(ctx, 'AI-R19'),
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 36,
    result: { reason: 'URL_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R20a',
    check: (ctx) => checkCssRuleStage(ctx, 'AI-R20a'),
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 37,
    result: { reason: 'CSS_VALUE_NODE_LIMIT_EXCEEDED', httpStatus: 413 },
  },
  {
    id: 'AI-R12',
    check: checkAiR12,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 40,
    result: { reason: 'FONT_REFERENCE_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R13',
    check: checkAiR13,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 41,
    result: { reason: 'SCRIPT_TYPE_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R14',
    check: checkAiR14,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 42,
    result: { reason: 'MODULE_SPECIFIER_FORBIDDEN', httpStatus: 400 },
  },
  {
    id: 'AI-R21',
    check: checkAiR21,
    passes: BOTH_PARSED,
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 43,
    result: { reason: 'NORMALIZER_MARKER_INVALID', httpStatus: 400 },
  },
  {
    id: 'AI-R22',
    check: checkAiR22,
    passes: ['normalized'],
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 44,
    result: { reason: 'NORMALIZATION_NOT_IDEMPOTENT', httpStatus: 400 },
  },
  {
    id: 'AI-R01',
    check: checkAiR01,
    passes: ['normalized'],
    sources: BOTH_SOURCES,
    ownedExemptions: [],
    priority: 45,
    result: { reason: 'BODY_TOO_LARGE', httpStatus: 413 },
  },
];

export async function runArtifactRules(context: Readonly<ArtifactRuleContext>): Promise<ArtifactIngestRejection | null> {
  const applicable = ARTIFACT_INGEST_RULES.filter((rule) => rule.passes.includes(context.pass) && rule.sources.includes(context.source))
    .slice()
    .sort((a, b) => a.priority - b.priority);
  for (const rule of applicable) {
    const failure = await rule.check(context, rule);
    if (failure) {
      return { ruleId: rule.id, reason: rule.result.reason, httpStatus: rule.result.httpStatus, target: failure.target };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ingestHtmlArtifact
// ---------------------------------------------------------------------------

function assertTrustedOptions(options: Readonly<ArtifactIngestOptions>): void {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < ARTIFACT_MIN_MAX_BYTES || options.maxBytes > ARTIFACT_HARD_MAX_BYTES) {
    throw new ArtifactInternalError(`ingestHtmlArtifact: options.maxBytes out of range (${options.maxBytes})`);
  }
  if (options.source !== 'author' && options.source !== 'stored-revision') {
    throw new ArtifactInternalError(`ingestHtmlArtifact: options.source invalid (${String(options.source)})`);
  }
}

type ArtifactSourcePassResult =
  | {
      readonly ok: true;
      readonly serialized: string;
      readonly bytes: Uint8Array;
      readonly scriptDigests: readonly string[];
      readonly styleDigests: readonly string[];
    }
  | { readonly ok: false; readonly rejection: ArtifactIngestRejection };

/**
 * Parses, validates, and normalizes the `'source'` pass inside its own call
 * frame. The `'source'`-mode `ParsedArtifactDocument` (and the
 * `ArtifactRuleContext` wrapping it) are local to this function and become
 * unreachable the moment it returns — `ingestHtmlArtifact` never holds a
 * reference to the source tree while the normalized tree is being parsed, so
 * the two trees are never simultaneously live (§解析・正規化アルゴリズム:
 * "1 回目 tree の参照を解放してから 2 回目 tree を作り、2 tree を同時保持
 * しない").
 */
async function runSourcePass(working: string, options: Readonly<ArtifactIngestOptions>): Promise<ArtifactSourcePassResult> {
  const sourceParsed = parseArtifactDocument(working, 'source');
  if (!isParsedDocument(sourceParsed)) return { ok: false, rejection: sourceParsed };

  const sourceContext: ArtifactRuleContext = {
    pass: 'source',
    source: options.source,
    input: working,
    options,
    parsed: sourceParsed,
    ownership: { exemptReservedMarker: true },
  };
  const sourceRejection = await runArtifactRules(sourceContext);
  if (sourceRejection) return { ok: false, rejection: sourceRejection };

  const normalized = normalizeArtifactTree(sourceParsed);
  return { ok: true, ...normalized };
}

export async function ingestHtmlArtifact(input: string, options: Readonly<ArtifactIngestOptions>): Promise<ArtifactIngestResult> {
  assertTrustedOptions(options);

  const preParseContext: ArtifactRuleContext = {
    pass: 'pre-parse',
    source: options.source,
    input,
    options,
    ownership: { exemptReservedMarker: true },
  };
  const preParseRejection = await runArtifactRules(preParseContext);
  if (preParseRejection) return { ok: false, rejection: preParseRejection };

  let working = input;
  if (working.charCodeAt(0) === 0xfeff) working = working.slice(1);
  working = artifactParserSeam.normalizeNewlines(working);

  const sourcePassResult = await runSourcePass(working, options);
  if (!sourcePassResult.ok) return { ok: false, rejection: sourcePassResult.rejection };
  const { serialized, bytes, scriptDigests, styleDigests } = sourcePassResult;

  const normalizedParsed = parseArtifactDocument(serialized, 'normalized');
  if (!isParsedDocument(normalizedParsed)) return { ok: false, rejection: normalizedParsed };

  // `input` is the string each pass's tree was parsed from — `working`
  // (post BOM-strip/newline-normalize) for `'source'`, `serialized` (the
  // step-6 output) for `'normalized'`. AI-R22 relies on the latter to
  // detect non-idempotent normalization (see `checkAiR22`).
  const normalizedContext: ArtifactRuleContext = {
    pass: 'normalized',
    source: options.source,
    input: serialized,
    options,
    parsed: normalizedParsed,
    ownership: { exemptReservedMarker: true },
  };
  const normalizedRejection = await runArtifactRules(normalizedContext);
  if (normalizedRejection) return { ok: false, rejection: normalizedRejection };

  return { ok: true, bytes, scriptDigests, styleDigests };
}
