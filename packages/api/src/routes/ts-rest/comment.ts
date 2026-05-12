import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type PageUser } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { Types } from 'mongoose';
import { UserDocument } from 'src/models/user';
import { PageDocument } from 'src/models/page';
import { CommentDocument } from 'src/models/comment';
import { isValidObjectId, toISOStringOrNull, toPageUser } from 'src/util/ts-rest-helpers';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:comment');

const COMMENT_POSITION_DEFAULT = -1;

/**
 * Convert CommentDocument (with optionally populated creator) to API response shape.
 * - creator is serialized to PageUserSchema-compatible object when populated
 * - revision is returned as a string id (UI does not need full revision object)
 */
const commentToResponse = (comment: CommentDocument) => {
  const obj = comment.toObject() as any; // eslint-disable-line @typescript-eslint/no-explicit-any

  let creator: string | PageUser | null = null;
  if (obj.creator && typeof obj.creator === 'object' && '_id' in obj.creator && 'username' in obj.creator) {
    creator = toPageUser(obj.creator);
  } else if (obj.creator) {
    creator = obj.creator.toString();
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

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Comment = crowi.model('Comment');
  const Page = crowi.model('Page');

  const commentRouter = s.router(apiContract.comment, {
    /**
     * GET /api/v2/comments
     * List comments by page_id or revision_id (one is required).
     * - Authentication enforced by jwtAuth at router level.
     */
    listComments: async ({ query, req }) => {
      const user = req.user as UserDocument;
      const { page_id, revision_id } = query;

      debug('listComments called with:', { page_id, revision_id, userId: user._id });

      if (!page_id && !revision_id) {
        return {
          status: 400 as const,
          body: {
            error: {
              code: 'INVALID_REQUEST' as const,
              message: 'page_id or revision_id is required',
            },
          },
        };
      }

      try {
        let comments: CommentDocument[];
        if (revision_id) {
          if (!isValidObjectId(revision_id)) {
            return {
              status: 400 as const,
              body: { error: { code: 'INVALID_REQUEST' as const, message: 'Invalid revision_id' } },
            };
          }
          comments = await Comment.getCommentsByRevisionId(new Types.ObjectId(revision_id));
        } else {
          if (!isValidObjectId(page_id)) {
            return {
              status: 400 as const,
              body: { error: { code: 'INVALID_REQUEST' as const, message: 'Invalid page_id' } },
            };
          }
          comments = await Comment.getCommentsByPageId(new Types.ObjectId(page_id));
        }

        return {
          status: 200 as const,
          body: { comments: comments.map(commentToResponse) },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error listing comments:', error.message);
        return {
          status: 400 as const,
          body: { error: { code: 'INVALID_REQUEST' as const, message: error.message || 'Failed to list comments' } },
        };
      }
    },

    /**
     * POST /api/v2/comments
     * Add a comment to a page revision.
     * - Validates page existence and grant before creating (stricter than the legacy
     *   /_api/comments.add which trusted the caller-provided page_id).
     * - Comment.create triggers post-save hooks that update Page.commentCount and
     *   Activity entries; we intentionally do not duplicate that work here.
     */
    addComment: async ({ body, req }) => {
      const user = req.user as UserDocument;
      const { page_id, revision_id, comment, comment_position } = body;

      debug('addComment called with:', { page_id, revision_id, userId: user._id });

      if (!isValidObjectId(page_id) || !isValidObjectId(revision_id)) {
        return {
          status: 400 as const,
          body: { error: { code: 'INVALID_REQUEST' as const, message: 'Invalid page_id or revision_id' } },
        };
      }

      try {
        const page = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
        if (!page) {
          return {
            status: 404 as const,
            body: { error: { code: 'PAGE_NOT_FOUND' as const, message: 'Page not found' as const } },
          };
        }

        const created = await Comment.create({
          page: new Types.ObjectId(page_id),
          creator: user._id,
          revision: new Types.ObjectId(revision_id),
          comment,
          commentPosition: comment_position ?? COMMENT_POSITION_DEFAULT,
        });
        const populated = (await created.populate('creator')) as CommentDocument;

        return {
          status: 200 as const,
          body: { comment: commentToResponse(populated) },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error adding comment:', error.message);

        if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
          // findPageByIdAndGrantedUser hides the distinction; map both to 404.
          return {
            status: 404 as const,
            body: { error: { code: 'PAGE_NOT_FOUND' as const, message: 'Page not found' as const } },
          };
        }

        return {
          status: 400 as const,
          body: { error: { code: 'INVALID_REQUEST' as const, message: error.message || 'Failed to add comment' } },
        };
      }
    },

    /**
     * DELETE /api/v2/comments
     * Delete a comment by id. The legacy controller required the caller to also
     * supply the page_id and verified page-grant via `pageData.isGrantedFor(user)`;
     * we preserve that behavior so nothing is lost.
     */
    deleteComment: async ({ body, req }) => {
      const user = req.user as UserDocument;
      const { comment_id, page_id } = body;

      debug('deleteComment called with:', { comment_id, page_id, userId: user._id });

      if (!isValidObjectId(comment_id) || !isValidObjectId(page_id)) {
        return {
          status: 400 as const,
          body: { error: { code: 'INVALID_REQUEST' as const, message: 'Invalid comment_id or page_id' } },
        };
      }

      try {
        const pageData = (await Page.findPageById(page_id)) as PageDocument | null;
        if (!pageData) {
          return {
            status: 404 as const,
            body: { error: { code: 'COMMENT_NOT_FOUND' as const, message: 'Comment not found' as const } },
          };
        }
        if (!pageData.isGrantedFor(user)) {
          return {
            status: 403 as const,
            body: {
              error: { code: 'PAGE_NOT_GRANTED' as const, message: 'Page is not granted for the user' as const },
            },
          };
        }

        const existing = await Comment.findOne({ _id: new Types.ObjectId(comment_id) }).exec();
        if (!existing) {
          return {
            status: 404 as const,
            body: { error: { code: 'COMMENT_NOT_FOUND' as const, message: 'Comment not found' as const } },
          };
        }

        await Comment.removeCommentById(new Types.ObjectId(comment_id));

        return {
          status: 200 as const,
          body: { ok: true as const },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error deleting comment:', error.message);

        if (error.message === 'Page not found') {
          return {
            status: 404 as const,
            body: { error: { code: 'COMMENT_NOT_FOUND' as const, message: 'Comment not found' as const } },
          };
        }

        return {
          status: 400 as const,
          body: { error: { code: 'INVALID_REQUEST' as const, message: error.message || 'Failed to delete comment' } },
        };
      }
    },
  });

  createExpressEndpoints(apiContract.comment, commentRouter, router);

  return router;
};
