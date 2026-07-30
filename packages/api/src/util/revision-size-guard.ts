import { AST_INPUT_LIMIT_BYTES, SIDECAR_KEYS } from '@crowi/api-contract';

/**
 * RFC-0023 §10 — the save-time revision size guard.
 *
 * Sidecars ride alongside the html they describe, so a stored AST can
 * grow to roughly 2x for diagram-heavy pages. MongoDB's 16MB BSON cap
 * applies to the WHOLE `Revision` document (body + meta + yjsUpdate +
 * AST + framing), so the guard measures the whole document, not the
 * AST alone — an AST-only threshold would let a page sitting just
 * under 16MB today become unsavable the moment sidecars land
 * (user-visible data loss). Invariant: stripping every sidecar returns
 * the document to byte-identical-to-today, so **no page that saves
 * today becomes unsavable**; pages that exceed the budget even with
 * zero sidecars fail exactly the way they already do (this guard's
 * only job is not to regress).
 *
 * Shared by the two write paths: `Revision.prepareRevision` (the single
 * chokepoint of every revision-creation flow) and the `rebuild
 * rendered-ast` backfill (`util/rebuild-rendered-ast.ts`) — a backfill
 * that wrote larger ASTs than the save path accepts would leave those
 * pages unsavable-on-next-edit.
 */

/** Whole-document budget against MongoDB's 16MB BSON cap. */
export const REVISION_BSON_BUDGET_BYTES = 15 * 1024 * 1024;
/** Fixed allowance for BSON framing, key names, remaining scalar fields and UTF-8/BSON encoding drift. */
export const REVISION_FIXED_HEADROOM_BYTES = 1 * 1024 * 1024;

export interface RevisionAstBudgetInput {
  /** The freshly rendered AST (serializeMdast output). May be mutated in place by stripping sidecars. */
  renderedAst: unknown;
  body: string;
  meta?: unknown;
  /** `yjsUpdate` byte length when present (incremental collab revisions). */
  yjsUpdateBytes?: number;
}

export interface RevisionAstBudgetOutcome {
  /** The (possibly sidecar-stripped) AST to persist. Same reference as the input. */
  renderedAst: unknown;
  strippedCount: number;
  estimatedBytesBefore: number;
  estimatedBytesAfter: number;
}

interface SidecarCarrier {
  /** The node whose `data` carries the sidecar — kept so an emptied `data` can be dropped without re-walking the tree. */
  node: Record<string, unknown>;
  data: Record<string, unknown>;
  key: string;
  bytes: number;
}

/**
 * Apply the RFC-0023 §10 budget: while the whole-document estimate
 * exceeds `REVISION_BSON_BUDGET_BYTES` **or** the AST alone exceeds
 * `AST_INPUT_LIMIT_BYTES` (so a stored AST can never trip the read-side
 * v1 input gate), strip sidecars largest-first. Stripped nodes become
 * byte-identical to their pre-RFC-0023 plain `html` form.
 *
 * Exception safety: a `JSON.stringify` failure (pathological plugin
 * data) strips ALL sidecars — fail-safe to today's shape.
 */
export function applyRevisionAstBudget(input: RevisionAstBudgetInput, warn: (message: string) => void): RevisionAstBudgetOutcome {
  const { renderedAst, body, meta, yjsUpdateBytes } = input;

  const fixedBytes = Buffer.byteLength(body, 'utf8') + safeJsonBytes(meta ?? {}, 0) + (yjsUpdateBytes ?? 0) + REVISION_FIXED_HEADROOM_BYTES;

  let astBytes = safeJsonBytes(renderedAst, Number.NaN);
  if (Number.isNaN(astBytes)) {
    // Fail-safe: strip everything, then re-measure best-effort.
    const stripped = stripAllSidecars(renderedAst);
    const after = safeJsonBytes(renderedAst, Number.NaN);
    warn(`[revision-size-guard] renderedAst not serialisable; stripped all ${stripped} sidecar(s) as a fail-safe`);
    return {
      renderedAst,
      strippedCount: stripped,
      estimatedBytesBefore: Number.NaN,
      estimatedBytesAfter: Number.isNaN(after) ? Number.NaN : fixedBytes + after,
    };
  }

  const estimateBefore = fixedBytes + astBytes;
  const overBudget = (): boolean => fixedBytes + astBytes > REVISION_BSON_BUDGET_BYTES || astBytes > AST_INPUT_LIMIT_BYTES;
  if (!overBudget()) {
    return { renderedAst, strippedCount: 0, estimatedBytesBefore: estimateBefore, estimatedBytesAfter: estimateBefore };
  }

  // Collect every sidecar-bearing node, largest sidecar first.
  const carriers = collectSidecarCarriers(renderedAst).sort((a, b) => b.bytes - a.bytes);
  let strippedCount = 0;
  for (const carrier of carriers) {
    if (!overBudget()) break;
    delete carrier.data[carrier.key];
    if (Object.keys(carrier.data).length === 0) {
      // A plain dispatch html node has no `data` at all — restore that
      // exact shape so the stripped node is byte-identical to today.
      delete carrier.node.data;
    }
    strippedCount += 1;
    astBytes = safeJsonBytes(renderedAst, astBytes);
  }

  const estimateAfter = fixedBytes + astBytes;
  if (strippedCount > 0) {
    warn(
      `[revision-size-guard] revision over budget; stripped ${strippedCount} sidecar(s). estimatedBytes ${estimateBefore} -> ${estimateAfter} (budget=${REVISION_BSON_BUDGET_BYTES}, astLimit=${AST_INPUT_LIMIT_BYTES})`,
    );
  }
  return { renderedAst, strippedCount, estimatedBytesBefore: estimateBefore, estimatedBytesAfter: estimateAfter };
}

function safeJsonBytes(value: unknown, fallback: number): number {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return fallback;
    return Buffer.byteLength(json, 'utf8');
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectSidecarCarriers(root: unknown): SidecarCarrier[] {
  const out: SidecarCarrier[] = [];
  // WeakSet guard: these walkers must terminate even on a cyclic
  // "tree" (the very case that makes JSON.stringify throw).
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isRecord(node)) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const data = node.data;
    if (isRecord(data)) {
      for (const key of SIDECAR_KEYS) {
        if (data[key] !== undefined) {
          out.push({ node, data, key, bytes: safeJsonBytes(data[key], 0) });
        }
      }
    }
    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push(child);
    }
  }
  return out;
}

/** Fail-safe path: strip every sidecar key everywhere (and drop emptied `data` objects). */
function stripAllSidecars(root: unknown): number {
  let stripped = 0;
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isRecord(node)) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const data = node.data;
    if (isRecord(data)) {
      for (const key of SIDECAR_KEYS) {
        if (data[key] !== undefined) {
          delete data[key];
          stripped += 1;
        }
      }
      if (Object.keys(data).length === 0) delete node.data;
    }
    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push(child);
    }
  }
  return stripped;
}
