/**
 * RFC-0004 `Page.status` string values the collab library reasons about.
 *
 * The collab library deliberately does **not** import from `@crowi/api`
 * (`models/page.ts`), so the status strings are duplicated here. They
 * must stay byte-identical to `STATUS_DRAFT` / `STATUS_PUBLISHED` in
 * `@crowi/api`'s `models/page.ts`.
 *
 * - `DRAFT_STATUS` — a not-yet-published page, author-only. Used by the
 *   `onAuthenticate` draft-author gate.
 * - `PUBLISHED_STATUS` — the terminal status a draft transitions to on
 *   its first successful collab save (RFC-0005 publish-on-save).
 */
export const DRAFT_STATUS = 'draft';
export const PUBLISHED_STATUS = 'published';
