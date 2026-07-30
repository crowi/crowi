import { CURRENT_AST_VERSION } from '@crowi/api-contract';
import type { Context } from 'hono';
import { envelopeInvalidEnvelope, sanitizeAst } from 'src/renderer/sanitize-ast';
import { AST_VERSION_HEADER } from 'src/hono/middleware/ast-negotiation';

/**
 * RFC-0023 §9 — the single chokepoint every `renderedAst` emitting
 * handler (getPage / listPages portal / getRevision / preview) routes
 * through. Preview is deliberately NOT special-cased.
 *
 * `root` is always a stored/derived bare mdast `Root` (or `undefined`
 * when the revision has no AST) — an envelope can never arrive here
 * because `Revision.renderedAst` permanently persists bare Roots only.
 *
 *   - no declaration / unsupported version → the bare Root, verbatim:
 *     no validation, no transformation, byte-identical to today. This
 *     branch is what keeps the web (a permanent declaration-less
 *     client) and any third-party AST consumer unbroken.
 *   - `X-Crowi-Ast-Version: 1` → the sanitised `{astVersion, root}`
 *     envelope (`sanitizeAst`). `sanitizeAst` is itself a total
 *     function; the catch here is the last-resort guarantee that a
 *     declared client's read can never 500 out of AST handling.
 */
export function pickRenderedAstShape(requestedVersion: number | undefined, root: unknown): unknown {
  if (root === undefined) return undefined;
  if (requestedVersion !== CURRENT_AST_VERSION) return root;
  try {
    return sanitizeAst(root, { warn: (message) => console.warn(message) });
  } catch {
    return envelopeInvalidEnvelope();
  }
}

/**
 * Stamp `Vary: X-Crowi-Ast-Version` on the outgoing response (§9) —
 * the 4 emitting endpoints serve two shapes for the same URL, and a
 * reverse cache / CDN in front of the api must never cross-serve them.
 * Appends to any existing `Vary` value.
 */
export function varyOnAstVersion(c: Context): void {
  c.header('Vary', AST_VERSION_HEADER, { append: true });
}
