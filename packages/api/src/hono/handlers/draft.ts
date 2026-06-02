/**
 * RFC-0006 Phase 4 Batch 6 — `draft` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/draft.ts`. Three endpoints
 * (RFC-0004 Phase 3 — drafts):
 *
 *   POST   /pages/drafts        — create a draft at a path
 *   GET    /pages/drafts        — list the caller's own drafts
 *   DELETE /pages/drafts/:id    — cancel a draft
 *
 * Auth is shared with the `page` / `page-preview` / `pageCollab` /
 * `presence` resources: the `revision` handler already applies
 * `createJwtAuth(crowi)` broadly to `/pages/*` (see
 * `packages/api/src/hono/handlers/revision.ts`). This handler relies on
 * the established register order (`revision -> page -> page-preview ->
 * pageCollab -> presence -> draft -> ...` in `buildHonoApp`) and does
 * NOT install jwtAuth itself — Hono does not dedupe middleware by
 * reference; re-installing would cost a second JWT verify +
 * `User.findById` per request.
 *
 * Wire-format parity:
 *
 *  - 201 `{ pageId }` for both fresh creation and the caller's
 *    idempotent re-POST on their own draft path.
 *  - 400 `{ error: 'invalid_path' | 'path_taken', message }` for
 *    uncreatable paths / published-page collisions.
 *  - 409 `{ error: 'path_taken_by_draft', owner, message }` when
 *    another user holds the draft.
 *  - 404 `{ error: 'draft_not_found', message }` collapses "no such
 *    draft", "not a draft", "not your draft", and malformed id into
 *    one response (existence leak guard).
 */
import { cancelDraftRoute, createDraftRoute, listDraftsRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { GRANT_PUBLIC, type PageDocument, STATUS_DRAFT } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { isValidObjectId, toISOStringOrNull } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { applyScope } from '../middleware/require-scope';

const debug = Debug('crowi:hono:handlers:draft');

/** MongoDB duplicate-key error code, raised by the unique `Page.path` index. */
const isDuplicateKeyError = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

const DRAFT_NOT_FOUND_BODY = {
  error: 'draft_not_found' as const,
  message: 'Draft not found.',
};

export const registerDraftRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const User = crowi.model('User');

  // RFC-0010 — drafts are page content (jwtAuth rides on the
  // revision-owned `/pages/*` apply). Create / cancel mutate, list reads.
  applyScope(app, createDraftRoute, 'pages:write');
  applyScope(app, listDraftsRoute, 'pages:read');
  applyScope(app, cancelDraftRoute, 'pages:write');

  return (
    app
      // --------------------------------------------------------------
      // POST /pages/drafts
      // --------------------------------------------------------------
      //
      // Create a draft at `path` with the default `GRANT_PUBLIC` grant.
      // The draft's author-only visibility is enforced entirely by
      // `status: 'draft'` (RFC-0005 Phase 1) — `findPage*` collapse
      // non-author access into 404, and listing / search / backlinks
      // all exclude other users' drafts by status. The grant stays
      // public so publish-on-save instantly makes the page visible
      // without a grant flip.
      .openapi(createDraftRoute, async (c) => {
        const user = c.get('user');
        const body = c.req.valid('json');
        // The seed revision's `body` is `required` and Mongoose rejects
        // an empty string. A brand-new draft is conceptually empty, so
        // seed a single newline — it renders to nothing and gives the
        // collab editor an effectively blank doc.
        const initialBody = body.initialBody && body.initialBody.length > 0 ? body.initialBody : '\n';
        const path = Page.normalizePath(body.path);

        debug('createDraft called', { path, userId: user._id.toString() });

        if (!Page.isCreatableName(path)) {
          return c.json({ error: 'invalid_path' as const, message: `Cannot create a page at this path (${path}).` }, 400);
        }

        // Resolve a path already occupied by a page into the right
        // response — caller's own draft → 201 (idempotent), another
        // user's draft → 409 with owner info, anything published → 400.
        // `null` means the path is free.
        const resolveOccupied = async () => {
          const existing = (await Page.findOne({ path })) as PageDocument | null;
          if (!existing) return null;
          if (existing.status !== STATUS_DRAFT) {
            return c.json({ error: 'path_taken' as const, message: `A page already exists at ${path}.` }, 400);
          }
          if (existing.isCreator(user)) {
            return c.json({ pageId: existing._id.toString() }, 201);
          }
          const owner = (await User.findById(existing.creator)) as UserDocument | null;
          return c.json(
            {
              error: 'path_taken_by_draft' as const,
              owner: owner
                ? { id: owner._id.toString(), username: owner.username, displayName: owner.name }
                : { id: '', username: 'unknown', displayName: 'unknown' },
              message: owner ? `This page is being created by @${owner.username}.` : 'This page is being created by another user.',
            },
            409,
          );
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
            grant: GRANT_PUBLIC,
            status: STATUS_DRAFT,
            grantedUsers: [user],
          });

          // Seed the first revision so the page is loadable / editable
          // immediately. `pushRevision` wires `revision` + fires the
          // `Page.create` event so backlinks / search run — both already
          // exclude other users' drafts (RFC-0004 Phase 2).
          const newRevision = await Revision.prepareRevision(newPage, initialBody, user, { format: 'markdown' });
          await Page.pushRevision(newPage, newRevision, user);

          debug('createDraft created draft page', { pageId: newPage._id.toString(), path });
          return c.json({ pageId: newPage._id.toString() }, 201);
        } catch (err) {
          // A concurrent POST can win the unique-`path`-index race
          // between the pre-check and `create`. Re-resolve so the loser
          // still gets the proper 400 / 409 instead of `invalid_path`.
          if (isDuplicateKeyError(err)) {
            const raced = await resolveOccupied();
            if (raced) return raced;
          }
          debug('createDraft failed:', (err as Error).message);
          return c.json({ error: 'invalid_path' as const, message: (err as Error).message || 'Failed to create draft.' }, 400);
        }
      })
      // --------------------------------------------------------------
      // GET /pages/drafts
      // --------------------------------------------------------------
      .openapi(listDraftsRoute, async (c) => {
        const user = c.get('user');
        debug('listDrafts called', { userId: user._id.toString() });

        const drafts = (await Page.find({ status: STATUS_DRAFT, creator: user._id })
          .sort({ createdAt: -1 })
          .select('_id path createdAt updatedAt')
          .lean()
          .exec()) as Array<{ _id: { toString(): string }; path: string; createdAt?: Date; updatedAt?: Date }>;

        return c.json(
          {
            drafts: drafts.map((d) => ({
              pageId: d._id.toString(),
              path: d.path,
              createdAt: toISOStringOrNull(d.createdAt) ?? new Date().toISOString(),
              updatedAt: toISOStringOrNull(d.updatedAt) ?? toISOStringOrNull(d.createdAt) ?? new Date().toISOString(),
            })),
          },
          200,
        );
      })
      // --------------------------------------------------------------
      // DELETE /pages/drafts/:id
      // --------------------------------------------------------------
      //
      // "No such draft", "not a draft", and "someone else's draft" all
      // collapse to the same 404 so draft existence is never leaked.
      .openapi(cancelDraftRoute, async (c) => {
        const user = c.get('user');
        const { id } = c.req.valid('param');
        debug('cancelDraft called', { id, userId: user._id.toString() });

        if (!isValidObjectId(id)) {
          return c.json(DRAFT_NOT_FOUND_BODY, 404);
        }

        const page = (await Page.findOne({ _id: id, status: STATUS_DRAFT, creator: user._id })) as PageDocument | null;
        if (!page) {
          return c.json(DRAFT_NOT_FOUND_BODY, 404);
        }

        // `removePage` physically deletes the Page and its revisions —
        // the right semantics for "cancel": the path is freed and no
        // /trash redirect stub is left behind (unlike soft delete).
        await Page.removePage(page);

        debug('cancelDraft removed draft', { id, path: page.path });
        return c.json({ pageId: id }, 200);
      })
  );
};
