/**
 * Crowi Page grant levels, mirrored from core (`models/page.ts`).
 *
 * Plugins read core models loosely through `ctx.model('Page')` and must
 * NOT import from `@crowi/server`, so the one grant value the unfurl
 * builder cares about (`GRANT_PUBLIC`) is duplicated here as a small,
 * stable constant. Only `GRANT_PUBLIC` pages get a rich unfurl; everything
 * else is treated as non-public regardless of its exact level.
 */
export const GRANT_PUBLIC = 1;
