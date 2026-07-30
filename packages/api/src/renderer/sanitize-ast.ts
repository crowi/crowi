import {
  AST_INPUT_LIMIT_BYTES,
  AST_MAX_HAST_DEPTH,
  AST_MAX_IMAGE_BASE64_CHARS,
  AST_MAX_TREE_DEPTH,
  AST_OUTPUT_BUDGET_BYTES,
  AST_OUTPUT_WARN_BYTES,
  type AstChildModel,
  type AstPlacement,
  CURRENT_AST_VERSION,
  type CrowiImagePayload,
  CrowiCodeSidecarSchema,
  CrowiDiagramSidecarSchema,
  CrowiLinkCardSidecarSchema,
  CrowiMathSidecarSchema,
  CrowiPlaceholderSidecarSchema,
  HChildrenSchema,
  HNameSchema,
  HPropertiesSchema,
  RENDERED_AST_NODE_DEFS,
  type RenderedAstEnvelope,
  RenderedAstEnvelopeSchema,
  SIDECAR_KEYS,
} from '@crowi/api-contract';
import { sanitizeSvg } from '@crowi/svg-sanitize';
import { SINGLE_ENTRY_REJECT_BYTES } from './cache/mongodb-cache';

/**
 * RFC-0023 / feature-rendered-ast-wire-contract §5-§8 — the sanitising
 * walker that turns a stored bare mdast `Root` into a typed
 * `X-Crowi-Ast-Version: 1` envelope.
 *
 * **When this runs:** ONLY at response-construction time, and only when
 * the request declared `astVersion: 1` (`pickRenderedAstShape`,
 * `util/rendered-ast-negotiation.ts`). Persisted `Revision.renderedAst`
 * and `computeRevisionRenderArtifactsAsync`'s intermediates never pass
 * through here — the walker is a side-effect-free pure function and the
 * legacy (declaration-less) branch remains completely unvalidated.
 *
 * **Total function:** every input — root-shaped or not, oversized,
 * cyclic, adversarial — produces a schema-valid envelope. Envelope-level
 * failure collapses to a single `crowiPlaceholder{kind:'envelope-invalid'}`
 * node (never "absent", never a thrown error / 500); node-level failure
 * degrades just that node (`crowiOpaque` / `crowiPlaceholder`
 * {kind:'validation-failed'}) and leaves the rest of the page intact.
 *
 * **Projection (design doc §5 step 1b / §10):** producers store
 * byte-identical `html` nodes with a typed sidecar on `data`
 * (`crowiCode` / `crowiMath` / `crowiDiagram` / `crowiLinkCard` /
 * `crowiPlaceholder`). The projection replaces such an `html` node with
 * its typed counterpart and drops the `html` value string from the
 * wire; a missing/invalid sidecar leaves the `html` node as-is (a
 * visible opaque placeholder on declared clients). Sidecars are
 * re-validated here — including strict base64 decoding, a second
 * `allowSafeHref: false` SVG sanitisation pass and PNG signature
 * checks — because `addUnifiedPlugin` / `addNodeRenderer` can write
 * arbitrary `data` that never went through the dispatch mapper.
 */

type OutNode = { type: string } & Record<string, unknown>;

export interface SanitizeAstOptions {
  /** Sink for the §7 output-budget warn threshold. Optional; silent when omitted. */
  warn?: (message: string) => void;
}

const VALIDATION_FAILED_LABEL = 'This content could not be displayed.';
const ENVELOPE_INVALID_LABEL = 'This page could not be rendered safely and has been replaced with this placeholder.';
const DEFAULT_RESERVATION = { variant: 'fixed', heightPx: 48 } as const;

/** The fixed envelope-level failure payload (§7). Fresh object per call — callers may mutate responses. */
export function envelopeInvalidEnvelope(): RenderedAstEnvelope {
  return {
    astVersion: CURRENT_AST_VERSION,
    root: {
      type: 'root',
      children: [
        {
          type: 'crowiPlaceholder',
          kind: 'envelope-invalid',
          label: ENVELOPE_INVALID_LABEL,
          reservation: { ...DEFAULT_RESERVATION },
        },
      ],
    },
  };
}

export function sanitizeAst(value: unknown, options: SanitizeAstOptions = {}): RenderedAstEnvelope {
  try {
    // Step 0 — top-level guard: never demote the root itself to
    // `crowiOpaque` (that would break the schema's root constraint).
    if (!isRootLike(value)) return envelopeInvalidEnvelope();
    // Step 0b — coarse input-side DoS gates, BEFORE any recursion. The
    // stringify runs first on purpose: it throws on cycles / poisoned
    // `toJSON`, which the catch below folds into envelope-invalid —
    // without it the iterative depth pass would loop forever on a
    // cyclic "tree".
    const inputJson = JSON.stringify(value);
    if (Buffer.byteLength(inputJson, 'utf8') > AST_INPUT_LIMIT_BYTES) return envelopeInvalidEnvelope();
    if (!depthWithinLimit(value)) return envelopeInvalidEnvelope();

    const rawRoot = value as { children: unknown[]; data?: unknown };
    const children = sanitizeChildren(rawRoot.children, 'flow', false);
    const rootData = sanitizeHastData(rawRoot.data);
    const root: OutNode = { type: 'root', ...(rootData !== undefined ? { data: rootData } : {}), children };
    enforceOutputBudget(root, options.warn);

    const envelope: RenderedAstEnvelope = { astVersion: CURRENT_AST_VERSION, root: root as RenderedAstEnvelope['root'] };
    // Step 7 — the walker's output is schema-conformant by
    // construction; this parse is a type-safety assertion, not a
    // validation gate. If it still throws, the step-0c boundary (the
    // catch below) folds it into envelope-invalid.
    RenderedAstEnvelopeSchema.parse(envelope);
    return envelope;
  } catch {
    // Step 0c — nothing inside sanitizeAst may escape as an exception.
    // (`envelopeInvalidEnvelope` only builds literals, so this boundary
    // itself cannot throw.)
    return envelopeInvalidEnvelope();
  }
}

function isRootLike(value: unknown): value is { type: 'root'; children: unknown[] } {
  return isRecord(value) && value.type === 'root' && Array.isArray(value.children);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Iterative pre-pass limits (§7) — explicit stacks, no recursion, so a
// deep attacker-controlled tree can never stack-overflow before the
// limits are enforced.
// ---------------------------------------------------------------------------

function depthWithinLimit(root: unknown): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    if (item.depth > AST_MAX_TREE_DEPTH) return false;
    if (!isRecord(item.node)) continue;
    const data = item.node.data;
    if (isRecord(data) && Array.isArray(data.hChildren) && !hastDepthWithinLimit(data.hChildren)) return false;
    const children = item.node.children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ node: child, depth: item.depth + 1 });
    }
  }
  return true;
}

function hastDepthWithinLimit(hChildren: unknown[]): boolean {
  const stack: Array<{ node: unknown; depth: number }> = hChildren.map((node) => ({ node, depth: 1 }));
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    if (item.depth > AST_MAX_HAST_DEPTH) return false;
    if (!isRecord(item.node)) continue;
    const children = item.node.children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ node: child, depth: item.depth + 1 });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The walker (§5).
// ---------------------------------------------------------------------------

function sanitizeChildren(children: unknown[], model: AstChildModel, chain: boolean): OutNode[] {
  const out: OutNode[] = [];
  for (const child of children) {
    const result = sanitizeNode(child, model, chain);
    if (Array.isArray(result)) out.push(...result);
    else out.push(result);
  }
  return out;
}

/**
 * `chain` tracks the §6 hoist precondition: true while every ancestor
 * from the nearest flow node down to the current position is
 * `paragraph` → (`emphasis` | `strong` | `delete` | `link`)*. Cards in
 * a `heading` / `tableCell` (chain=false) are NOT projected — they
 * stay `html` (visible placeholder on declared clients, deliberate
 * asymmetry vs the web's parse5 repair).
 */
function sanitizeNode(node: unknown, parentModel: AstChildModel, chain: boolean): OutNode | OutNode[] {
  if (!isRecord(node) || typeof node.type !== 'string') return opaque('invalid-shape', undefined);
  const type = node.type;
  // A nested `root` is never valid content (the registry's `root` entry
  // exists only for the top level).
  if (type === 'root') return opaque('invalid-position', 'root');
  const def = RENDERED_AST_NODE_DEFS[type];
  if (!def) return opaque('unknown-type', truncate64(type));

  if (type === 'html') {
    const projected = tryProject(node, parentModel, chain);
    if (projected) return projected.node;
    // No / invalid / ambiguous sidecar, or an incompatible position
    // without a hoist: stay `html` (§5's "fail safe towards html").
  }

  if (!placementAllows(def.placement, parentModel)) return opaque('invalid-position', truncate64(type));

  // crowiFigure structural data requirement (image-attrs contract).
  let figureData: Record<string, unknown> | undefined;
  if (type === 'crowiFigure') {
    const data = isRecord(node.data) ? node.data : undefined;
    const hProps = data !== undefined ? HPropertiesSchema.safeParse(data.hProperties) : undefined;
    if (!data || data.hName !== 'figure' || !hProps || !hProps.success) return opaque('invalid-shape', 'crowiFigure');
    figureData = { hName: 'figure', hProperties: hProps.data };
  }

  const parsedFields = def.fields.safeParse(node);
  if (!parsedFields.success) return opaque('invalid-shape', truncate64(type));
  const fields: Record<string, unknown> = { ...parsedFields.data };

  // §8 URL allow-list + §10 per-type deep validation. Applied equally
  // to typed nodes arriving directly in the stored AST (unrestricted
  // plugin mutation APIs can write them) and to projection outputs.
  if (type === 'link' || type === 'definition') {
    if (typeof fields.url === 'string' && !isAllowedGeneralUrl(fields.url)) fields.url = '#';
  } else if (type === 'image') {
    if (typeof fields.url !== 'string' || !isAllowedGeneralUrl(fields.url)) return validationFailedPlaceholder();
  } else if (type === 'crowiDiagram') {
    const image = validateImagePayload(fields.image as CrowiImagePayload);
    if (!image) return validationFailedPlaceholder();
    fields.image = image;
  } else if (type === 'crowiLinkCard') {
    const cleaned = validateCardFields(fields);
    if (!cleaned) return validationFailedPlaceholder();
    for (const key of Object.keys(fields)) delete fields[key];
    Object.assign(fields, cleaned);
  }

  const data = type === 'crowiFigure' ? figureData : type === 'code' ? sanitizeCodeData(node.data) : sanitizeHastData(node.data);

  let children: OutNode[] | undefined;
  if (def.childModel !== 'none') {
    const rawChildren = Array.isArray(node.children) ? node.children : [];
    children = sanitizeChildren(rawChildren, def.childModel, childChain(type, chain));
  }

  const out: OutNode = {
    type,
    ...fields,
    ...(data !== undefined ? { data } : {}),
    ...(children !== undefined ? { children } : {}),
  };

  // §6 — hoist projected cards out of the paragraph subtree.
  if (type === 'paragraph' && children !== undefined && subtreeHasCard(out)) {
    return splitParent(out);
  }
  return out;
}

function placementAllows(placement: AstPlacement, parentModel: AstChildModel): boolean {
  switch (parentModel) {
    case 'flow':
      return placement === 'flow' || placement === 'both';
    case 'phrasing':
      return placement === 'phrasing' || placement === 'both';
    case 'listItems':
      return placement === 'listItems';
    case 'tableRows':
      return placement === 'tableRows';
    case 'tableCells':
      return placement === 'tableCells';
    default:
      return false;
  }
}

function childChain(parentType: string, currentChain: boolean): boolean {
  if (parentType === 'paragraph') return true;
  if (parentType === 'emphasis' || parentType === 'strong' || parentType === 'delete' || parentType === 'link') return currentChain;
  return false;
}

function opaque(reason: 'unknown-type' | 'invalid-shape' | 'invalid-position', originalType: string | undefined): OutNode {
  return { type: 'crowiOpaque', reason, ...(originalType !== undefined ? { originalType } : {}) };
}

function truncate64(value: string): string {
  // MUST truncate before assignment (§5) — a 65+-char third-party type
  // string would otherwise fail the post-walk `.parse()` and collapse
  // the whole envelope for one unknown node.
  return value.length > 64 ? value.slice(0, 64) : value;
}

function validationFailedPlaceholder(): OutNode {
  return { type: 'crowiPlaceholder', kind: 'validation-failed', label: VALIDATION_FAILED_LABEL, reservation: { ...DEFAULT_RESERVATION } };
}

// ---------------------------------------------------------------------------
// `data` sanitisation (§4) — bounded per-key validation. Keys that fail
// their bound are silently dropped (never a reason to opaque the node);
// unlisted sub-keys (including sidecar keys on non-projected nodes) are
// dropped by construction.
// ---------------------------------------------------------------------------

function sanitizeHastData(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  const out: Record<string, unknown> = {};
  if (data.hName !== undefined) {
    const parsed = HNameSchema.safeParse(data.hName);
    if (parsed.success) out.hName = parsed.data;
  }
  if (data.hProperties !== undefined) {
    const parsed = HPropertiesSchema.safeParse(data.hProperties);
    if (parsed.success) out.hProperties = parsed.data;
  }
  if (data.hChildren !== undefined) {
    const parsed = HChildrenSchema.safeParse(data.hChildren);
    if (parsed.success) out.hChildren = parsed.data;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `code` additionally preserves the dispatch retry marker (`renderPending`). */
function sanitizeCodeData(data: unknown): Record<string, unknown> | undefined {
  const out = sanitizeHastData(data) ?? {};
  if (isRecord(data) && typeof data.renderPending === 'boolean') out.renderPending = data.renderPending;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Projection (§5 step 1b / §10 projection table).
// ---------------------------------------------------------------------------

function tryProject(node: Record<string, unknown>, parentModel: AstChildModel, chain: boolean): { node: OutNode } | null {
  const data = node.data;
  if (!isRecord(data)) return null;
  const present = SIDECAR_KEYS.filter((key) => data[key] !== undefined);
  if (present.length !== 1) return null;
  const key = present[0];
  const payload = data[key];
  // `data.hProperties` (etc.) carry over to the projected node — this is
  // load-bearing for preview scroll-sync on display math (§10).
  const carried = sanitizeHastData(data);

  switch (key) {
    case 'crowiCode': {
      if (parentModel !== 'flow') return null;
      const parsed = CrowiCodeSidecarSchema.safeParse(payload);
      if (!parsed.success) return null;
      const { lang, value, tokens } = parsed.data;
      return {
        node: {
          type: 'code',
          ...(lang !== undefined ? { lang } : {}),
          value,
          data: { ...(carried ?? {}), tokens },
        },
      };
    }
    case 'crowiMath': {
      const parsed = CrowiMathSidecarSchema.safeParse(payload);
      if (!parsed.success) return null;
      const wantsFlow = parsed.data.display;
      if (wantsFlow && parentModel !== 'flow') return null;
      if (!wantsFlow && parentModel !== 'phrasing') return null;
      return {
        node: {
          type: wantsFlow ? 'math' : 'inlineMath',
          value: parsed.data.tex,
          ...(carried !== undefined ? { data: carried } : {}),
        },
      };
    }
    case 'crowiDiagram': {
      if (parentModel !== 'flow') return null;
      const parsed = CrowiDiagramSidecarSchema.safeParse(payload);
      if (!parsed.success) return null;
      const image = validateImagePayload(parsed.data.image);
      if (!image) return { node: validationFailedPlaceholder() };
      return {
        node: {
          type: 'crowiDiagram',
          ...parsed.data,
          image,
          ...(carried !== undefined ? { data: carried } : {}),
        },
      };
    }
    case 'crowiLinkCard': {
      const positionOk = parentModel === 'flow' || (parentModel === 'phrasing' && chain);
      if (!positionOk) return null;
      const parsed = CrowiLinkCardSidecarSchema.safeParse(payload);
      if (!parsed.success) return null;
      const cleaned = validateCardFields(parsed.data);
      if (!cleaned) return { node: validationFailedPlaceholder() };
      return { node: { type: 'crowiLinkCard', ...cleaned, ...(carried !== undefined ? { data: carried } : {}) } };
    }
    case 'crowiPlaceholder': {
      const parsed = CrowiPlaceholderSidecarSchema.safeParse(payload);
      if (!parsed.success) return null;
      return { node: { type: 'crowiPlaceholder', ...parsed.data, ...(carried !== undefined ? { data: carried } : {}) } };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// URL allow-list (§8).
// ---------------------------------------------------------------------------

/** General rule: http(s) / mailto / relative / fragment-only. */
function isAllowedGeneralUrl(url: string): boolean {
  if (url === '' || url.startsWith('#')) return true;
  if (url.startsWith('//')) return false; // protocol-relative
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!match) return true; // relative
  const scheme = match[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

/** Card override (§8): http(s) absolute URLs only — mirrors the HTML side's `safeHref` / `isHttpUrl` gate. */
function isHttpOnlyUrl(url: string): boolean {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  return scheme === 'http' || scheme === 'https';
}

interface CardFieldsLike {
  url?: unknown;
  image?: unknown;
  [key: string]: unknown;
}

/** Returns the cleaned card fields, or null when the card URL itself is not http(s) (→ visible placeholder). */
function validateCardFields(fields: CardFieldsLike): Record<string, unknown> | null {
  if (typeof fields.url !== 'string' || !isHttpOnlyUrl(fields.url)) return null;
  const out: Record<string, unknown> = { ...fields };
  const image = fields.image;
  if (isRecord(image)) {
    if (typeof image.url !== 'string' || !isHttpOnlyUrl(image.url)) {
      // Invalid card image → drop the field, render an image-less card
      // (same degrade as the HTML side's `safeImageSrc`).
      delete out.image;
    }
  } else if (image !== undefined) {
    delete out.image;
  }
  return out;
}

// ---------------------------------------------------------------------------
// §10 per-type image payload validation (v1 trust boundary).
// ---------------------------------------------------------------------------

/** Canonical base64: allowed alphabet, length % 4 === 0, padding only at the end. */
const CANONICAL_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Deep-validate a diagram image payload: strict base64 decode + decoded
 * size cap, second `allowSafeHref: false` SVG sanitisation (re-encoding
 * when the sanitiser changed the content), PNG signature check.
 * Returns the (possibly re-encoded) payload, or null on failure.
 */
function validateImagePayload(image: CrowiImagePayload): CrowiImagePayload | null {
  const { base64 } = image;
  if (!CANONICAL_BASE64_RE.test(base64)) return null;
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.byteLength > SINGLE_ENTRY_REJECT_BYTES) return null;

  if (image.mediaType === 'image/svg+xml') {
    const svgText = decoded.toString('utf8');
    // Independent second sanitisation pass — producer-side sanitisation
    // only covers well-behaved producers; this boundary also covers
    // sidecars written directly by plugin AST mutation.
    const sanitized = sanitizeSvg(svgText, { allowSafeHref: false });
    if (!sanitized.ok) return null;
    if (sanitized.svg !== svgText) {
      const reEncoded = Buffer.from(sanitized.svg, 'utf8').toString('base64');
      if (reEncoded.length > AST_MAX_IMAGE_BASE64_CHARS) return null;
      return { ...image, base64: reEncoded };
    }
    return image;
  }

  // image/png — declared mediaType must match the actual payload.
  if (decoded.byteLength < PNG_SIGNATURE.byteLength || !decoded.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    return null;
  }
  return image;
}

// ---------------------------------------------------------------------------
// §6 crowiLinkCard hoist.
// ---------------------------------------------------------------------------

const SPLITTABLE_ANCESTORS = new Set(['paragraph', 'emphasis', 'strong', 'delete', 'link']);

function subtreeHasCard(node: OutNode): boolean {
  const stack: OutNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.type === 'crowiLinkCard') return true;
    const children = current.children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push(child as OutNode);
    }
  }
  return false;
}

/**
 * Split `parent` (paragraph or a phrasing ancestor) around every
 * `crowiLinkCard` descendant: phrasing runs on either side re-wrap in a
 * same-typed copy of the ancestor chain; empty copies (card at the
 * start / end) are never emitted. Multiple cards apply the same rule
 * left-to-right.
 */
function splitParent(parent: OutNode): OutNode[] {
  const out: OutNode[] = [];
  let acc: OutNode[] = [];
  const flush = (): void => {
    if (acc.length > 0) {
      out.push({ ...parent, children: acc });
      acc = [];
    }
  };
  const children = Array.isArray(parent.children) ? (parent.children as OutNode[]) : [];
  for (const child of children) {
    if (child.type === 'crowiLinkCard') {
      flush();
      out.push(child);
      continue;
    }
    if (SPLITTABLE_ANCESTORS.has(child.type) && subtreeHasCard(child)) {
      for (const part of splitParent(child)) {
        if (part.type === 'crowiLinkCard') {
          flush();
          out.push(part);
        } else {
          acc.push(part);
        }
      }
      continue;
    }
    acc.push(child);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// §7 output budget (post-projection; measured on what the declared
// client actually receives). Never fails the whole envelope: the
// largest contributors degrade one by one until the budget holds.
// ---------------------------------------------------------------------------

function envelopeBytes(root: OutNode): number {
  return Buffer.byteLength(JSON.stringify({ astVersion: CURRENT_AST_VERSION, root }), 'utf8');
}

function enforceOutputBudget(root: OutNode, warn?: (message: string) => void): void {
  let bytes = envelopeBytes(root);
  if (bytes > AST_OUTPUT_WARN_BYTES && warn) {
    warn(`[sanitize-ast] v1 envelope exceeds warn budget: ${bytes} bytes (warn=${AST_OUTPUT_WARN_BYTES}, budget=${AST_OUTPUT_BUDGET_BYTES})`);
  }
  let guard = 0;
  while (bytes > AST_OUTPUT_BUDGET_BYTES && guard < 10_000) {
    guard += 1;
    const target = findLargestReplaceable(root);
    if (!target) break;
    target.parentChildren[target.index] = {
      type: 'crowiPlaceholder',
      kind: 'validation-failed',
      label: VALIDATION_FAILED_LABEL,
      reservation: { ...DEFAULT_RESERVATION },
    };
    bytes = envelopeBytes(root);
  }
}

interface ReplaceTarget {
  parentChildren: OutNode[];
  index: number;
  bytes: number;
}

/**
 * Largest replaceable contributor. Leaf nodes are preferred (their
 * stringify size IS their own contribution — a parent's size always
 * includes its children's, so ranking parents would always pick a
 * top-level section instead of the one oversized diagram inside it);
 * when no leaf remains, the largest non-placeholder child of any parent
 * is taken so the loop still terminates.
 */
function findLargestReplaceable(root: OutNode): ReplaceTarget | null {
  let bestLeaf: ReplaceTarget | null = null;
  let bestAny: ReplaceTarget | null = null;
  const stack: OutNode[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop();
    if (!parent) break;
    const children = parent.children;
    if (!Array.isArray(children)) continue;
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as OutNode;
      if (child.type === 'crowiPlaceholder') continue;
      const size = Buffer.byteLength(JSON.stringify(child), 'utf8');
      const isLeaf = !Array.isArray(child.children);
      const target: ReplaceTarget = { parentChildren: children as OutNode[], index: i, bytes: size };
      if (isLeaf) {
        if (!bestLeaf || size > bestLeaf.bytes) bestLeaf = target;
      } else {
        stack.push(child);
        if (!bestAny || size > bestAny.bytes) bestAny = target;
      }
    }
  }
  return bestLeaf ?? bestAny;
}
