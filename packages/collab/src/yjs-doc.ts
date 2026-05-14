/**
 * Single source of truth for the Crowi Y.Doc shape. RFC-0003 Resolved
 * decision 1 fixes the Y.Doc structure to `{ content: Y.Text }` — no
 * sub-docs, no map of arbitrary keys. Callers call
 * `doc.getText(CONTENT_FIELD)` rather than going through a one-line
 * helper so the indirection doesn't hide what the underlying yjs API
 * looks like at every callsite.
 *
 * If we ever bolt on a metadata sub-tree (e.g. cursor metadata for
 * awareness), the new key adds **alongside** this constant — never
 * replaces it.
 */
export const CONTENT_FIELD = 'content' as const;
