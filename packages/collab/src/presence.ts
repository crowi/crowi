import { resolveApiDistFile } from './api-dist';

/**
 * Thin wrapper around `@crowi/api`'s `service/presence` module. Same
 * dist-resolve pattern as `ws-token.ts` / `collab-cap.ts` so the
 * implementation source-of-truth lives entirely on the api side
 * (`packages/api/src/service/presence.ts`) and a future RFC-0005 swap
 * lands in one file.
 *
 * Phase 5 ships a no-op stub; the import surface here exists so the
 * collab hooks (`onAuthenticate` returning + the eventual save flow)
 * can call `markEditing(pageId, userId)` without changing once
 * RFC-0005 lands the real implementation.
 */

type MarkEditing = (pageId: string, userId: string) => Promise<void>;

interface ApiPresenceModule {
  markEditing: MarkEditing;
}

let cached: MarkEditing | null = null;

export const markEditing: MarkEditing = async (pageId, userId) => {
  if (!cached) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(resolveApiDistFile('service/presence.js')) as ApiPresenceModule;
    cached = mod.markEditing;
  }
  return cached(pageId, userId);
};
