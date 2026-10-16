/**
 * Revision projection for page-list rows. List rows never render the body,
 * the transformed AST, or the derived meta, so they are excluded at the
 * database read instead of being dropped after loading.
 */
export const PAGE_LIST_REVISION_SELECT = '-body -renderedAst -meta';
