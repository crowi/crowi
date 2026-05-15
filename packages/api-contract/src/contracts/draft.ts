import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  CreateDraftRequestSchema,
  CreateDraftResponseSchema,
  DraftBadRequestErrorSchema,
  DraftNotFoundErrorSchema,
  DraftPathConflictErrorSchema,
  ListDraftsResponseSchema,
} from '../schemas/draft';
import { AuthenticationRequiredErrorSchema } from '../schemas/common';

const c = initContract();

/**
 * RFC-0004 Phase 3 — drafts contract.
 *
 * Standalone namespace (not folded into `pageContract`) so the
 * draft-page lifecycle is discoverable as one bundle, mirroring how
 * `pageCollabContract` keeps the collab handshake surface separate.
 * All three endpoints live under `/api/v2/pages/drafts` and run inside
 * the authenticated router (`jwtAuth` applied at mount time).
 *
 * A *draft* is a `Page` with `status === 'draft'`: a new page in
 * progress, visible only to its author until the first save promotes
 * it to `published`. See `docs/rfcs/0004-editor-ux-enhancement.md`
 * §"Draft pages".
 */
export const draftContract = c.router({
  /**
   * POST /api/v2/pages/drafts
   *
   * Create a new draft page at `path`. The server verifies the path is
   * free — no published page and no *other* user's draft — then creates
   * a `Page { status: 'draft', creator: <user> }` and returns its id.
   *
   *   - 201 `{ pageId }` on success.
   *   - 400 `{ error: 'invalid_path' | 'path_taken' }` for an
   *     uncreatable path or a path already held by a published page.
   *   - 409 `{ error: 'path_taken_by_draft', owner }` when another user
   *     already holds a draft at `path`.
   */
  createDraft: {
    method: 'POST',
    path: '/pages/drafts',
    body: CreateDraftRequestSchema,
    responses: {
      201: CreateDraftResponseSchema,
      400: DraftBadRequestErrorSchema,
      401: AuthenticationRequiredErrorSchema,
      409: DraftPathConflictErrorSchema,
    },
    summary: 'Create a new draft page at a path',
  },

  /**
   * GET /api/v2/pages/drafts
   *
   * List the calling user's own drafts, newest first. Powers the
   * `Creating pages` management view; never returns another user's
   * drafts.
   */
  listDrafts: {
    method: 'GET',
    path: '/pages/drafts',
    responses: {
      200: ListDraftsResponseSchema,
      401: AuthenticationRequiredErrorSchema,
    },
    summary: "List the current user's draft pages",
  },

  /**
   * DELETE /api/v2/pages/drafts/:id
   *
   * Cancel (delete) a draft. Only the draft's author may cancel it;
   * the path is released for someone else to create.
   *
   *   - 200 `{ pageId }` on success.
   *   - 404 `{ error: 'draft_not_found' }` when `:id` is not a draft
   *     the caller owns. "No such draft" and "not your draft" collapse
   *     to the same 404 so draft existence is not leaked.
   */
  cancelDraft: {
    method: 'DELETE',
    path: '/pages/drafts/:id',
    pathParams: z.object({ id: z.string() }),
    // ts-rest 3 runs body validation even on DELETE; Express's json
    // middleware supplies `{}` for an empty body, so `z.undefined()`
    // would reject every request. Relax to "any optional" — this
    // endpoint never inspects the body. (Mirrors attachment.ts.)
    body: z.unknown().optional(),
    responses: {
      200: CreateDraftResponseSchema,
      401: AuthenticationRequiredErrorSchema,
      404: DraftNotFoundErrorSchema,
    },
    summary: 'Cancel (delete) a draft page',
  },
});
