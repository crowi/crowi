import type { Root } from 'mdast';

/**
 * Normalise a transformed mdast tree into a JSON-serialisable shape
 * suitable for `Revision.renderedAst` persistence.
 *
 * What we strip:
 *   - `position`: every node carries source-location info from the
 *     parser. It's useful at parse-time for error reporting but pure
 *     bloat once the tree is frozen as a render artifact, so we drop
 *     it across the whole tree.
 *
 * What we keep:
 *   - everything else, including `data.hProperties` (heading anchor
 *     ids, wikilink-broken / mention className stamps), `value` on
 *     text / code / html nodes, all child arrays.
 *
 * Implementation note: pure spread + recursive map. We intentionally
 * do NOT mutate the input tree — the same tree is consumed downstream
 * by other places (e.g. `runMetadata`'s caller) so an in-place delete
 * would reach into unrelated state.
 *
 * `unknown` is the right type at the boundary because the persisted
 * blob is genuinely untyped JSON from the contract's point of view
 * (`renderedAst: z.unknown().optional()`); callers cast back to
 * `Root` when they need the typed shape.
 */
export function serializeMdast(tree: Root): unknown {
  return cloneNode(tree as unknown);
}

interface RawNode {
  [key: string]: unknown;
}

function cloneNode(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(cloneNode);

  const node = input as RawNode;
  const out: RawNode = {};
  for (const key of Object.keys(node)) {
    if (key === 'position') continue; // strip parser source-location
    out[key] = cloneNode(node[key]);
  }
  return out;
}
