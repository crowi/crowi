/**
 * `Page` grant constants, split out of `models/page.ts` into their own leaf
 * module (feature-page-history-phase1-model, RFC-0021 Phase 1).
 *
 * `page-history-event.ts` needs `GRANTS` for its payload schema's `enum`
 * validator, and `page.ts` needs types from `page-history-event.ts` for its
 * `pendingHistoryEntry` outbox mirror — importing directly from `page.ts`
 * would make that a circular module dependency. Under ts-jest (tsc's CJS
 * output) the cycle merely resolved the value as `undefined` at
 * module-evaluation time (silently disabling the `enum` check); under `tsx`
 * (esbuild's CJS output, which uses TDZ-checked getters for `const`
 * bindings) the same cycle throws `ReferenceError: Cannot access 'GRANTS'
 * before initialization` at import time — reproduced via
 * `rebuild-attachment-display-derivatives-sigint-harness.ts`, the only
 * `tsx`-run entry point that transitively imports `models/page.ts`. This
 * leaf module has no dependencies of its own, so both `page.ts` and
 * `page-history-event.ts` can import it without forming a cycle.
 *
 * `page.ts` re-exports every symbol here unchanged, so no other import site
 * (`from 'src/models/page'`) needs to change.
 */
export const GRANT_PUBLIC = 1;
export const GRANT_RESTRICTED = 2;
export const GRANT_SPECIFIED = 3;
export const GRANT_OWNER = 4;
export const GRANTS = [GRANT_PUBLIC, GRANT_RESTRICTED, GRANT_SPECIFIED, GRANT_OWNER] as const;
export const PAGE_GRANT_ERROR = 1;
