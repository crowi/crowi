/**
 * Phase 2 stub for the 20-user editor cap (Resolved-decision 12 in
 * RFC-0003). The Phase 6 implementation will INCR a Redis counter
 * scoped to `crowi:collab:editors:<pageId>` and return `readonly: true`
 * when the limit is exceeded; until then every caller is treated as a
 * full editor.
 *
 * The async signature is locked in now so Phase 6's Redis call slots
 * in without touching the wsToken handler. Lives in its own module so
 * the Phase 6 Redis dependency never reaches `util/ws-token.ts` —
 * token sign / verify and the cap counter share a handler but not a
 * test surface.
 */
export const checkEditorCap = async (_pageId: string): Promise<{ readonly: boolean }> => {
  return { readonly: false };
};
