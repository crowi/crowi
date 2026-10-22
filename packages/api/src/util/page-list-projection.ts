/**
 * Revision projection for page-list rows. List rows never render the body,
 * the transformed AST, or the derived meta, so they are excluded at the
 * database read instead of being dropped after loading.
 */
export const PAGE_LIST_REVISION_SELECT = '-body -renderedAst -meta';

/**
 * Page projection for page-list rows. `yjsState` is the persisted collab
 * snapshot and can approach the 16MB document limit on its own; no list row
 * reads it. Finders shared with the subtree rename take this only when the
 * caller passes it, so the rename keeps loading the full document.
 */
export const PAGE_LIST_PAGE_SELECT = '-yjsState';
