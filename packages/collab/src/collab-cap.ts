import { resolveApiDistFile } from './api-dist';

/**
 * Re-export of the api package's `checkEditorCap` helper (Phase 2
 * stub → Phase 6 Redis-backed). Lives in collab as an explicit swap
 * point: when Phase 6 swaps the api side to `INCR` a Redis counter,
 * this module picks the new behaviour up automatically (single
 * source-of-truth via api's `dist/util/collab-cap.js`), and the
 * import surface for the Hocuspocus hooks doesn't change.
 *
 * Routed through `api-dist.ts` so the `dist/` assumption lives in
 * exactly one place — see the helper's docstring.
 */
type CheckEditorCap = (pageId: string) => Promise<{ readonly: boolean }>;

interface ApiCollabCapModule {
  checkEditorCap: CheckEditorCap;
}

let cached: CheckEditorCap | null = null;

export const checkEditorCap: CheckEditorCap = async (pageId) => {
  if (!cached) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(resolveApiDistFile('util/collab-cap.js')) as ApiCollabCapModule;
    cached = mod.checkEditorCap;
  }
  return cached(pageId);
};
