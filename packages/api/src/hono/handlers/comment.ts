/**
 * RFC-0006 Phase 4 Batch 3 — `comment` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/comment.ts`. Three endpoints,
 * all behind `createJwtAuth(crowi)` applied broadly to `/comments/*`:
 *
 *   GET    /comments — list comments by page_id or revision_id
 *   POST   /comments — add a comment to a page revision
 *   DELETE /comments — delete a comment by id
 *
 * Wire-format parity with the ts-rest era is preserved. Notable points:
 *
 *  - `addComment` reuses `findPageByIdAndGrantedUser` so the legacy
 *    grant-failure -> 404 (existence-leak guard) behaviour stays.
 *  - `deleteComment` separates grant (403 PAGE_NOT_GRANTED) from
 *    missing comment (404 COMMENT_NOT_FOUND) — the ts-rest tests
 *    asserted both branches explicitly.
 *  - The Comment post-save hook (commentCount / Activity emission)
 *    runs independently of this handler; we do not duplicate that
 *    work.
 */
import { addCommentRoute, deleteCommentRoute, listCommentsRoute, type PageUser } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { CommentDocument } from 'src/models/comment';
import type { PageDocument } from 'src/models/page';
import { autoWatchPage } from 'src/util/auto-watch';
import { isDraftHiddenFrom, isPopulatedUser, isValidObjectId, resolveGrantedRevisionOwner, toISOStringOrNull, toPageUser } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';
import { applyScope } from '../middleware/require-scope';

import { invalidRequestBody, PAGE_NOT_FOUND_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:comment');

const COMMENT_POSITION_DEFAULT = -1;

const PAGE_NOT_GRANTED_BODY = {
  error: { code: 'PAGE_NOT_GRANTED' as const, message: 'Page is not granted for the user' as const },
};

const COMMENT_NOT_FOUND_BODY = {
  error: { code: 'COMMENT_NOT_FOUND' as const, message: 'Comment not found' as const },
};

/**
 * Convert a Comment document (with optionally populated creator) into
 * the API response shape. Mirrors the ts-rest helper so the response
 * payload is byte-identical.
 */
const commentToResponse = (comment: CommentDocument) => {
  // The toObject result mixes Mongoose dynamic shapes; we narrow only the
  // fields used below and treat creator as a populated user / objectId /
  // null union without re-typing the whole document.
  const obj = comment.toObject() as { creator?: unknown };

  let creator: string | PageUser | null = null;
  if (isPopulatedUser(obj.creator)) {
    creator = toPageUser(obj.creator);
  } else if (obj.creator) {
    creator = String(obj.creator);
  }

  return {
    _id: comment._id.toString(),
    page: comment.page.toString(),
    creator,
    revision: comment.revision.toString(),
    comment: comment.comment,
    commentPosition: typeof comment.commentPosition === 'number' ? comment.commentPosition : COMMENT_POSITION_DEFAULT,
    createdAt: toISOStringOrNull(comment.createdAt) ?? new Date(0).toISOString(),
  };
};

export const registerCommentRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Comment = crowi.model('Comment');
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const Watcher = crowi.model('Watcher');

  app.use('/comments/*', createJwtAuth(crowi));
  app.use('/comments', createJwtAuth(crowi));

  // RFC-0010 — comment scopes.
  applyScope(app, listCommentsRoute, 'comments:read');
  applyScope(app, addCommentRoute, 'comments:write');
  applyScope(app, deleteCommentRoute, 'comments:write');

  return app
    .openapi(listCommentsRoute, async (c) => {
      const user = c.get('user');
      const { page_id, revision_id } = c.req.valid('query');

      debug('listComments called with:', { page_id, revision_id, userId: user._id });

      if (!page_id && !revision_id) {
        return c.json(invalidRequestBody('page_id or revision_id is required'), 400);
      }

      try {
        let comments: CommentDocument[];
        if (revision_id) {
          if (!isValidObjectId(revision_id)) {
            return c.json(invalidRequestBody('Invalid revision_id'), 400);
          }
          // Grant boundary (crowi-review CLS-003): comment bodies must not
          // be readable by callers who cannot read the owning page. Resolved
          // via the revision's immutable `page` id (DC-5 — see
          // `RevisionDocument.page` for why a `path` reverse-lookup would
          // leak through a reused path); the fail-closed semantics live once
          // in `resolveGrantedRevisionOwner` (`ts-rest-helpers.ts`). 404
          // hides page existence, matching GET /pages/revisions/:id.
          const revision = (await Revision.findById(new Types.ObjectId(revision_id)).select('page').exec()) as { page?: Types.ObjectId | null } | null;
          const page = await resolveGrantedRevisionOwner(Page, revision?.page, user);
          if (!page) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          comments = await Comment.getCommentsByRevisionId(new Types.ObjectId(revision_id));
        } else {
          if (!isValidObjectId(page_id!)) {
            return c.json(invalidRequestBody('Invalid page_id'), 400);
          }
          // Same boundary keyed on page_id: grant, plus the draft rule the
          // grant cannot express (a draft is GRANT_PUBLIC — see
          // `isDraftHiddenFrom`). Both collapse to 404 so a draft's existence
          // is not leaked.
          const page = (await Page.findPageById(page_id!)) as PageDocument | null;
          if (!page || !page.isGrantedFor(user) || isDraftHiddenFrom(page, user)) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          comments = await Comment.getCommentsByPageId(new Types.ObjectId(page_id!));
        }

        return c.json({ comments: comments.map(commentToResponse) }, 200);
      } catch (err) {
        const error = err as Error;
        debug('Error listing comments:', error.message);
        return c.json(invalidRequestBody(error.message || 'Failed to list comments'), 400);
      }
    })
    .openapi(addCommentRoute, async (c) => {
      const user = c.get('user');
      const { page_id, revision_id, comment, comment_position } = c.req.valid('json');

      debug('addComment called with:', { page_id, revision_id, userId: user._id });

      if (!isValidObjectId(page_id) || !isValidObjectId(revision_id)) {
        return c.json(invalidRequestBody('Invalid page_id or revision_id'), 400);
      }

      try {
        const page = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
        if (!page) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        // RFC-0021 §7.1 (feature-page-history-phase1-model, Phase 1) —
        // authorization and insert are two separate operations; stash what
        // was just authorized ({status, path}) on `$locals.authSnapshot`
        // BEFORE the insert so `comment.ts`'s post-insert re-validation
        // hook can compensate if the Page was trashed/renamed in between.
        // `new Comment(...).save()` instead of `Comment.create(...)` (which
        // is exactly `new Model(doc).save()` internally) so there is a
        // document to set `$locals` on before the save fires the hook.
        const draft = new Comment({
          page: new Types.ObjectId(page_id),
          creator: user._id,
          revision: new Types.ObjectId(revision_id),
          comment,
          commentPosition: comment_position ?? COMMENT_POSITION_DEFAULT,
        });
        draft.$locals.authSnapshot = { status: page.status, path: page.path };
        const created = await draft.save();
        const populated = (await created.populate('creator')) as CommentDocument;

        // feature-watch-autosubscribe — commenting auto-watches the page.
        // Done synchronously here (not in the Comment post-save Activity
        // hook, which fires asynchronously) so `newlyWatching` is accurate
        // in this response. An existing IGNORE row is respected; an
        // existing WATCH yields newlyWatching=false. Best-effort: a
        // watcher failure must not fail the comment write.
        let newlyWatching = false;
        try {
          const result = await autoWatchPage(Watcher, user._id, new Types.ObjectId(page_id));
          newlyWatching = result.newlyWatching;
        } catch (watchErr) {
          debug('Error auto-watching page on comment:', (watchErr as Error).message);
        }

        return c.json({ comment: commentToResponse(populated), newlyWatching }, 200);
      } catch (err) {
        const error = err as Error;
        debug('Error adding comment:', error.message);

        // findPageByIdAndGrantedUser throws on not-found / not-granted; collapse
        // both to 404 to match the existence-leak guard from the ts-rest era.
        if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        return c.json(invalidRequestBody(error.message || 'Failed to add comment'), 400);
      }
    })
    .openapi(deleteCommentRoute, async (c) => {
      const user = c.get('user');
      const { comment_id, page_id } = c.req.valid('json');

      debug('deleteComment called with:', { comment_id, page_id, userId: user._id });

      if (!isValidObjectId(comment_id) || !isValidObjectId(page_id)) {
        return c.json(invalidRequestBody('Invalid comment_id or page_id'), 400);
      }

      try {
        const pageData = (await Page.findPageById(page_id)) as PageDocument | null;
        if (!pageData) {
          return c.json(COMMENT_NOT_FOUND_BODY, 404);
        }
        // A draft answers 404, not 403: to a non-author the page does not
        // exist, and a "not granted" reply would confirm that it does.
        if (isDraftHiddenFrom(pageData, user)) {
          return c.json(COMMENT_NOT_FOUND_BODY, 404);
        }
        if (!pageData.isGrantedFor(user)) {
          return c.json(PAGE_NOT_GRANTED_BODY, 403);
        }

        // Scope the lookup to the authorized page (crowi-review CLS-002):
        // grant is checked against the caller-supplied page_id, so the
        // comment must actually belong to that page — otherwise a caller
        // granted on ANY page could delete a comment on a private page by id.
        const existing = await Comment.findOne({ _id: new Types.ObjectId(comment_id), page: new Types.ObjectId(page_id) }).exec();
        if (!existing) {
          return c.json(COMMENT_NOT_FOUND_BODY, 404);
        }

        await Comment.removeCommentById(new Types.ObjectId(comment_id));

        return c.json({ ok: true as const }, 200);
      } catch (err) {
        const error = err as Error;
        debug('Error deleting comment:', error.message);

        if (error.message === 'Page not found') {
          return c.json(COMMENT_NOT_FOUND_BODY, 404);
        }

        return c.json(invalidRequestBody(error.message || 'Failed to delete comment'), 400);
      }
    });
};
