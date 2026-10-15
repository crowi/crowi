import type { Element, Root } from 'hast';
import { raw } from 'hast-util-raw';
import { sanitize } from 'hast-util-sanitize';
import type { Schema } from 'hast-util-sanitize';
import { VFile } from 'vfile';
import { isGeneratedHtmlOrigin } from '../util/generated-html';
import type { AnchorProvenance } from './anchors';
import { collectGeneratedAnchorValues, filterAuthorAnchorAttributes } from './anchors';
import type { LNode, SanitizeFailure } from './model';
import {
  ALLOWED_TAGS,
  ANCHOR_CARRIER_TAGS,
  CODE_CONTENT_TAGS,
  FLOW_CONTAINERS,
  HEADING_TAGS,
  NONCE_RE,
  PHRASING_TAGS,
  SLOT_PROPERTY,
  SanitizeFailureError,
  emptyRoot,
  isRecord,
  utf8Length,
} from './model';
import type { OwnerEntry } from './owners';
import { buildOwnerEntry } from './owners';
import { classifyAuthoredRaw, escapeUnknownRawHtml } from './raw-classify';
import { sanitizeDisplayUrl, validateImageDisplayProps } from './url';
import { validateWebRenderInput } from './validate';

export type HtmlSanitizationPolicy = 'strict';

export interface SanitizeWebHastResult {
  tree: Root;
  failure?: SanitizeFailure;
}

export const STRICT_HTML_SCHEMA: Schema = {
  tagNames: [...ALLOWED_TAGS],
  attributes: {
    '*': ['title', 'lang', 'dir', 'id'],
    a: ['name'],
    img: ['alt', 'width', 'height', 'dataCrowiImageWidth', 'dataCrowiImageHeight', 'dataCrowiImageAlign', 'dataCrowiImageFloat'],
    ol: ['start', 'reversed', 'type'],
    li: ['value'],
    p: ['align'],
    div: ['align'],
    h1: ['align'],
    h2: ['align'],
    h3: ['align'],
    h4: ['align'],
    h5: ['align'],
    h6: ['align'],
    td: ['colSpan', 'rowSpan', 'align'],
    th: ['colSpan', 'rowSpan', 'align', 'scope'],
    col: ['span'],
    colgroup: ['span'],
    details: ['open'],
    time: ['dateTime'],
  },
  // href/src are validated and set by `sanitizeDisplayUrl`, never by the
  // library's protocol check (which would drop tel:/slack:// links).
  protocols: {},
  strip: [...CODE_CONTENT_TAGS],
  required: {},
  clobber: [],
  ancestors: {},
  allowComments: false,
  allowDoctypes: false,
};

// ---------------------------------------------------------------------------
// call-local state

interface Owner {
  entry: OwnerEntry;
  /** Set once an element has taken the generated id/name (first surviving clone). */
  claimed: boolean;
}

export interface SanitizeContext {
  nonce: string;
  /** Issued generated-fragment sources, by slot index. */
  slots: Map<number, string>;
  usedSlots: Set<number>;
  /** Virtual source offset of an element start → what `toHast` made there. */
  owners: Map<number, Owner>;
  synthetic: WeakSet<LNode>;
  /** Parts of the parse input by virtual offset (to strip synthetic newlines). */
  parts: Array<{ offset: number; length: number; kind: 'text' | 'raw' | 'synthetic' }>;
  provenance: AnchorProvenance;
}

function newContext(nonce: string): SanitizeContext {
  return {
    nonce,
    slots: new Map(),
    usedSlots: new Set(),
    owners: new Map(),
    synthetic: new WeakSet(),
    parts: [],
    provenance: { generated: new WeakSet(), owned: new WeakSet() },
  };
}

// ---------------------------------------------------------------------------
// input clone + slot extraction

function cloneTree(node: LNode): LNode {
  const out: LNode = { type: node.type };
  if (node.value !== undefined) out.value = node.value;
  if (node.tagName !== undefined) out.tagName = node.tagName;
  if (node.properties) out.properties = { ...node.properties };
  if (node.data) out.data = node.data;
  // A `template` carries its body in `content`; the parse input has no such
  // field, so the body is folded into `children` (the parser re-creates it).
  const kids = [...(node.children ?? []), ...(node.content?.children ?? [])];
  if (node.children !== undefined || node.content !== undefined) out.children = kids.map(cloneTree);
  return out;
}

function extractSlots(root: LNode, ctx: SanitizeContext): void {
  const visit = (parent: LNode): void => {
    const children = parent.children;
    if (!children) return;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i] as LNode;
      if (child.type === 'raw' && typeof child.value === 'string' && isGeneratedHtmlOrigin(child.data?.g)) {
        const index = ctx.slots.size;
        ctx.slots.set(index, child.value);
        children[i] = { type: 'element', tagName: 'span', properties: { [SLOT_PROPERTY]: `${ctx.nonce}:${index}` }, children: [] };
      } else if (child.children) {
        visit(child);
      }
    }
  };
  visit(root);
}

/** Inserts the reset newline before every element that follows raw or a carrier (R-2b). */
function insertResetNewlines(root: LNode, ctx: SanitizeContext): void {
  let seenRawOrCarrier = false;
  const visit = (parent: LNode): void => {
    const children = parent.children;
    if (!children) return;
    const next: LNode[] = [];
    for (const child of children) {
      if (child.type === 'raw') seenRawOrCarrier = true;
      if (child.type === 'element') {
        const isCarrier = typeof child.properties?.[SLOT_PROPERTY] === 'string';
        if (isCarrier || seenRawOrCarrier) {
          const reset: LNode = { type: 'text', value: '\n' };
          ctx.synthetic.add(reset);
          next.push(reset);
        }
        if (isCarrier) seenRawOrCarrier = true;
        visit(child);
      }
      next.push(child);
    }
    parent.children = next;
  };
  visit(root);
}

function virtualPoint(offset: number): { line: number; column: number; offset: number } {
  return { line: 1, column: offset + 1, offset };
}

/** Assigns the virtual positions and records the owner table (R-2b). */
function assignPositions(root: LNode, ctx: SanitizeContext): void {
  let cursor = 1;
  const visit = (node: LNode): void => {
    if (node.type === 'text' || node.type === 'raw' || node.type === 'comment') {
      const value = typeof node.value === 'string' ? node.value : '';
      const offset = cursor;
      node.position = { start: virtualPoint(offset), end: virtualPoint(offset + value.length) };
      if (node.type !== 'comment')
        ctx.parts.push({ offset, length: value.length, kind: ctx.synthetic.has(node) ? 'synthetic' : node.type === 'raw' ? 'raw' : 'text' });
      cursor += value.length + 1;
      return;
    }
    if (node.type !== 'element') return;
    const start = cursor;
    cursor += 2;
    for (const child of node.children ?? []) visit(child);
    const end = cursor;
    cursor += 2;
    node.position = { start: virtualPoint(start), end: virtualPoint(end) };
    const isCarrier = typeof node.properties?.[SLOT_PROPERTY] === 'string';
    if (!isCarrier) ctx.owners.set(start, { entry: buildOwnerEntry(String(node.tagName).toLowerCase(), node.properties ?? {}), claimed: false });
  };
  for (const child of root.children ?? []) visit(child);
  root.position = { start: virtualPoint(0), end: virtualPoint(cursor) };
}

// ---------------------------------------------------------------------------
// parse

export interface PreparedParse {
  tree: LNode;
  ctx: SanitizeContext;
}

function isDocumentMode(root: LNode): boolean {
  const head = root.children?.[0];
  return !!head && (head.type === 'doctype' || (head.type === 'element' && String(head.tagName).toLowerCase() === 'html'));
}

/** Clone + slot extraction + classification + reset newlines + virtual positions. */
export function prepareAuthoredTree(input: Root, nonce: string): PreparedParse {
  const tree = cloneTree(input as unknown as LNode);
  if (isDocumentMode(tree)) throw new SanitizeFailureError('invalid-input');
  const ctx = newContext(nonce);
  extractSlots(tree, ctx);
  escapeUnknownRawHtml(tree);
  classifyAuthoredRaw(tree);
  insertResetNewlines(tree, ctx);
  assignPositions(tree, ctx);
  return { tree, ctx };
}

/** One `raw()` pass; synthetic newlines are removed from the parsed text afterwards. */
export function parseAuthoredHast(prepared: PreparedParse): LNode {
  let parsed: LNode;
  try {
    parsed = raw(prepared.tree as unknown as Root, { file: new VFile('') }) as unknown as LNode;
  } catch {
    throw new SanitizeFailureError('parse-failed');
  }
  stripSyntheticNewlines(parsed, prepared.ctx);
  return parsed;
}

function stripSyntheticNewlines(root: LNode, ctx: SanitizeContext): void {
  const synthetic = ctx.parts.filter((p) => p.kind === 'synthetic');
  if (synthetic.length === 0) return;
  const syntheticOffsets = new Set(synthetic.map((p) => p.offset));
  // parts are produced in ascending offset order
  const parts = ctx.parts;
  const stack: LNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as LNode;
    const kids = node.children;
    if (kids) for (const kid of kids) stack.push(kid);
    if (node.content?.children) stack.push(node.content);
    if (node.type !== 'text' || typeof node.value !== 'string') continue;
    const pos = node.position as { start?: { offset?: number }; end?: { offset?: number } } | undefined;
    const a = pos?.start?.offset;
    const b = pos?.end?.offset;
    if (a === undefined || b === undefined) continue;
    // binary search for the first part at or after `a`
    let lo = 0;
    let hi = parts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((parts[mid] as { offset: number }).offset < a) lo = mid + 1;
      else hi = mid;
    }
    // A text node may start inside a raw part (after its tags): that part's
    // emitted length is unknowable, so only the trailing newline is certain.
    const covering = lo > 0 ? (parts[lo - 1] as { offset: number; length: number; kind: string }) : undefined;
    let uncertain = !!covering && covering.kind === 'raw' && covering.offset + covering.length > a;
    let index = 0;
    const removals: number[] = [];
    let lastSyntheticEnd = -1;
    for (let k = lo; k < parts.length; k += 1) {
      const part = parts[k] as { offset: number; length: number; kind: string };
      if (part.offset >= b) break;
      if (part.kind === 'raw') {
        uncertain = true;
        continue;
      }
      if (syntheticOffsets.has(part.offset)) {
        removals.push(index);
        lastSyntheticEnd = part.offset + part.length;
      }
      index += part.length;
    }
    if (removals.length === 0) continue;
    let value = node.value;
    if (uncertain) {
      // Only the trailing reset newline can be located with confidence.
      if (lastSyntheticEnd === b && value.endsWith('\n')) value = value.slice(0, -1);
    } else {
      for (let r = removals.length - 1; r >= 0; r -= 1) {
        const at = removals[r] as number;
        if (value[at] === '\n') value = value.slice(0, at) + value.slice(at + 1);
      }
    }
    node.value = value;
  }
}

// ---------------------------------------------------------------------------
// attribute validation

const ALIGN_BLOCK: ReadonlySet<string> = new Set(['left', 'center', 'right', 'justify']);
const ALIGN_CELL: ReadonlySet<string> = new Set(['left', 'center', 'right']);
const OL_TYPES: ReadonlySet<string> = new Set(['1', 'a', 'A', 'i', 'I']);
const TH_SCOPES: ReadonlySet<string> = new Set(['row', 'col', 'rowgroup', 'colgroup']);
const LANG_RE = /^[A-Za-z0-9-]{1,35}$/;

function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

function intIn(value: unknown, min: number, max: number): number | undefined {
  const n = toInteger(value);
  return n !== undefined && n >= min && n <= max ? n : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Validated values of the attributes an author may write, by HAST property name. */
function authoredAttributes(tag: string, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  set('title', str(props.title));
  const lang = str(props.lang);
  if (lang !== undefined && LANG_RE.test(lang)) out.lang = lang;
  const dir = str(props.dir)?.toLowerCase();
  if (dir === 'ltr' || dir === 'rtl' || dir === 'auto') out.dir = dir;
  set('id', str(props.id));

  switch (tag) {
    case 'a':
      set('name', str(props.name));
      break;
    case 'img': {
      set('alt', str(props.alt));
      set('width', intIn(props.width, 1, 4096));
      set('height', intIn(props.height, 1, 4096));
      const layout = validateImageDisplayProps(props);
      set('dataCrowiImageWidth', layout.width);
      set('dataCrowiImageHeight', layout.height);
      set('dataCrowiImageAlign', layout.align);
      set('dataCrowiImageFloat', layout.float);
      break;
    }
    case 'ol': {
      set('start', intIn(props.start, -2147483648, 2147483647));
      if (props.reversed === true || props.reversed === '') out.reversed = true;
      const type = str(props.type);
      if (type !== undefined && OL_TYPES.has(type)) out.type = type;
      break;
    }
    case 'li':
      set('value', intIn(props.value, -2147483648, 2147483647));
      break;
    case 'p':
    case 'div':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const align = str(props.align)?.toLowerCase();
      if (align !== undefined && ALIGN_BLOCK.has(align)) out.align = align;
      break;
    }
    case 'td':
    case 'th': {
      set('colSpan', intIn(props.colSpan, 1, 1000));
      set('rowSpan', intIn(props.rowSpan, 1, 1000));
      const align = str(props.align)?.toLowerCase();
      if (align !== undefined && ALIGN_CELL.has(align)) out.align = align;
      if (tag === 'th') {
        const scope = str(props.scope);
        if (scope !== undefined && TH_SCOPES.has(scope)) out.scope = scope;
      }
      break;
    }
    case 'col':
    case 'colgroup':
      set('span', intIn(props.span, 1, 1000));
      break;
    case 'details':
      if (props.open === true || props.open === '') out.open = true;
      break;
    case 'time': {
      const dateTime = str(props.dateTime);
      if (dateTime !== undefined && dateTime !== '' && utf8Length(dateTime) <= 256) out.dateTime = dateTime;
      break;
    }
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// sanitize walk

const ownerKey = (node: LNode): { offset: number; tag: string } | undefined => {
  const offset = (node.position as { start?: { offset?: number } } | undefined)?.start?.offset;
  return typeof offset === 'number' ? { offset, tag: String(node.tagName).toLowerCase() } : undefined;
};

function textNode(value: string): LNode {
  return { type: 'text', value };
}

function mergeText(nodes: LNode[]): LNode[] {
  const out: LNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === 'text' && prev?.type === 'text') prev.value = String(prev.value) + String(node.value);
    else out.push(node);
  }
  return out;
}

function collectText(node: LNode, parts: string[]): void {
  if (node.type === 'text' && typeof node.value === 'string') {
    parts.push(node.value);
    return;
  }
  if (node.type !== 'element') {
    for (const child of node.children ?? []) collectText(child, parts);
    return;
  }
  const tag = String(node.tagName).toLowerCase();
  if (CODE_CONTENT_TAGS.has(tag)) return;
  const kids = tag === 'template' ? (node.content?.children ?? node.children ?? []) : (node.children ?? []);
  for (const child of kids) collectText(child, parts);
}

function slotIndexOf(node: LNode, ctx: SanitizeContext): number | undefined {
  const value = node.properties?.[SLOT_PROPERTY];
  if (node.tagName !== 'span' || typeof value !== 'string') return undefined;
  const sep = value.indexOf(':');
  if (sep < 0) return undefined;
  const nonce = value.slice(0, sep);
  const index = value.slice(sep + 1);
  if (nonce !== ctx.nonce || !/^\d+$/.test(index)) return undefined;
  const n = Number(index);
  if (!ctx.slots.has(n) || ctx.usedSlots.has(n)) return undefined;
  return n;
}

function walkChildren(children: LNode[], ctx: SanitizeContext): LNode[] {
  const out: LNode[] = [];
  for (const child of children) out.push(...walk(child, ctx));
  return mergeText(out);
}

function walk(node: LNode, ctx: SanitizeContext): LNode[] {
  if (node.type === 'text') return typeof node.value === 'string' && node.value !== '' ? [textNode(node.value)] : [];
  if (node.type !== 'element') return [];

  const tag = String(node.tagName).toLowerCase();
  const props = node.properties ?? {};
  const children = node.children ?? [];

  const slot = slotIndexOf(node, ctx);
  if (slot !== undefined) {
    ctx.usedSlots.add(slot);
    // Anything the parser attached to a carrier is author content.
    return [{ type: 'crowiSlot', value: slot }, ...walkChildren(children, ctx)];
  }
  if (CODE_CONTENT_TAGS.has(tag)) return [];
  if (tag === 'select') {
    const parts: string[] = [];
    for (const child of children) collectText(child, parts);
    if (node.content) for (const child of node.content.children ?? []) collectText(child, parts);
    const text = parts.join('');
    return text === '' ? [] : [textNode(text)];
  }
  if (tag === 'template') return walkChildren(node.content?.children ?? children, ctx);
  if (!ALLOWED_TAGS.has(tag)) return walkChildren(children, ctx);

  const key = ownerKey(node);
  const owner = key && ctx.owners.get(key.offset)?.entry.tagName === key.tag ? (ctx.owners.get(key.offset) as Owner) : undefined;

  if (tag === 'input') {
    // Only a checkbox the Markdown pipeline itself produced survives.
    if (!owner || owner.entry.fixed.type !== 'checkbox') return [];
  }
  if (tag === 'bdo') {
    const dir = typeof props.dir === 'string' ? props.dir.toLowerCase() : '';
    if (dir !== 'ltr' && dir !== 'rtl') return walkChildren(children, ctx);
  }

  const attrs = authoredAttributes(tag, props);
  if (owner) {
    // The owner table is the authority for id/name on generated structure.
    delete attrs.id;
    delete attrs.name;
  }

  if (tag === 'img') {
    const src = sanitizeDisplayUrl(props.src, 'src');
    if (src === undefined) {
      const alt = typeof props.alt === 'string' ? props.alt : '';
      return alt === '' ? [] : [textNode(alt)];
    }
    return [finishElement(tag, attrs, { src }, [], owner, ctx)];
  }

  const extra: Record<string, unknown> = {};
  if (tag === 'a') {
    const href = sanitizeDisplayUrl(props.href, 'href');
    if (href !== undefined) extra.href = href;
  }

  const kids = walkChildren(children, ctx);
  return [finishElement(tag, attrs, extra, kids, owner, ctx)];
}

function finishElement(
  tag: string,
  attrs: Record<string, unknown>,
  extra: Record<string, unknown>,
  children: LNode[],
  owner: Owner | undefined,
  ctx: SanitizeContext,
): LNode {
  const shell = sanitize(
    { type: 'element', tagName: tag, properties: attrs as Element['properties'], children: [] } as Element,
    STRICT_HTML_SCHEMA,
  ) as unknown as LNode;
  const element: LNode = { type: 'element', tagName: tag, properties: { ...(shell.properties ?? {}), ...extra }, children };
  if (!owner) return element;

  const { entry } = owner;
  Object.assign(element.properties as Record<string, unknown>, entry.fixed);
  let ownedAnchor = false;
  if (!owner.claimed) {
    // Clones the parser makes share one start offset; only the first gets the id.
    if (entry.id !== undefined) {
      (element.properties as Record<string, unknown>).id = entry.id;
      ownedAnchor = true;
    }
    if (entry.name !== undefined) {
      (element.properties as Record<string, unknown>).name = entry.name;
      ownedAnchor = true;
    }
    if (entry.sectionId !== undefined) {
      const heading = children.find((c) => c.type === 'element' && HEADING_TAGS.has(String(c.tagName)));
      if (heading && heading.properties?.id === entry.sectionId && ctx.provenance.owned.has(heading)) {
        (element.properties as Record<string, unknown>).dataSectionId = entry.sectionId;
        ownedAnchor = true;
      }
    }
    if (entry.id !== undefined || entry.name !== undefined || entry.sectionId !== undefined) owner.claimed = true;
  }
  if (ownedAnchor) ctx.provenance.owned.add(element);
  return element;
}

/** Applies the strict allow-list to a parsed author tree; generated slots stay as `crowiSlot` nodes. */
export function sanitizeAuthoredTree(parsed: LNode, ctx: SanitizeContext): LNode {
  return { type: 'root', children: walkChildren(parsed.children ?? [], ctx) };
}

// ---------------------------------------------------------------------------
// composition of generated fragments

type Item = LNode | { hoist: LNode[]; levels: number };

const isHoist = (item: Item): item is { hoist: LNode[]; levels: number } => 'hoist' in item;

function parseFragment(source: string): LNode[] {
  try {
    const parsed = raw({ type: 'root', children: [{ type: 'raw', value: source }] } as unknown as Root) as unknown as LNode;
    return parsed.children ?? [];
  } catch {
    throw new SanitizeFailureError('parse-failed');
  }
}

function markGenerated(nodes: LNode[], ctx: SanitizeContext): void {
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop() as LNode;
    if (node.type === 'element') {
      ctx.provenance.generated.add(node);
      delete node.position;
    } else {
      delete node.position;
    }
    if (node.children) stack.push(...node.children);
    if (node.content?.children) stack.push(...node.content.children);
  }
}

function containsAnchor(nodes: LNode[]): boolean {
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop() as LNode;
    if (node.type === 'element' && node.tagName === 'a') return true;
    if (node.children) stack.push(...node.children);
  }
  return false;
}

function isFlowNode(node: LNode): boolean {
  return node.type === 'element' && !PHRASING_TAGS.has(String(node.tagName)) && node.tagName !== 'svg' && node.tagName !== 'math';
}

function isBlank(nodes: LNode[]): boolean {
  return nodes.every((n) => n.type === 'text' && String(n.value).trim() === '');
}

function composeNode(node: LNode, stack: LNode[], ctx: SanitizeContext, fragments: Map<number, LNode[]>): Item[] {
  if (node.type === 'crowiSlot') {
    const index = node.value as number;
    let nodes = fragments.get(index);
    if (!nodes) {
      nodes = parseFragment(ctx.slots.get(index) as string);
      markGenerated(nodes, ctx);
      fragments.set(index, nodes);
    }
    const last = stack.length - 1;
    let target = last;
    if (nodes.some(isFlowNode)) {
      let j = last;
      while (j > 0 && !FLOW_CONTAINERS.has(String(stack[j]?.tagName))) j -= 1;
      target = Math.min(target, j);
    }
    if (containsAnchor(nodes)) {
      for (let k = last; k > 0; k -= 1) {
        if (stack[k]?.tagName === 'a') target = Math.min(target, k - 1);
      }
    }
    return target === last ? nodes : [{ hoist: nodes, levels: last - target }];
  }
  if (node.type !== 'element') return [node];

  stack.push(node);
  const items: Item[] = [];
  for (const child of node.children ?? []) items.push(...composeNode(child, stack, ctx, fragments));
  stack.pop();

  if (!items.some(isHoist)) {
    node.children = items as LNode[];
    return [node];
  }
  return splitElement(node, items, ctx);
}

function cloneForSplit(node: LNode, children: LNode[], ctx: SanitizeContext): LNode {
  const clone: LNode = { type: 'element', tagName: node.tagName, properties: { ...(node.properties ?? {}) }, children };
  if (ctx.provenance.owned.has(node)) ctx.provenance.owned.add(clone);
  if (ctx.provenance.generated.has(node)) ctx.provenance.generated.add(clone);
  return clone;
}

/** Splits `node` around hoisted blocks: left, block, right in source order. */
function splitElement(node: LNode, items: Item[], ctx: SanitizeContext): Item[] {
  const pieces: Array<{ element: LNode; empty: boolean }> = [];
  const order: Array<{ piece: number } | { hoist: LNode[]; levels: number }> = [];
  let current: LNode[] = [];
  const flush = (): void => {
    pieces.push({ element: cloneForSplit(node, current, ctx), empty: isBlank(current) });
    order.push({ piece: pieces.length - 1 });
    current = [];
  };
  for (const item of items) {
    if (!isHoist(item)) {
      current.push(item);
    } else if (item.levels === 0) {
      current.push(...item.hoist);
    } else {
      flush();
      order.push({ hoist: item.hoist, levels: item.levels - 1 });
    }
  }
  flush();

  const anchorCarrier = ANCHOR_CARRIER_TAGS.has(String(node.tagName));
  const keep = pieces.map((p) => !p.empty);
  if (anchorCarrier && !keep.some(Boolean)) keep[0] = true;
  const dropKeys = anchorCarrier ? ['id', 'name', 'dataSourceLine'] : ['id', 'name'];
  const firstKept = keep.indexOf(true);
  pieces.forEach((p, i) => {
    const props = p.element.properties as Record<string, unknown>;
    const retains = anchorCarrier ? i === firstKept : i === 0;
    if (!retains) for (const key of dropKeys) delete props[key];
  });

  const out: Item[] = [];
  for (const entry of order) {
    if ('piece' in entry) {
      if (keep[entry.piece]) out.push(pieces[entry.piece]?.element as LNode);
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** Replaces `crowiSlot` nodes with their independently parsed generated fragments. */
export function composeGeneratedFragments(tree: LNode, ctx: SanitizeContext): LNode {
  const fragments = new Map<number, LNode[]>();
  const root: LNode = { type: 'root', children: [] };
  const stack: LNode[] = [root];
  const items: Item[] = [];
  for (const child of tree.children ?? []) items.push(...composeNode(child, stack, ctx, fragments));
  // The root is always a valid target, so nothing is left hoisted.
  root.children = items.flatMap((item) => (isHoist(item) ? item.hoist : [item]));
  return root;
}

// ---------------------------------------------------------------------------
// standalone image figures

function isWhitespaceText(node: LNode): boolean {
  return node.type === 'text' && String(node.value).trim() === '';
}

function imageLayout(img: LNode): { align?: string; float?: string } {
  const props = img.properties ?? {};
  const layout: { align?: string; float?: string } = {};
  if (typeof props.dataCrowiImageAlign === 'string') layout.align = props.dataCrowiImageAlign;
  if (typeof props.dataCrowiImageFloat === 'string') layout.float = props.dataCrowiImageFloat;
  return layout;
}

function stripLayout(img: LNode): void {
  const props = img.properties;
  if (!props) return;
  delete props.dataCrowiImageAlign;
  delete props.dataCrowiImageFloat;
}

function figureProperties(layout: { align?: string; float?: string }): Record<string, unknown> {
  const props: Record<string, unknown> = { className: ['crowi-figure'] };
  // float wins over align
  if (layout.float) props.dataCrowiImageFloat = layout.float;
  else if (layout.align) props.dataCrowiImageAlign = layout.align;
  return props;
}

function synthesizeFigures(root: LNode, ctx: SanitizeContext): void {
  const isFlowContainer = (node: LNode): boolean => node.type === 'root' || (node.type === 'element' && FLOW_CONTAINERS.has(String(node.tagName)));
  const isImg = (node: LNode): boolean => node.type === 'element' && node.tagName === 'img';

  const visit = (parent: LNode): void => {
    const children = parent.children;
    if (!children) return;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i] as LNode;
      if (child.type !== 'element' || ctx.provenance.generated.has(child)) continue;

      if (child.tagName === 'p') {
        const meaningful = (child.children ?? []).filter((c) => !isWhitespaceText(c));
        if (meaningful.length === 1 && isImg(meaningful[0] as LNode)) {
          const img = meaningful[0] as LNode;
          const layout = imageLayout(img);
          stripLayout(img);
          if (layout.align || layout.float) {
            const props = figureProperties(layout);
            const sourceLine = child.properties?.dataSourceLine;
            if (sourceLine !== undefined) props.dataSourceLine = sourceLine;
            const figure: LNode = { type: 'element', tagName: 'figure', properties: props, children: [img] };
            children[i] = figure;
            continue;
          }
        }
      } else if (child.tagName === 'figure') {
        const meaningful = (child.children ?? []).filter((c) => !isWhitespaceText(c));
        if (meaningful.length === 1 && isImg(meaningful[0] as LNode)) {
          const img = meaningful[0] as LNode;
          const layout = imageLayout(img);
          stripLayout(img);
          const props = child.properties as Record<string, unknown>;
          const hasLayout = props.dataCrowiImageAlign !== undefined || props.dataCrowiImageFloat !== undefined;
          if (!hasLayout && (layout.align || layout.float)) Object.assign(props, figureProperties(layout));
        } else {
          for (const c of meaningful) if (isImg(c)) stripLayout(c);
        }
      } else if (isImg(child)) {
        const siblings = children.filter((c) => c !== child);
        const standalone = isFlowContainer(parent) && siblings.every((s) => isWhitespaceText(s) || isFlowNode(s));
        const layout = imageLayout(child);
        stripLayout(child);
        if (standalone && (layout.align || layout.float)) {
          children[i] = { type: 'element', tagName: 'figure', properties: figureProperties(layout), children: [child] };
        }
        continue;
      }
      visit(child);
    }
  };
  // Any remaining img (inline, in links, …) never carries align/float.
  visit(root);
  const stack: LNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as LNode;
    if (node.type === 'element' && node.tagName === 'img' && !ctx.provenance.generated.has(node)) stripLayout(node);
    if (node.children) stack.push(...node.children);
  }
}

// ---------------------------------------------------------------------------
// final shape check

function assertFinalShape(root: LNode): void {
  const onPath = new Set<LNode>();
  const stack: Array<{ node: LNode; exit: boolean }> = [{ node: root, exit: false }];
  while (stack.length > 0) {
    const { node, exit } = stack.pop() as { node: LNode; exit: boolean };
    if (exit) {
      onPath.delete(node);
      continue;
    }
    if (onPath.has(node)) throw new SanitizeFailureError('invalid-input');
    onPath.add(node);
    stack.push({ node, exit: true });
    if (node.type === 'root') {
      if (!Array.isArray(node.children)) throw new SanitizeFailureError('invalid-input');
    } else if (node.type === 'element') {
      if (typeof node.tagName !== 'string' || !isRecord(node.properties) || !Array.isArray(node.children)) throw new SanitizeFailureError('invalid-input');
      if (SLOT_PROPERTY in node.properties) throw new SanitizeFailureError('invalid-input');
      delete node.position;
    } else if (node.type === 'text') {
      if (typeof node.value !== 'string') throw new SanitizeFailureError('invalid-input');
      delete node.position;
      continue;
    } else if (node.type === 'comment' || node.type === 'doctype') {
      continue;
    } else {
      // raw / crowiSlot / anything else must never reach React.
      throw new SanitizeFailureError('invalid-input');
    }
    if (node.content) throw new SanitizeFailureError('invalid-input');
    for (const child of node.children ?? []) stack.push({ node: child, exit: false });
  }
}

// ---------------------------------------------------------------------------
// entry

export function sanitizeWebHast(tree: Root, options: { policy: HtmlSanitizationPolicy; slotNonce: string }): SanitizeWebHastResult {
  // Any other policy value (including one smuggled in from JS) is strict.
  try {
    if (typeof options?.slotNonce !== 'string' || !NONCE_RE.test(options.slotNonce)) throw new SanitizeFailureError('invalid-input');
    const invalid = validateWebRenderInput(tree);
    if (invalid) throw new SanitizeFailureError(invalid);

    const prepared = prepareAuthoredTree(tree, options.slotNonce);
    const parsed = parseAuthoredHast(prepared);
    const sanitized = sanitizeAuthoredTree(parsed, prepared.ctx);
    const composed = composeGeneratedFragments(sanitized, prepared.ctx);
    synthesizeFigures(composed, prepared.ctx);

    const generatedValues = collectGeneratedAnchorValues(composed, prepared.ctx.provenance);
    filterAuthorAnchorAttributes(composed, generatedValues, prepared.ctx.provenance);
    assertFinalShape(composed);

    const result = composed as unknown as Root;
    const resourceFailure = validateWebRenderInput(result);
    if (resourceFailure) throw new SanitizeFailureError(resourceFailure);
    return { tree: result };
  } catch (error) {
    if (error instanceof SanitizeFailureError) return { tree: emptyRoot(), failure: error.code };
    if (error instanceof RangeError) return { tree: emptyRoot(), failure: 'resource-limit' };
    return { tree: emptyRoot(), failure: 'parse-failed' };
  }
}
