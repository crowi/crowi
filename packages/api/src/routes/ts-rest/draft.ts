import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { GRANT_OWNER, PageDocument, STATUS_DRAFT } from 'src/models/page';
import { isValidObjectId, toISOStringOrNull } from 'src/util/ts-rest-helpers';
import type { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:draft');

/** MongoDB duplicate-key error code, raised by the unique `Page.path` index. */
const isDuplicateKeyError = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

/**
 * RFC-0004 Phase 3 — drafts endpoints (`/api/v2/pages/drafts`).
 *
 * A *draft* is a `Page` with `status === 'draft'`: a brand-new page in
 * progress, author-only, that transitions to `published` exactly once
 * on first save (the publish transition itself is owned by the future
 * RFC-0003 save flow — out of scope here).
 *
 * Mounted in the authenticated router, so `jwtAuth` is already applied
 * and `req.user` is a `UserDocument`. CSRF is not needed for ts-rest
 * (token-based auth).
 *
 * Same-path conflict (`docs/rfcs/0004-editor-ux-enhancement.md`
 * §"Same-path conflict"): creating a draft at a path already held by
 * another user's draft returns 409 with that user's identity so the
 * `Creating pages` UI can show the contact-the-owner message. A path
 * held by a *published* page returns a plain 400.
 */
export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const User = crowi.model('User');

  const draftRouter = s.router(apiContract.draft, {
    /**
     * POST /api/v2/pages/drafts
     *
     * Create a draft at `path`. The grant is forced to OWNER (`4`) so
     * the draft is author-only at the grant layer too — listing /
     * search already exclude other users' drafts by status, but the
     * grant keeps a draft invisible even to code paths that predate the
     * RFC-0004 status filters.
     */
    createDraft: async ({ body, req }) => {
      const user = req.user as UserDocument;
      // The seed revision's `body` is `required` in the Revision schema
      // and Mongoose rejects an empty string. A brand-new draft is
      // conceptually empty, so seed a single newline — it renders to
      // nothing and gives the collab editor an effectively blank doc.
      const initialBody = body.initialBody && body.initialBody.length > 0 ? body.initialBody : '\n';

      const path = Page.normalizePath(body.path);
      debug('createDraft called', { path, userId: user._id.toString() });

      if (!Page.isCreatableName(path)) {
        return {
          status: 400 as const,
          body: { error: 'invalid_path' as const, message: `Cannot create a page at this path (${path}).` },
        };
      }

      // Resolve a path already occupied by a page into the right
      // response — the caller's own draft → 201 (idempotent, so a
      // double-click resolves to the same draft), another user's draft
      // → 409 with owner info, anything published → 400. `null` means
      // the path is free. The owner is loaded only on the 409 branch.
      const resolveOccupied = async () => {
        const existing = (await Page.findOne({ path })) as PageDocument | null;
        if (!existing) return null;
        if (existing.status !== STATUS_DRAFT) {
          return {
            status: 400 as const,
            body: { error: 'path_taken' as const, message: `A page already exists at ${path}.` },
          };
        }
        if (existing.isCreator(user)) {
          return { status: 201 as const, body: { pageId: existing._id.toString() } };
        }
        const owner = (await User.findById(existing.creator)) as UserDocument | null;
        return {
          status: 409 as const,
          body: {
            error: 'path_taken_by_draft' as const,
            owner: owner
              ? { id: owner._id.toString(), username: owner.username, displayName: owner.name }
              : { id: '', username: 'unknown', displayName: 'unknown' },
            message: owner ? `This page is being created by @${owner.username}.` : 'This page is being created by another user.',
          },
        };
      };

      const occupied = await resolveOccupied();
      if (occupied) return occupied;

      try {
        const newPage = await Page.create({
          path,
          creator: user,
          lastUpdateUser: user,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          redirectTo: null,
          grant: GRANT_OWNER,
          status: STATUS_DRAFT,
          grantedUsers: [user],
        });

        // Seed the first revision so the page is loadable / editable
        // immediately. `pushRevision` wires `revision` + bumps the
        // `Page.create` event so backlinks / search run — both already
        // exclude other users' drafts (Phase 2).
        const newRevision = await Revision.prepareRevision(newPage, initialBody, user, { format: 'markdown' });
        await Page.pushRevision(newPage, newRevision, user);

        debug('createDraft created draft page', { pageId: newPage._id.toString(), path });
        return { status: 201 as const, body: { pageId: newPage._id.toString() } };
      } catch (err) {
        // A concurrent POST can win the unique-`path`-index race between
        // the pre-check and `create`. Re-resolve so the loser still gets
        // the proper 400 / 409 instead of a misleading `invalid_path`.
        if (isDuplicateKeyError(err)) {
          const raced = await resolveOccupied();
          if (raced) return raced;
        }
        debug('createDraft failed:', (err as Error).message);
        return {
          status: 400 as const,
          body: { error: 'invalid_path' as const, message: (err as Error).message || 'Failed to create draft.' },
        };
      }
    },

    /**
     * GET /api/v2/pages/drafts
     *
     * List the caller's own drafts, newest first. Powers the
     * `Creating pages` view; never returns another user's drafts.
     */
    listDrafts: async ({ req }) => {
      const user = req.user as UserDocument;
      debug('listDrafts called', { userId: user._id.toString() });

      const drafts = (await Page.find({ status: STATUS_DRAFT, creator: user._id })
        .sort({ createdAt: -1 })
        .select('_id path createdAt updatedAt')
        .lean()
        .exec()) as Array<{ _id: { toString(): string }; path: string; createdAt?: Date; updatedAt?: Date }>;

      return {
        status: 200 as const,
        body: {
          drafts: drafts.map((d) => ({
            pageId: d._id.toString(),
            path: d.path,
            createdAt: toISOStringOrNull(d.createdAt) ?? new Date().toISOString(),
            updatedAt: toISOStringOrNull(d.updatedAt) ?? toISOStringOrNull(d.createdAt) ?? new Date().toISOString(),
          })),
        },
      };
    },

    /**
     * DELETE /api/v2/pages/drafts/:id
     *
     * Cancel a draft, releasing its path. Only the author may cancel.
     * "No such draft", "not a draft", and "someone else's draft" all
     * collapse to the same 404 so draft existence is never leaked.
     */
    cancelDraft: async ({ params, req }) => {
      const user = req.user as UserDocument;
      const { id } = params;
      debug('cancelDraft called', { id, userId: user._id.toString() });

      const draftNotFound = {
        status: 404 as const,
        body: { error: 'draft_not_found' as const, message: 'Draft not found.' },
      };

      // A malformed id would make the `_id` query throw a CastError;
      // collapse it into the same 404 as "no such draft".
      if (!isValidObjectId(id)) {
        return draftNotFound;
      }

      const page = (await Page.findOne({ _id: id, status: STATUS_DRAFT, creator: user._id })) as PageDocument | null;
      if (!page) {
        return draftNotFound;
      }

      // `removePage` physically deletes the Page and its revisions —
      // the right semantics for "cancel": the path is freed and no
      // /trash redirect stub is left behind (unlike soft delete).
      await Page.removePage(page);

      debug('cancelDraft removed draft', { id, path: page.path });
      return { status: 200 as const, body: { pageId: id } };
    },
  });

  createExpressEndpoints(apiContract.draft, draftRouter, router);

  return router;
};
