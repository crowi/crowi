import { z } from '@hono/zod-openapi';

/**
 * RFC-0004 Phase 3 — schemas for the drafts endpoints
 * (`POST` / `GET` / `DELETE` under `/api/pages/drafts`).
 *
 * A *draft* is a `Page` with `status === 'draft'`: a brand-new page in
 * progress, visible only to its author until the first save promotes it
 * to `published`. These schemas describe the create / list / cancel
 * wire format and the same-path conflict (409) body.
 */

/**
 * Request body for `POST /api/pages/drafts`.
 * `path` is the canonical wiki path the new page will occupy.
 * `initialBody` seeds the draft's first revision; defaults to empty.
 */
export const CreateDraftRequestSchema = z.object({
  path: z.string().min(1),
  initialBody: z.string().optional(),
});
export type CreateDraftRequest = z.infer<typeof CreateDraftRequestSchema>;

/**
 * Success body for `POST /api/pages/drafts` (201). Only the new
 * `pageId` is returned — the client navigates to `/pages/<id>/edit`
 * and the collab session loads the rest.
 */
export const CreateDraftResponseSchema = z.object({
  pageId: z.string(),
});
export type CreateDraftResponse = z.infer<typeof CreateDraftResponseSchema>;

/**
 * Owner identity surfaced in a same-path conflict. Deliberately minimal
 * (the `Creating pages` conflict UI only renders "being created by
 * <displayName> (@<username>)") so a conflict never leaks more of the
 * other user's profile than necessary.
 */
export const DraftConflictOwnerSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
});
export type DraftConflictOwner = z.infer<typeof DraftConflictOwnerSchema>;

/**
 * 409 body for `POST /api/pages/drafts` when another user already
 * holds a draft at the requested path. `error` is a stable machine
 * code; `owner` lets the UI show the contact-the-owner message;
 * `message` is a human-readable fallback.
 */
export const DraftPathConflictErrorSchema = z.object({
  error: z.literal('path_taken_by_draft'),
  owner: DraftConflictOwnerSchema,
  message: z.string(),
});
export type DraftPathConflictError = z.infer<typeof DraftPathConflictErrorSchema>;

/**
 * Generic 400 for `POST /api/pages/drafts` — an uncreatable path,
 * or a path already occupied by a *published* page (not another
 * user's draft, which is the 409 case above).
 */
export const DraftBadRequestErrorSchema = z.object({
  error: z.enum(['invalid_path', 'path_taken']),
  message: z.string(),
});
export type DraftBadRequestError = z.infer<typeof DraftBadRequestErrorSchema>;

/**
 * 403 / 404 body for `DELETE /api/pages/drafts/:id` — the id is not
 * a draft the caller owns. The same generic shape covers both "no such
 * draft" and "not your draft" so draft existence is never leaked.
 */
export const DraftNotFoundErrorSchema = z.object({
  error: z.literal('draft_not_found'),
  message: z.string(),
});
export type DraftNotFoundError = z.infer<typeof DraftNotFoundErrorSchema>;

/**
 * A single row in `GET /api/pages/drafts` — enough for the
 * `Creating pages` view: identifiers (`pageId`, `path`), and the two
 * timestamps that frame "did I make progress recently or is this stale"
 * (`createdAt`, `updatedAt`).
 *
 * A body preview / character count was intentionally NOT included:
 * draft body lives in the Hocuspocus Y.Doc / `Page.yjsState` and only
 * lands in `Page.revision.body` on explicit save, so any field derived
 * from the revision would lag the live editor enough to mislead users
 * (an actively-edited draft would report "0 chars" until they pressed
 * save). Surfacing a body summary correctly requires Y.Doc
 * reconstruction per draft, which is heavier than the listing should
 * absorb.
 */
export const DraftSummarySchema = z.object({
  pageId: z.string(),
  path: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DraftSummary = z.infer<typeof DraftSummarySchema>;

/**
 * Success body for `GET /api/pages/drafts`. Lists only the calling
 * user's own drafts, newest first.
 */
export const ListDraftsResponseSchema = z.object({
  drafts: z.array(DraftSummarySchema),
});
export type ListDraftsResponse = z.infer<typeof ListDraftsResponseSchema>;
