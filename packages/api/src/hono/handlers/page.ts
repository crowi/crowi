/**
 * RFC-0006 Phase 4 Batch 4 — `page` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/page.ts`. 14 endpoints —
 * the largest single resource in the API. Wire-format parity with the
 * ts-rest era is preserved byte-for-byte (response shapes, error
 * envelopes, status codes, idempotency / leak-guard semantics).
 *
 * **jwtAuth ownership** (important):
 *
 *   The `revision` handler already installs
 *     app.use('/pages/*', createJwtAuth(crowi));
 *     app.use('/pages',   createJwtAuth(crowi));
 *   on the shared chain (see
 *   `packages/api/src/hono/handlers/revision.ts`). Hono does NOT dedupe
 *   middleware by reference — re-installing the same factory output on
 *   the same prefix would run JWT verify + `User.findById` twice per
 *   request. The page handler relies on the revision handler having
 *   registered first in `buildHonoApp`, and does NOT install jwtAuth
 *   itself. Phase 6 will revisit this implicit ordering when the
 *   Express bridge is removed.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  claimPageLinkAccessRoute,
  createPageRoute,
  IDEMPOTENCY_KEY_PATTERN,
  deletePageRoute,
  getPageRoute,
  getSeenUsersRoute,
  getWatchStatusRoute,
  likePageRoute,
  listPageChildrenRoute,
  listPagesRoute,
  PageGrantEnum,
  renamePageRoute,
  renameSubtreeRoute,
  revertDeletedPageRoute,
  revertToRevisionRoute,
  seenPageRoute,
  setPageGrantRoute,
  setWatchStatusRoute,
  type UserPublic,
  unlikePageRoute,
  updatePageRoute,
} from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { createMiddleware } from 'hono/factory';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import {
  type PageDocument,
  type PageModel,
  creatorPageListMatch,
  isTransitionalPageStatus,
  STATUS_DELETED,
  STATUS_PUBLISHED,
  startWithPageListMatch,
  visiblePageGrantOr,
  visiblePageStatusOr,
} from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { renamePageCommand } from 'src/service/page-history/commands/rename';
import { restorePageCommand } from 'src/service/page-history/commands/restore';
import { type SubtreeRenameInput, subtreeRenameCommand } from 'src/service/page-history/commands/subtree-rename';
import { trashPageCommand } from 'src/service/page-history/commands/trash';
import { completeOperation, createPageHistoryOperation, hasOperationCompletionEvidence, resolvePageHistoryOperation } from 'src/service/page-history/operation';
import { toPageHistoryEventSource } from 'src/service/page-history/page-event-command';
import { computeRevisionRenderArtifactsAsync, isPopulatedRevision, pageToResponse } from 'src/util/page-response';
import { pickRenderedAstShape, varyOnAstVersion } from 'src/util/rendered-ast-negotiation';
import { indexPageInSearchById } from 'src/util/page-search-index';
import { createRateLimiter } from 'src/util/rate-limit';
import { resolveRedisKeyspaceIfEnabled } from 'src/util/redis-keyspace';
import { actorFromUser, isValidObjectId, loadGrantedPage, toUserPublic } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { withRateLimit } from '../middleware/rate-limit';
import { applyScope } from '../middleware/require-scope';

import { INTERNAL_ERROR_BODY, INVALID_PAGE_ID_BODY, PAGE_NOT_FOUND_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:page');

const VALID_GRANTS: number[] = Object.values(PageGrantEnum);

const PAGE_NOT_GRANTED_BODY = {
  error: { code: 'PAGE_NOT_GRANTED' as const, message: 'Page is not granted for the user' as const },
};

const INVALID_GRANT_BODY = {
  error: {
    code: 'INVALID_GRANT' as const,
    message: 'grant must be one of 1 (public), 2 (restricted), 3 (specified), 4 (owner)' as const,
  },
};

// Build a 400 PAGE_* envelope without losing the literal narrowing on
// the `code` field (the contract widens `code` to `z.string()` for this
// resource so the helper keeps it simple).
const pageBadRequestBody = (code: string, message: string) => ({
  error: { code, message },
});

const pageRevisionConflictBody = () => ({
  error: { code: 'PAGE_REVISION_ERROR' as const, message: 'Revision error.' },
});

// §6 — shared 400 body for the `/x` ↔ `/x/` twin-creation guard, used by both
// the create and rename paths so the message stays identical.
const pageTwinExistsBody = (twinPath: string) =>
  pageBadRequestBody('PAGE_TWIN_EXISTS', `A page with the opposite trailing slash already exists at ${twinPath}. Portalize it instead.`);

// Structured 400 body shared by both subtree-rename paths (page_id-based and
// path-based). `partial: true` marks a mid-execution best-effort failure.
const renameTreeFailedBody = (message: string, conflicts: { path: string; reasons: string[] }[], partial?: boolean) => ({
  error: { code: 'PAGE_RENAME_TREE_FAILED' as const, message, conflicts, ...(partial ? { partial } : {}) },
});

/** `checkPagesRenamable`'s per-path error map → the non-empty `conflicts[]`. */
const toConflicts = (errorsByPath: Record<string, string[]>): { path: string; reasons: string[] }[] =>
  Object.entries(errorsByPath)
    .filter(([, reasons]) => reasons.length > 0)
    .map(([path, reasons]) => ({ path, reasons }));

// Both HTTP routes must cross this boundary so validation cannot drift to
// after the history command has durably sealed its target set. Replays pass a
// null map because their original preflight already completed before sealing.
type SubtreeRenameResult =
  | { ok: true; outcome: Awaited<ReturnType<typeof subtreeRenameCommand>> & { status: 'completed' } }
  | { ok: false; kind: 'fingerprint-mismatch' }
  | { ok: false; kind: 'validation'; conflicts: { path: string; reasons: string[] }[] }
  | { ok: false; kind: 'execution'; message: string };

// `Page` isn't an importable singleton (models/page.ts exports a
// crowi-bound factory, `export default (crowi) => {...}`) — it's a local
// `crowi.model('Page')` inside `registerPageRoutes`. So this module-level
// helper takes it as an argument rather than closing over a module import.
async function executeSubtreeRename(
  crowi: Crowi,
  Page: PageModel,
  pathMap: Record<string, string> | null,
  user: UserDocument,
  input: SubtreeRenameInput,
): Promise<SubtreeRenameResult> {
  if (pathMap != null) {
    const [hasError, errorsByPath] = (await Page.checkPagesRenamable(Object.values(pathMap), user)) as [boolean, Record<string, string[]>];
    if (hasError) {
      return { ok: false, kind: 'validation', conflicts: toConflicts(errorsByPath) };
    }
  }

  try {
    const outcome = await subtreeRenameCommand(crowi, input);
    if (outcome.status === 'fingerprint-mismatch') return { ok: false, kind: 'fingerprint-mismatch' };
    if (outcome.failures.length > 0) {
      return { ok: false, kind: 'execution', message: outcome.failures[0].error };
    }
    return { ok: true, outcome };
  } catch (err) {
    const error = err as Error;
    return { ok: false, kind: 'execution', message: error.message };
  }
}

export const registerPageRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const User = crowi.model('User');
  const Watcher = crowi.model('Watcher');

  // RFC-0010 — per-route scope guards (web sessions hold all scopes, so
  // these only narrow OAuth tokens). Registered before the openapi
  // handlers below so the guard runs first on a matching method + path.
  //
  // `seen` is a *view* side-effect (recording who looked at a page), so
  // it is `pages:read`, not write — matching the read-oriented intent of
  // marking a page seen. `like` / `unlike` / `watch` mutate per-user
  // page relations and are `pages:write`.
  applyScope(app, getPageRoute, 'pages:read');
  applyScope(app, listPagesRoute, 'pages:read');
  applyScope(app, listPageChildrenRoute, 'pages:read');
  applyScope(app, getSeenUsersRoute, 'pages:read');
  applyScope(app, getWatchStatusRoute, 'pages:read');
  applyScope(app, seenPageRoute, 'pages:read');
  applyScope(app, createPageRoute, 'pages:write');
  applyScope(app, updatePageRoute, 'pages:write');
  applyScope(app, setPageGrantRoute, 'pages:write');
  applyScope(app, likePageRoute, 'pages:write');
  applyScope(app, unlikePageRoute, 'pages:write');
  // `grantedUsers` is a durable ACL — `pages:write`, not `pages:read` (this
  // is the first of two defense-in-depth layers restricting grant-on-access
  // to web sessions; see `requireWebSessionMiddleware` below).
  applyScope(app, claimPageLinkAccessRoute, 'pages:write');
  applyScope(app, setWatchStatusRoute, 'pages:write');
  applyScope(app, deletePageRoute, 'pages:write');
  applyScope(app, revertDeletedPageRoute, 'pages:write');
  applyScope(app, revertToRevisionRoute, 'pages:write');
  applyScope(app, renamePageRoute, 'pages:write');
  applyScope(app, renameSubtreeRoute, 'pages:write');

  // feature-restricted-grant-share-banner Phase 1 — grant-on-first-access
  // is confined to web sessions (RFC-0010 `authContext.kind`). This is the
  // SECOND (and authoritative) defense-in-depth layer: web sessions hold
  // `ALL_SCOPES` (middleware/auth.ts), so a `pages:write` OAuth token /
  // PAT would otherwise sail through the scope guard above. Registered
  // BEFORE the rate limiter below so a non-web caller is rejected without
  // ever counting against the per-user rate-limit bucket — otherwise 30
  // rejected OAuth/PAT requests would exhaust that same user's real web
  // session budget (see the middleware registration order right below).
  const requireWebSessionMiddleware = createMiddleware<CrowiHonoBindings>(async (c, next) => {
    if (c.get('authContext').kind !== 'web') {
      return c.json(PAGE_NOT_GRANTED_BODY, 403);
    }
    await next();
  });
  app.use('/pages/link-access', requireWebSessionMiddleware);

  // Per-user rate limit for the claim endpoint — same limiter/middleware
  // shape as `autocomplete.ts` (30 req/min/user; `IdRedirector` fires this
  // at most once per id-URL navigation, so real usage is far below budget
  // while an ObjectId-enumeration sweep is throttled to a crawl).
  //
  // This throttle is anti-enumeration only, NOT an access gate: the gates
  // (web-session middleware, `pages:write` scope, GRANT_RESTRICTED-published
  // filter, atomic findOneAndUpdate) never touch Redis. `createRateLimiter`
  // fails OPEN on a Redis outage (rate-limit.ts) — an accepted tradeoff here
  // (reviewed 2026-07-12, CROWI-GRANT-REVIEW-003): a claim needs the exact
  // 12-byte ObjectId, whose ~64 non-time bits make brute force infeasible
  // even unthrottled, and GRANT_RESTRICTED semantics already treat "holds the
  // id URL" as intended access. Do not re-flag as a bypass.
  const linkAccessRateLimiter = createRateLimiter({
    name: 'page-link-access',
    limit: 30,
    windowMs: 60_000,
    redisClient: crowi.redis ?? null,
    keyspace: resolveRedisKeyspaceIfEnabled(crowi),
  });
  const linkAccessRateLimitMiddleware = withRateLimit({
    limiter: linkAccessRateLimiter,
    wireShape: 'autocomplete-envelope',
    message: () => 'Too many link-access requests. Try again shortly.',
  });
  app.use('/pages/link-access', linkAccessRateLimitMiddleware);

  /**
   * Build the seen-users response. `seenUsersCount` reflects the full
   * raw id-array length (matching the legacy `populatePageData`) so
   * inactive users dropped by `findUsersByIds`' status filter do not
   * deflate the count. `limit` only caps the returned `seenUsers` list.
   */
  const buildSeenUsersResponse = async (seenUserIds: ReadonlyArray<unknown>, limit?: number) => {
    const ids = seenUserIds.filter((id) => id != null);
    const seenUsersCount = ids.length;

    if (ids.length === 0) {
      return { seenUsers: [] as UserPublic[], seenUsersCount };
    }

    const idsToFetch = limit !== undefined ? ids.slice(0, limit) : ids;
    const populated = (await User.findUsersByIds(idsToFetch)) as UserDocument[];
    return {
      seenUsers: populated.map(toUserPublic),
      seenUsersCount,
    };
  };

  return (
    app
      // --------------------------------------------------------------
      // GET /pages — getPage (path-or-id)
      // --------------------------------------------------------------
      .openapi(getPageRoute, async (c) => {
        const user = c.get('user');
        const { path, page_id, revision_id } = c.req.valid('query');

        debug('getPage called with:', { path, page_id, revision_id, userId: user._id });

        if (!path && !page_id) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        try {
          let page: PageDocument | null = null;

          // page_id takes precedence over path (legacy controller order).
          if (page_id) {
            page = await Page.findPageByIdAndGrantedUser(page_id, user);
          } else if (path) {
            page = await Page.findPage(path, user, revision_id || null);
          }

          if (!page) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          const pageResponse = pageToResponse(page, { withMeta: true, withRenderedAst: true });

          // On-the-fly fallback for legacy revisions — one pipeline run
          // produces both meta + renderedAst, stored values win on merge.
          if (pageResponse.revision && isPopulatedRevision(page.revision)) {
            const { meta, renderedAst, renderedAstArtifactKey } = await computeRevisionRenderArtifactsAsync(
              crowi,
              page.revision.meta,
              page.revision.renderedAst,
              page.revision.body,
              actorFromUser(user),
              page.revision.rendererVersion,
              page._id?.toString(),
            );
            pageResponse.revision.meta = meta;
            // RFC-0023 §9 — envelope for `X-Crowi-Ast-Version: 1`
            // declarants, verbatim bare Root for everyone else.
            pageResponse.revision.renderedAst = pickRenderedAstShape(c.get('astVersion'), renderedAst);
            pageResponse.revision.renderedAstArtifactKey = renderedAstArtifactKey;
          }
          varyOnAstVersion(c);

          // Fire-and-forget recently-viewed touch — Redis hiccups must
          // not block the page read.
          crowi.lru.add(user._id.toString(), page._id.toString())?.catch?.((err: unknown) => {
            debug('lru.add failed (non-fatal):', err);
          });

          return c.json({ page: pageResponse }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error fetching page:', error.message);

          if (error.message === 'Page not found' || error.name === 'Crowi:Page:NotFound') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          if (error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_GRANTED_BODY, 403);
          }
          // feature-live-page-sync-reconcile — anything else (e.g. a
          // transient `computeRevisionRenderArtifactsAsync` / renderer
          // failure) is a genuine server error, not a not-found. Collapsing
          // it into 404 used to make a page that failed to RENDER look like
          // a page that doesn't EXIST — a client reconciling its cache
          // against this endpoint (read-side soft-refresh) would wrongly
          // treat a live, readable page as deleted. Return 500 so callers
          // can tell "try again" from "gone" apart.
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
      // --------------------------------------------------------------
      // GET /pages/list — listPages
      // --------------------------------------------------------------
      .openapi(listPagesRoute, async (c) => {
        const user = c.get('user');
        const { path, user: userParam, limit, offset, include_deleted, sort, order, revision_id } = c.req.valid('query');
        // Mongoose sort direction: 1 ascending, -1 descending.
        const sortDir = order === 'asc' ? 1 : -1;

        // Force-enable include_deleted for /trash and /trash/<sub> requests so
        // the legacy deletedPageListShow semantics are preserved even when
        // the client omits the query flag.
        const isTrashPath = !!path && (path === '/trash' || path.startsWith('/trash/'));
        const includeDeletedPage = include_deleted || isTrashPath;

        debug('listPages called with:', { path, user: userParam, limit, offset, includeDeletedPage, userId: user._id });

        try {
          let pages: PageDocument[] = [];
          let portalPage: PageDocument | null = null;
          // §4 — when listing a portal path (`/foo/`) that has no portal
          // document of its own, surface the content page sitting at the
          // stripped path (`/foo`) so the list view can offer "portalize
          // this page" instead of "Create Portal". Mutually exclusive with
          // `portalPage`. Only ever set in the path branch below.
          let contentPage: PageDocument | null = null;
          // feature-profile-stats-and-page-total — the exact count of
          // `pages`' full (unpaginated) set, always set below regardless of
          // which branch runs. Each branch's count query shares the SAME
          // match conditions as its `find()`, so `total` never drifts from
          // what the client can actually page through.
          let total = 0;

          if (userParam) {
            // List pages by creator.
            const targetUser = await User.findById(userParam);
            if (!targetUser) {
              return c.json(
                {
                  pages: [],
                  pager: { prev: null, next: null, offset: 0 },
                  portalPage: null,
                  total: 0,
                },
                200,
              );
            }

            // The creator listing keeps its own createdAt-desc order
            // (the profile surface has no sort control); the `sort`/`order`
            // query only drives the path + root directory listings below.
            // `find` and `count` share `creatorPageListMatch` — the same
            // match `findListByCreator` builds internally — and run in
            // parallel (no id-exclusion dependency in this branch).
            const creatorMatch = creatorPageListMatch(targetUser._id, user._id);
            const [rawPages, creatorTotal] = await Promise.all([
              Page.findListByCreator(targetUser, { limit, offset }, user),
              Page.countDocuments(creatorMatch),
            ]);
            pages = (await Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];
            total = creatorTotal;
          } else if (path && path !== '/') {
            // List pages by path. /trash subtrees skip findPortalPage to
            // mirror the legacy deletedPageListShow which always rendered
            // with page=null.
            //
            // portalPage / contentPage must be resolved BEFORE the pages
            // find+count below: their ids need to fold into the SAME match
            // both queries share (via `excludeIds` — see
            // `startWithPageListMatch`), or a to-be-dropped row would still
            // count against `skip`/`limit`, silently shrinking
            // `pages.length` below `limit` while more rows remain — which
            // collapses `pager.next` to `null` one page too early even
            // though `total` is still correct. `total` must equal the final
            // `pages` set exactly, so the same ids are excluded from both.
            const rawPortalPage = isTrashPath ? null : await Page.findPortalPage(path, user, revision_id || null);
            portalPage = rawPortalPage ? ((await Page.populate(rawPortalPage, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as PageDocument) : null;

            // §4 — a portal path (`/foo/`) with no portal document but a
            // content page at the stripped path (`/foo`): resolve that
            // content page (grant/draft-respecting; not-found → null) so the
            // client can offer to portalize it. Skipped for /trash and when
            // a real portal already exists (the two are exclusive).
            if (!isTrashPath && !portalPage && path.endsWith('/')) {
              const strippedPath = path.replace(/\/+$/, '');
              if (strippedPath !== '') {
                const rawContentPage = await Page.findPortalPage(strippedPath, user, null);
                contentPage = rawContentPage
                  ? ((await Page.populate(rawContentPage, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as PageDocument)
                  : null;
              }
            }

            // `find` and `count` now run in parallel and share the exact
            // same match: `findListByStartWith` builds it internally via
            // `startWithPageListMatch(path, user._id, { includeDeletedPage,
            // excludeIds })` — the same call made here for `count` — the
            // same precedent as the creator branch above sharing
            // `creatorPageListMatch`.
            const excludedIds = [portalPage?._id, contentPage?._id].filter((id): id is Types.ObjectId => id != null);
            const [rawPages, pathTotal] = await Promise.all([
              Page.findListByStartWith(path, user, { limit, offset, includeDeletedPage, sort, desc: sortDir, excludeIds: excludedIds }),
              Page.countDocuments(startWithPageListMatch(path, user._id, { includeDeletedPage, excludeIds: excludedIds })),
            ]);
            pages = (await Page.populate(rawPages, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as unknown as PageDocument[];
            total = pathTotal;
          } else {
            // List all pages the user can access (including path='/').
            //
            // Both visibility predicates come from the Page model:
            //   visiblePageStatusOr — published + the viewer's own drafts
            //   visiblePageGrantOr  — public + restricted/specified/owner
            //                         pages where the viewer is in
            //                         grantedUsers
            //
            // Previously this branch hard-coded `grant: { $in: [1, 2] }`,
            // which (a) silently dropped GRANT_OWNER and GRANT_SPECIFIED
            // pages the viewer creates or is granted, and (b) leaked
            // GRANT_RESTRICTED pages to non-members because the
            // grantedUsers check was missing. Replacing both predicates
            // with the model helpers keeps the path-based and root /
            // no-path branches consistent.
            //
            // include_deleted: when set (or when isTrashPath forced it),
            // omit the status filter entirely — mirrors
            // `findListByStartWith`, which adds visiblePageStatusOr only
            // in the `!includeDeletedPage` branch. Without this the root
            // branch would silently ignore the flag (the status helper
            // never emits STATUS_DELETED).
            const andClauses: Record<string, unknown>[] = [{ $or: visiblePageGrantOr(user._id) }];
            if (!includeDeletedPage) {
              andClauses.push({ $or: visiblePageStatusOr(user._id) });
            }
            const baseConditions = {
              redirectTo: null,
              $and: andClauses,
            };

            // Same rationale as the path-prefix branch above: `portalPage`
            // must be resolved before the pages find/count so its id can
            // fold into the SAME match both share via `_id: $nin` —
            // otherwise skip/limit would count the to-be-dropped portal row
            // against `limit`, desyncing `pages.length` from
            // `pager.next`/`total`. `path === '/'` is the only case in this
            // branch that can resolve a `portalPage` (the path-omitted case
            // leaves it `null`, so `conditions` below falls back to
            // `baseConditions` unchanged).
            if (path === '/') {
              const rawPortalPage = await Page.findPortalPage(path, user, revision_id || null);
              portalPage = rawPortalPage ? ((await Page.populate(rawPortalPage, [{ path: 'creator' }, { path: 'lastUpdateUser' }])) as PageDocument) : null;
            }

            const conditions = portalPage ? { ...baseConditions, _id: { $nin: [portalPage._id] } } : baseConditions;
            const [rawPages, rootTotal] = await Promise.all([
              Page.find(conditions)
                .sort({ [sort]: sortDir })
                .skip(offset)
                .limit(limit)
                .populate({ path: 'revision', populate: { path: 'author' } })
                .populate('creator')
                .populate('lastUpdateUser')
                .exec(),
              Page.countDocuments(conditions),
            ]);
            pages = rawPages;
            total = rootTotal;
          }

          // The portal document of the listed path is surfaced separately
          // as `portalPage` (rendered as the portal card / fallback
          // header) — it must not also appear as a child row (its link
          // would be a no-op: it's the page you're already on). Both
          // branches above now exclude `portalPage`/`contentPage` ids at
          // the match level (`_id: $nin`, shared with `count`) precisely so
          // this never has anything to remove; these filters stay only as a
          // defence-in-depth belt-and-suspenders in case a future branch
          // resolves either page without threading the exclusion through.
          if (portalPage) {
            const portalId = String(portalPage._id);
            pages = pages.filter((page) => String(page._id) !== portalId);
          }
          if (contentPage) {
            const contentId = String(contentPage._id);
            pages = pages.filter((page) => String(page._id) !== contentId);
          }

          const pageResponses = pages.map((page) => pageToResponse(page));
          // The portal document is rendered as a full page (PageContent)
          // by the web client, so — unlike the list rows — it needs
          // `renderedAst`. Mirror the getPage detail path: emit meta +
          // renderedAst and run the on-the-fly fallback so legacy /
          // version-mismatched revisions still render instead of getting
          // stuck on the "Rendering…" placeholder. List rows stay lean
          // (no renderedAst) as before.
          const portalPageResponse = portalPage ? pageToResponse(portalPage, { withMeta: true, withRenderedAst: true }) : null;
          if (portalPageResponse?.revision && portalPage && isPopulatedRevision(portalPage.revision)) {
            const { meta, renderedAst, renderedAstArtifactKey } = await computeRevisionRenderArtifactsAsync(
              crowi,
              portalPage.revision.meta,
              portalPage.revision.renderedAst,
              portalPage.revision.body,
              actorFromUser(user),
              portalPage.revision.rendererVersion,
              portalPage._id?.toString(),
            );
            portalPageResponse.revision.meta = meta;
            // RFC-0023 §9 — same negotiation as the getPage detail path.
            portalPageResponse.revision.renderedAst = pickRenderedAstShape(c.get('astVersion'), renderedAst);
            portalPageResponse.revision.renderedAstArtifactKey = renderedAstArtifactKey;
          }
          varyOnAstVersion(c);

          // §4 — content page emitted lean (no renderedAst): the client uses
          // it only to drive the portalize banner (id / path / revision id),
          // never to render the page body.
          const contentPageResponse = contentPage ? pageToResponse(contentPage) : null;

          const prev = offset > 0 ? Math.max(0, offset - limit) : null;
          const next = pages.length === limit ? offset + limit : null;

          return c.json(
            {
              pages: pageResponses,
              pager: { prev, next, offset },
              portalPage: portalPageResponse,
              contentPage: contentPageResponse,
              total,
            },
            200,
          );
        } catch (err) {
          debug('Error listing pages:', (err as Error).message);
          // Legacy behaviour: an unexpected error collapses to an empty
          // list rather than 500. Preserved for wire compatibility.
          return c.json(
            {
              pages: [],
              pager: { prev: null, next: null, offset: 0 },
              portalPage: null,
              contentPage: null,
              total: 0,
            },
            200,
          );
        }
      })
      // --------------------------------------------------------------
      // GET /pages/children — listPageChildren (sidebar tree)
      // --------------------------------------------------------------
      .openapi(listPageChildrenRoute, async (c) => {
        const user = c.get('user');
        const { path } = c.req.valid('query');
        debug('listPageChildren called with:', { path, userId: user._id });
        try {
          const children = await Page.findChildSegments(path, user);
          return c.json({ children }, 200);
        } catch (err) {
          // Mirror listPages: a scan error collapses to an empty tree
          // rather than 500 — the sidebar is non-critical chrome.
          debug('Error listing page children:', (err as Error).message);
          return c.json({ children: [] }, 200);
        }
      })
      // --------------------------------------------------------------
      // POST /pages — createPage
      // --------------------------------------------------------------
      .openapi(createPageRoute, async (c) => {
        const user = c.get('user');
        const { path, body, grant } = c.req.valid('json');

        debug('createPage called with:', { path, grant, userId: user._id });

        if (grant !== undefined && !VALID_GRANTS.includes(grant)) {
          return c.json(INVALID_GRANT_BODY, 400);
        }

        // Draft creation (draft.ts:91) and rename (:1028) both reject a
        // path containing a literal '+' via `Page.isCreatableName` before
        // touching the DB. This route was missing that check, so a page
        // with a literal '+' in its path could be created even though the
        // web's `+`-as-encoded-space contract (`pagePathToHref` /
        // `decodePagePathFromUrl`) means such a page is unreachable by
        // URL for anyone but its creator.
        const normalizedCreatePath = Page.normalizePath(path);
        if (!Page.isCreatableName(normalizedCreatePath)) {
          return c.json(pageBadRequestBody('PAGE_INVALID_NAME', `Cannot create a page at this path (${normalizedCreatePath})`), 400);
        }

        try {
          const existing = await Page.findPage(path, user, null, /* ignoreNotFound */ true);
          if (existing !== null) {
            return c.json(pageBadRequestBody('PAGE_EXISTS', 'Page exists'), 400);
          }

          // §6 — block the `/x` ↔ `/x/` double-state: refuse to create a
          // page whose trailing-slash twin already exists as a real page.
          // Use `normalizePath` so the twin check sees the same path the
          // creation will use.
          const twin = await Page.findExistingTwin(normalizedCreatePath);
          if (twin) {
            return c.json(pageTwinExistsBody(twin.path), 400);
          }

          // RFC-0010 — record the edit channel (web / oauth / pat) so the
          // history view can flag API-token edits.
          const createOptions: { grant?: number; editVia: 'web' | 'oauth' | 'pat' } = { editVia: c.get('authContext').kind };
          if (grant !== undefined) createOptions.grant = grant;
          const created = (await Page.createPage(path, body, user, createOptions)) as PageDocument | null;
          if (!created) {
            throw new Error('Failed to create page.');
          }

          const populated = await Page.populatePageData(created, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error creating page:', error.message);

          if (error.message === 'Cannot create non existent user page.') {
            return c.json(pageBadRequestBody('NON_EXISTENT_USER_PAGE', error.message), 400);
          }
          // Both 'existed path' and 'not granted' collapse to PAGE_EXISTS
          // — the latter is a stricter-grant race we must not leak.
          if (error.message === 'Cannot create new page to existed path' || error.message === 'Page is not granted for the user') {
            return c.json(pageBadRequestBody('PAGE_EXISTS', 'Page exists'), 400);
          }
          return c.json(pageBadRequestBody('PAGE_CREATE_FAILED', error.message || 'Failed to create page'), 400);
        }
      })
      // --------------------------------------------------------------
      // PUT /pages — updatePage
      // --------------------------------------------------------------
      .openapi(updatePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id, body, revision_id, grant } = c.req.valid('json');

        debug('updatePage called with:', { page_id, revision_id, grant, userId: user._id });

        if (grant !== undefined && !VALID_GRANTS.includes(grant)) {
          return c.json(INVALID_GRANT_BODY, 400);
        }

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          if (revision_id && !pageData.isUpdatable(revision_id)) {
            return c.json(pageRevisionConflictBody(), 409);
          }

          // RFC-0010 — record the edit channel (web / oauth / pat) so the
          // history view can flag API-token edits.
          const updateOptions = { grant: grant ?? pageData.grant, editVia: c.get('authContext').kind };
          const updated = (await Page.updatePage(pageData, body, user, updateOptions)) as PageDocument;
          const populated = await Page.populatePageData(updated, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error updating page:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_UPDATE_FAILED', error.message || 'Failed to update page'), 400);
        }
      })
      // --------------------------------------------------------------
      // PUT /pages/grant — setPageGrant
      // --------------------------------------------------------------
      .openapi(setPageGrantRoute, async (c) => {
        const user = c.get('user');
        const { page_id, grant } = c.req.valid('json');

        debug('setPageGrant called with:', { page_id, grant, userId: user._id });

        if (!VALID_GRANTS.includes(grant)) {
          return c.json(INVALID_GRANT_BODY, 400);
        }

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          // RFC-0021 §6.2 DC-10 — the edit channel (web / oauth / pat)
          // becomes the `visibility_changed` event's `source`.
          const updated = (await Page.updateGrant(pageData, grant, user, { source: c.get('authContext').kind })) as PageDocument;
          // feature-restricted-grant-share-banner §6 — symmetric with the
          // claim handler above: `updateGrant` resets `grantedUsers` to just
          // the actor, so any link-invited co-editors indexed by a prior
          // claim must be reflected in ES too (fire-and-forget; re-reads
          // fresh so it always reflects this write, not this in-memory
          // snapshot). Tracked via `trackSideEffect` (same convention as
          // `events/page.ts`'s autoWatch/notifyPageUpdate/registerBacklinks)
          // so the test harness's `drainSideEffects()` can await it before
          // asserting on the search driver.
          crowi.trackSideEffect(indexPageInSearchById(crowi, page_id));
          const populated = await Page.populatePageData(updated, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error updating page grant:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_GRANT_UPDATE_FAILED', error.message || 'Failed to update page grant'), 400);
        }
      })
      // --------------------------------------------------------------
      // POST /pages/seen — seenPage (idempotent via Page.seen addToSet)
      // --------------------------------------------------------------
      .openapi(seenPageRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('json');

        debug('seenPage called with:', { page_id, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) return c.json(PAGE_NOT_FOUND_BODY, 404);

        const updated = (await loaded.page.seen(user)) as PageDocument;
        return c.json(await buildSeenUsersResponse(updated.seenUsers), 200);
      })
      // --------------------------------------------------------------
      // GET /pages/seen-users — getSeenUsers
      // --------------------------------------------------------------
      .openapi(getSeenUsersRoute, async (c) => {
        const user = c.get('user');
        const { page_id, limit } = c.req.valid('query');

        debug('getSeenUsers called with:', { page_id, limit, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        return c.json(await buildSeenUsersResponse(loaded.page.seenUsers, limit), 200);
      })
      // --------------------------------------------------------------
      // POST /pages/like — likePage
      // --------------------------------------------------------------
      .openapi(likePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('json');

        debug('likePage called with:', { page_id, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        // `like` is a no-op when the user already liked the page.
        await loaded.page.like(user);
        const populated = await Page.populatePageData(loaded.page, null);
        return c.json({ page: pageToResponse(populated) }, 200);
      })
      // --------------------------------------------------------------
      // POST /pages/unlike — unlikePage
      // --------------------------------------------------------------
      .openapi(unlikePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('json');

        debug('unlikePage called with:', { page_id, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        await loaded.page.unlike(user);
        const populated = await Page.populatePageData(loaded.page, null);
        return c.json({ page: pageToResponse(populated) }, 200);
      })
      // --------------------------------------------------------------
      // POST /pages/link-access — claimPageLinkAccess (grant-on-first-
      // access for GRANT_RESTRICTED pages). ONLY caller: `IdRedirector`.
      // Web-session + scope enforcement already happened in the
      // middlewares registered above — nothing to check here (single
      // authoritative enforcement point).
      // --------------------------------------------------------------
      .openapi(claimPageLinkAccessRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('json');

        debug('claimPageLinkAccess called with:', { page_id, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }

        try {
          const { page, granted } = await Page.findPageByIdForSharedLinkAccess(page_id, user);

          // Only reindex when a write actually happened — public / creator
          // / already-granted pass-through calls make zero ACL changes, so
          // there is nothing new for the search index to reflect.
          // `indexPageInSearchById` re-reads fresh from Mongo, so it always
          // indexes the just-committed `grantedUsers`, not this in-memory
          // snapshot. Tracked via `trackSideEffect` so tests can
          // `drainSideEffects()` before asserting on the search driver.
          if (granted) {
            crowi.trackSideEffect(indexPageInSearchById(crowi, page_id));
          }

          const populated = await Page.populatePageData(page, null);
          return c.json({ page: pageToResponse(populated), granted }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error claiming page link access:', error.message);

          if (error.message === 'Page not found' || error.name === 'Crowi:Page:NotFound') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          if (error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_GRANTED_BODY, 403);
          }
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }
      })
      // --------------------------------------------------------------
      // GET /pages/watch — getWatchStatus
      // --------------------------------------------------------------
      .openapi(getWatchStatusRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('query');

        debug('getWatchStatus called with:', { page_id, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        // feature-watch-autosubscribe — watch state is now exactly the
        // presence of a WATCH watcher row. Participation auto-creates one
        // (events/page.ts + comment handler), so the previous derive-from-
        // getNotificationTargetUsers fallback is no longer needed.
        const watcher = await Watcher.findByUserIdAndTargetId(user._id, loaded.page._id);
        return c.json({ watching: watcher ? watcher.isWatching() : false }, 200);
      })
      // --------------------------------------------------------------
      // PUT /pages/watch — setWatchStatus (2-state: WATCH / IGNORE)
      // --------------------------------------------------------------
      .openapi(setWatchStatusRoute, async (c) => {
        const user = c.get('user');
        const { page_id, watching } = c.req.valid('json');

        debug('setWatchStatus called with:', { page_id, watching, userId: user._id });

        if (!isValidObjectId(page_id)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }
        const loaded = await loadGrantedPage(Page, page_id, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        const status = watching ? Watcher.STATUS_WATCH : Watcher.STATUS_IGNORE;
        await Watcher.watchByPageId(user._id, loaded.page._id, status);
        return c.json({ watching }, 200);
      })
      // --------------------------------------------------------------
      // DELETE /pages — deletePage (soft / hard with completely=true)
      // --------------------------------------------------------------
      .openapi(deletePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id, revision_id, completely } = c.req.valid('json');

        debug('deletePage called with:', { page_id, revision_id, completely, userId: user._id });

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          if (completely === true) {
            // Hard delete bypasses the revision check (legacy parity).
            await Page.completelyDeletePage(pageData, user);
            // The document is gone from Mongo; echo the in-memory snapshot
            // so the client knows what was deleted.
            return c.json({ page: pageToResponse(pageData) }, 200);
          }

          if (revision_id && !pageData.isUpdatable(revision_id)) {
            return c.json(pageRevisionConflictBody(), 409);
          }

          // RFC-0021 Phase 2c-2a — soft delete runs as a recorded operation.
          // The hard branch above returns before this and is untouched.
          const trashKey = c.req.header('idempotency-key');
          if (!trashKey) {
            return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' as const, message: 'This request requires an Idempotency-Key header.' } }, 400);
          }
          if (!IDEMPOTENCY_KEY_PATTERN.test(trashKey)) {
            return c.json(pageBadRequestBody('PAGE_DELETE_FAILED', 'Idempotency-Key must be 16-128 URL-safe characters.'), 400);
          }

          const trashSource = toPageHistoryEventSource(c.get('authContext')?.kind);
          const trashFingerprint = createHash('sha256')
            .update(JSON.stringify({ page_id: String(pageData._id), completely: false }))
            .digest('hex');
          const trashKeyTuple = { actor: user._id, command: 'trash' as const, idempotencyKey: trashKey };
          const inProgressBody = { error: { code: 'PAGE_TRANSITION_IN_PROGRESS' as const, message: 'This page is being moved by another operation.' } };
          const keyConflictBody = {
            error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' },
          };

          const replayTrash = async (operation: { result?: { status: string; code?: string; message?: string } | null }) => {
            if (operation.result?.status === 'failed') {
              const code = operation.result.code ?? 'PAGE_TRANSITION_INCOMPLETE';
              return c.json({ error: { code, message: operation.result.message ?? 'The delete did not complete.' } } as never, 400);
            }
            const current = (await Page.findById(pageData._id)) as PageDocument | null;
            if (!current) return c.json(PAGE_NOT_FOUND_BODY, 404);
            if (isTransitionalPageStatus(current.status)) return c.json(inProgressBody, 409);
            const populatedReplay = await Page.populatePageData(current, null);
            c.header('Idempotency-Replayed', 'true');
            return c.json({ page: pageToResponse(populatedReplay) }, 200);
          };

          const trashResolution = await resolvePageHistoryOperation(crowi, trashKeyTuple, trashFingerprint);
          if (trashResolution.kind === 'fingerprint-mismatch') return c.json(keyConflictBody, 409);
          if (trashResolution.kind === 'settled') return replayTrash(trashResolution.operation);
          if (trashResolution.kind === 'in-flight') return c.json(inProgressBody, 409);

          // Only a first delivery validates deletability, for the same reason
          // rename resolves first: a replay runs against a page already sitting
          // in `/trash/`, where the answer would differ.
          const isNonExistentUserPage = await Page.isNonExistentUserPage(pageData.path);
          if (!Page.isDeletableName(pageData.path) && !isNonExistentUserPage) {
            return c.json(pageBadRequestBody('PAGE_DELETE_FAILED', 'Page is not deletable.'), 400);
          }

          const trashOperationId = randomUUID();
          const trashCreated = await createPageHistoryOperation(crowi, {
            ...trashKeyTuple,
            operationId: trashOperationId,
            requestFingerprint: trashFingerprint,
            page: pageData._id,
            fromPath: pageData.path,
            toPath: Page.getDeletedPageName(pageData.path),
            fromStatus: pageData.status ?? null,
            fromStatusPresent: pageData.status != null,
            toStatus: STATUS_DELETED,
            createRedirect: true,
            source: trashSource,
          });
          if (trashCreated.kind === 'lost') {
            if (trashCreated.resolution.kind === 'fingerprint-mismatch') return c.json(keyConflictBody, 409);
            if (trashCreated.resolution.kind === 'settled') return replayTrash(trashCreated.resolution.operation);
            return c.json(inProgressBody, 409);
          }

          const trashOutcome = await trashPageCommand(crowi, {
            page: pageData,
            fromPath: pageData.path,
            toPath: Page.getDeletedPageName(pageData.path),
            fromStatus: pageData.status ?? null,
            fromStatusPresent: pageData.status != null,
            operationId: trashOperationId,
            actor: user._id,
            user,
            source: trashSource,
          });

          if (trashOutcome.status === 'owned-elsewhere' || trashOutcome.status === 'contended') return c.json(inProgressBody, 409);
          if (trashOutcome.status === 'page-missing') {
            await completeOperation(crowi, trashOperationId, { status: 'moot' });
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          if (trashOutcome.status === 'incomplete') {
            const message = 'The page was moved but the delete did not finish. Ask an administrator to run the page-history repair.';
            return c.json({ error: { code: 'PAGE_TRANSITION_INCOMPLETE' as const, message } }, 400);
          }

          if (await hasOperationCompletionEvidence(crowi, trashCreated.operation)) {
            await completeOperation(crowi, trashOperationId, { status: 'succeeded' });
          }
          // Soft delete does not flow through a page event (see the
          // corrected comment in events/page.ts's onDelete), so nothing
          // else removes this now-trashed page from the search index.
          // Fire-and-forget, symmetric with the claim / setPageGrant
          // reindex calls above; tracked via `trackSideEffect` so tests can
          // `drainSideEffects()` before asserting on the search driver.
          crowi.trackSideEffect(indexPageInSearchById(crowi, page_id));
          const populated = await Page.populatePageData(trashOutcome.page, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error deleting page:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_DELETE_FAILED', error.message || 'Failed to delete page'), 400);
        }
      })
      // --------------------------------------------------------------
      // POST /pages/revert — revertDeletedPage
      // --------------------------------------------------------------
      .openapi(revertDeletedPageRoute, async (c) => {
        const user = c.get('user');
        const { page_id } = c.req.valid('json');

        debug('revertDeletedPage called with:', { page_id, userId: user._id });

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          // RFC-0021 Phase 2c-2a — restore runs as a recorded operation.
          const restoreKey = c.req.header('idempotency-key');
          if (!restoreKey) {
            return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' as const, message: 'This request requires an Idempotency-Key header.' } }, 400);
          }
          if (!IDEMPOTENCY_KEY_PATTERN.test(restoreKey)) {
            return c.json(pageBadRequestBody('PAGE_REVERT_FAILED', 'Idempotency-Key must be 16-128 URL-safe characters.'), 400);
          }

          const restoreSource = toPageHistoryEventSource(c.get('authContext')?.kind);
          const restoreFingerprint = createHash('sha256')
            .update(JSON.stringify({ page_id: String(pageData._id) }))
            .digest('hex');
          const restoreKeyTuple = { actor: user._id, command: 'restore' as const, idempotencyKey: restoreKey };
          const restoreInProgress = { error: { code: 'PAGE_TRANSITION_IN_PROGRESS' as const, message: 'This page is being moved by another operation.' } };
          const restoreKeyConflict = {
            error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' },
          };

          const replayRestore = async (operation: { result?: { status: string; code?: string; message?: string } | null }) => {
            if (operation.result?.status === 'failed') {
              const code = operation.result.code ?? 'PAGE_TRANSITION_INCOMPLETE';
              return c.json({ error: { code, message: operation.result.message ?? 'The restore did not complete.' } } as never, 400);
            }
            const current = (await Page.findById(pageData._id)) as PageDocument | null;
            if (!current) return c.json(PAGE_NOT_FOUND_BODY, 404);
            if (isTransitionalPageStatus(current.status)) return c.json(restoreInProgress, 409);
            const populatedReplay = await Page.populatePageData(current, null);
            c.header('Idempotency-Replayed', 'true');
            return c.json({ page: pageToResponse(populatedReplay) }, 200);
          };

          const restoreResolution = await resolvePageHistoryOperation(crowi, restoreKeyTuple, restoreFingerprint);
          if (restoreResolution.kind === 'fingerprint-mismatch') return c.json(restoreKeyConflict, 409);
          if (restoreResolution.kind === 'settled') return replayRestore(restoreResolution.operation);
          if (restoreResolution.kind === 'in-flight') return c.json(restoreInProgress, 409);

          // First delivery only: clear the destination. This is destructive and
          // deliberately sits BEFORE the operation record exists — if it fails
          // partway, nothing was recorded, and the exposure is identical to the
          // legacy restore's (the stub is gone, the page is still in the trash,
          // and asking again finds no occupant). A replay short-circuits above,
          // so it never re-runs against a page that already came back.
          const restoreToPath = Page.getRevertDeletedPageName(pageData.path);
          if (await Page.isNonExistentUserPage(restoreToPath)) {
            return c.json(pageBadRequestBody('PAGE_REVERT_FAILED', 'Cannot revert non existent user page.'), 400);
          }
          const occupant = (await Page.findPageByPath(restoreToPath)) as PageDocument | null;
          if (occupant != null) {
            // Only the stub this page's own delete left behind may be removed.
            // Anything else means the data is inconsistent and is not ours to
            // destroy.
            if (occupant.redirectTo !== pageData.path) {
              return c.json(
                pageBadRequestBody('PAGE_REVERT_FAILED', 'The new page of to revert is exists and the redirect path of the page is not the deleted page.'),
                400,
              );
            }
            // Internal repair, not a user-facing hard delete — no prompt.
            await Page.completelyDeletePage(occupant, user, { invalidation: { mode: 'skip', reason: 'revert-deleted' } });
          }

          const restoreOperationId = randomUUID();
          const restoreCreated = await createPageHistoryOperation(crowi, {
            ...restoreKeyTuple,
            operationId: restoreOperationId,
            requestFingerprint: restoreFingerprint,
            page: pageData._id,
            fromPath: pageData.path,
            toPath: restoreToPath,
            fromStatus: pageData.status ?? null,
            fromStatusPresent: pageData.status != null,
            toStatus: STATUS_PUBLISHED,
            createRedirect: false,
            source: restoreSource,
          });
          if (restoreCreated.kind === 'lost') {
            if (restoreCreated.resolution.kind === 'fingerprint-mismatch') return c.json(restoreKeyConflict, 409);
            if (restoreCreated.resolution.kind === 'settled') return replayRestore(restoreCreated.resolution.operation);
            return c.json(restoreInProgress, 409);
          }

          const restoreOutcome = await restorePageCommand(crowi, {
            page: pageData,
            fromPath: pageData.path,
            toPath: restoreToPath,
            fromStatus: pageData.status ?? null,
            fromStatusPresent: pageData.status != null,
            operationId: restoreOperationId,
            actor: user._id,
            source: restoreSource,
          });

          if (restoreOutcome.status === 'owned-elsewhere' || restoreOutcome.status === 'contended') return c.json(restoreInProgress, 409);
          if (restoreOutcome.status === 'page-missing') {
            await completeOperation(crowi, restoreOperationId, { status: 'moot' });
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          if (restoreOutcome.status === 'incomplete') {
            const message = 'The page was moved but the restore did not finish. Ask an administrator to run the page-history repair.';
            return c.json({ error: { code: 'PAGE_TRANSITION_INCOMPLETE' as const, message } }, 400);
          }

          if (await hasOperationCompletionEvidence(crowi, restoreCreated.operation)) {
            await completeOperation(crowi, restoreOperationId, { status: 'succeeded' });
          }
          const populated = await Page.populatePageData(restoreOutcome.page, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error reverting deleted page:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_REVERT_FAILED', error.message || 'Failed to revert deleted page'), 400);
        }
      })
      // --------------------------------------------------------------
      // POST /pages/revert-to-revision — revertToRevision
      //
      // Restore the page's body to one of its PAST revisions by stacking
      // that body as a NEW revision on top of the current latest. This is
      // non-destructive: the whole history is preserved, and the revert is
      // always applied on top of the server-side latest (no optimistic-lock
      // 409 — if someone else updated the page since the caller opened the
      // old version, the revert lands on top of that newer revision rather
      // than conflicting). Page.updatePage handles prepareRevision →
      // pushRevision → pageEvent.emit('update', …, true), so notify / collab
      // fan-out comes for free.
      // --------------------------------------------------------------
      .openapi(revertToRevisionRoute, async (c) => {
        const user = c.get('user');
        const { page_id, revision_id } = c.req.valid('json');

        debug('revertToRevision called with:', { page_id, revision_id, userId: user._id });

        if (!isValidObjectId(revision_id)) {
          return c.json(pageBadRequestBody('PAGE_REVERT_TO_REVISION_FAILED', 'Invalid revision id'), 400);
        }

        try {
          // Grant + draft visibility checks (collapse to 404 — same leak-
          // guard as updatePage so a non-granted caller can't probe page
          // existence).
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          // The revision to revert TO. Must belong to this page. DC-5
          // (`feature-revision-page-ref`): checked via the revision's
          // immutable `page` id ref, NOT `path` equality — `path` is a
          // mutable, reused string, so comparing paths would let a caller
          // with edit access to page B "revert" it to the body of some
          // unrelated page A's revision, as long as A's path was ever
          // reused by B (e.g. A was hard-deleted and B later created at the
          // same path). An orphaned revision (no `page` ref — pre-migration
          // or a standard-lifecycle deviation) fails closed the same way.
          const oldRevision = await Revision.findRevision(new Types.ObjectId(revision_id));
          if (!oldRevision?.page || !oldRevision.page.equals(pageData._id)) {
            return c.json(pageBadRequestBody('PAGE_REVERT_TO_REVISION_FAILED', 'Revision does not belong to this page'), 400);
          }

          // Stack the old body as a new revision on top of the latest. The
          // base is pageData.revision (the server-side latest), set inside
          // prepareRevision — the client never supplies one. No `grant` option
          // is passed: updatePage defaults to `pageData.grant`, which keeps
          // the grant-update branch skipped (visibility is preserved).
          const updateOptions = { editVia: c.get('authContext').kind };
          const updated = (await Page.updatePage(pageData, oldRevision.body, user, updateOptions)) as PageDocument;
          const populated = await Page.populatePageData(updated, null);
          return c.json({ page: pageToResponse(populated) }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error reverting page to revision:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_REVERT_TO_REVISION_FAILED', error.message || 'Failed to revert page to revision'), 400);
        }
      })
      // --------------------------------------------------------------
      // POST /pages/rename — renamePage
      // --------------------------------------------------------------
      .openapi(renamePageRoute, async (c) => {
        const user = c.get('user');
        const { page_id, new_path, revision_id, create_redirect, include_descendants } = c.req.valid('json');

        debug('renamePage called with:', { page_id, new_path, revision_id, create_redirect, include_descendants, userId: user._id });

        const subtreeIdempotencyKey = include_descendants ? c.req.header('idempotency-key') : undefined;
        if (include_descendants && !subtreeIdempotencyKey) {
          return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' as const, message: 'This request requires an Idempotency-Key header.' } }, 400);
        }
        if (subtreeIdempotencyKey && !IDEMPOTENCY_KEY_PATTERN.test(subtreeIdempotencyKey)) {
          return c.json(pageBadRequestBody('PAGE_RENAME_FAILED', 'Idempotency-Key must be 16-128 URL-safe characters.'), 400);
        }

        // Normalise the destination path first so obviously-bad inputs
        // are rejected without touching the DB.
        const newPagePath = Page.normalizePath(new_path);
        const newPageIsPortal = newPagePath.endsWith('/');

        // Destination must be a creatable name and must not be a user
        // home page (`/user/<name>`) — that path is username-bound and
        // can't be hijacked by renaming another page onto it.
        if (!Page.isCreatableName(newPagePath) || !Page.isRenamableName(newPagePath)) {
          return c.json(pageBadRequestBody('PAGE_INVALID_NAME', `Cannot rename to this page name (${newPagePath})`), 400);
        }

        const subtreeFingerprint = include_descendants
          ? createHash('sha256')
              .update(JSON.stringify({ page_id: String(page_id), new_path: newPagePath, create_redirect: Boolean(create_redirect) }))
              .digest('hex')
          : undefined;
        if (include_descendants) {
          const rootResolution = await resolvePageHistoryOperation(
            crowi,
            { actor: user._id, command: 'subtree_rename', idempotencyKey: subtreeIdempotencyKey! },
            subtreeFingerprint!,
          );
          if (rootResolution.kind === 'fingerprint-mismatch') {
            return c.json(
              { error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' } },
              409,
            );
          }
          if (rootResolution.kind !== 'miss') {
            // Re-entry must bypass the granted-page helper because that helper
            // intentionally hides transitional pages. A root-only crash still
            // needs this raw document to create its first member; once the root
            // member exists, the command can resume even if the page vanished.
            const replayRootPage = (await Page.findById(page_id)) as PageDocument | null;
            const result = await executeSubtreeRename(crowi, Page, null, user, {
              page: replayRootPage,
              pageId: new Types.ObjectId(page_id),
              toPath: newPagePath,
              actor: user._id,
              user,
              source: toPageHistoryEventSource(c.get('authContext')?.kind),
              idempotencyKey: subtreeIdempotencyKey!,
              requestFingerprint: subtreeFingerprint!,
              createRedirectPage: Boolean(create_redirect),
            });
            if (!result.ok) {
              if (result.kind === 'fingerprint-mismatch') {
                return c.json(
                  { error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' } },
                  409,
                );
              }
              if (result.kind === 'validation') {
                return c.json(renameTreeFailedBody('Some pages cannot be moved to the destination path.', result.conflicts), 400);
              }
              debug('Error renaming subtree:', result.message);
              return c.json(
                renameTreeFailedBody(`Failed to move the whole subtree — some pages may already have been moved. (${result.message})`, [], true),
                400,
              );
            }
            const { outcome } = result;
            const movedRoot = outcome.successes.find((page) => page._id.equals(page_id)) ?? ((await Page.findById(page_id)) as PageDocument | null);
            if (!movedRoot) return c.json(PAGE_NOT_FOUND_BODY, 404);
            const populated = await Page.populatePageData(movedRoot, null);
            c.header('Idempotency-Replayed', 'true');
            return c.json({ page: pageToResponse(populated), renamed_count: outcome.successes.length }, 200);
          }
        }

        try {
          const pageData = (await Page.findPageByIdAndGrantedUser(page_id, user)) as PageDocument | null;
          if (!pageData) {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }

          // The user home page (`/user/<username>`) is bound to the username
          // and must not be renamed (mirrors `isDeletableName`). Checked on
          // the source path so it blocks both the single-page and
          // include_descendants forms.
          if (!Page.isRenamableName(pageData.path)) {
            return c.json(pageBadRequestBody('PAGE_INVALID_NAME', `This page cannot be renamed (${pageData.path})`), 400);
          }

          // Optimistic-lock on the root page's revision — same as the
          // single-page path. Sub-pages are not individually version-checked
          // (legacy renameTree parity).
          if (revision_id && !pageData.isUpdatable(revision_id)) {
            return c.json(pageRevisionConflictBody(), 409);
          }

          // ------------------------------------------------------------
          // Subtree move — root + grant-visible descendants.
          // ------------------------------------------------------------
          if (include_descendants) {
            const oldStripped = pageData.path.replace(/\/+$/, '');
            const descendantRoot = pageData.path.endsWith('/') ? pageData.path : `${pageData.path}/`;
            const selfPaths = new Set([pageData.path, oldStripped]);
            const subtree = (await Page.findListByStartWith(descendantRoot, user, { limit: 0 })) as PageDocument[];
            const descendants = subtree.filter((page) => !selfPaths.has(page.path));
            const newBase = newPagePath.replace(/\/+$/, '');
            const pathMap = Page.getPathMap([{ path: pageData.path }, ...descendants.map((page) => ({ path: page.path }))], pageData.path, newBase) as Record<
              string,
              string
            >;
            if (newPageIsPortal) pathMap[pageData.path] = newPagePath;

            const result = await executeSubtreeRename(crowi, Page, pathMap, user, {
              page: pageData,
              pageId: pageData._id,
              memberPages: [pageData, ...descendants],
              fromPath: pageData.path,
              toPath: newPagePath,
              actor: user._id,
              user,
              source: toPageHistoryEventSource(c.get('authContext')?.kind),
              idempotencyKey: subtreeIdempotencyKey!,
              requestFingerprint: subtreeFingerprint!,
              createRedirectPage: Boolean(create_redirect),
            });
            if (!result.ok) {
              if (result.kind === 'fingerprint-mismatch') {
                return c.json(
                  { error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' } },
                  409,
                );
              }
              if (result.kind === 'validation') {
                return c.json(renameTreeFailedBody('Some pages cannot be moved to the destination path.', result.conflicts), 400);
              }
              debug('Error renaming subtree:', result.message);
              return c.json(
                renameTreeFailedBody(`Failed to move the whole subtree — some pages may already have been moved. (${result.message})`, [], true),
                400,
              );
            }

            const { outcome } = result;
            const movedRoot = outcome.successes.find((page) => page._id.equals(pageData._id)) ?? ((await Page.findById(pageData._id)) as PageDocument | null);
            if (!movedRoot) return c.json(PAGE_NOT_FOUND_BODY, 404);
            const populated = await Page.populatePageData(movedRoot, null);
            if (outcome.replayed) c.header('Idempotency-Replayed', 'true');
            return c.json({ page: pageToResponse(populated), renamed_count: outcome.successes.length }, 200);
          }

          // ------------------------------------------------------------
          // Single-page rename (default / back-compat).
          // ------------------------------------------------------------
          // Honour `create_redirect` regardless of the destination's
          // portal-ness. Portalizing `/x` → `/x/` leaves a redirect at the
          // old content path so existing links / bookmarks to `/x` keep
          // resolving (to the new portal) — the same behaviour every other
          // rename already has (RenameDialog always requests a redirect). The
          // redirect stub has `redirectTo` set, so `findExistingTwin` (which
          // filters `redirectTo: null`) does not treat it as a `/x` ↔ `/x/`
          // twin, and it is hidden from listings (also `redirectTo: null`).
          // RFC-0021 Phase 2c-2a — the single-page rename runs as a recorded
          // operation from here on.
          const idempotencyKey = c.req.header('idempotency-key');
          if (!idempotencyKey) {
            return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' as const, message: 'This request requires an Idempotency-Key header.' } }, 400);
          }
          if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
            return c.json(pageBadRequestBody('PAGE_RENAME_FAILED', 'Idempotency-Key must be 16-128 URL-safe characters.'), 400);
          }

          const source = toPageHistoryEventSource(c.get('authContext')?.kind);
          const fingerprint = createHash('sha256')
            .update(JSON.stringify({ page_id: String(pageData._id), new_path: newPagePath, create_redirect: Boolean(create_redirect) }))
            .digest('hex');
          const operationKey = { actor: user._id, command: 'rename' as const, idempotencyKey };

          const replay = async (operation: { result?: { status: string; code?: string; message?: string } | null }) => {
            // A settled operation answers from the page as it is now — the
            // original response body is not stored, so there is nothing else
            // truthful to return.
            if (operation.result?.status === 'failed') {
              const code = operation.result.code ?? 'PAGE_TRANSITION_INCOMPLETE';
              return c.json({ error: { code, message: operation.result.message ?? 'The rename did not complete.' } } as never, 400);
            }
            const current = (await Page.findById(pageData._id)) as PageDocument | null;
            if (!current) return c.json(PAGE_NOT_FOUND_BODY, 404);
            if (isTransitionalPageStatus(current.status)) {
              return c.json({ error: { code: 'PAGE_TRANSITION_IN_PROGRESS' as const, message: 'This page is being moved by another operation.' } }, 409);
            }
            const populatedReplay = await Page.populatePageData(current, null);
            c.header('Idempotency-Replayed', 'true');
            return c.json({ page: pageToResponse(populatedReplay), renamed_count: 1 }, 200);
          };

          const resolution = await resolvePageHistoryOperation(crowi, operationKey, fingerprint);
          if (resolution.kind === 'fingerprint-mismatch') {
            return c.json(
              { error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' } },
              409,
            );
          }
          if (resolution.kind === 'settled') return replay(resolution.operation);
          if (resolution.kind === 'in-flight') {
            return c.json({ error: { code: 'PAGE_TRANSITION_IN_PROGRESS' as const, message: 'This page is being moved by another operation.' } }, 409);
          }

          // Only a first delivery validates the destination. A replay must not:
          // by then the page is already sitting at that destination, so the
          // collision check would see the page itself and answer PAGE_EXISTS to
          // a request that in fact succeeded. Core's flow resolves before it
          // validates for exactly this reason.
          //
          // §6 — block the `/x` ↔ `/x/` double-state: refuse to move onto a
          // path whose trailing-slash twin already exists as a real page. The
          // source page itself is excluded, so portalizing `/x` → `/x/` (where
          // the twin IS the page being moved) is allowed.
          const twinAtNewPath = await Page.findExistingTwin(newPagePath, { excludeId: pageData._id });
          if (twinAtNewPath) {
            return c.json(pageTwinExistsBody(twinAtNewPath.path), 400);
          }

          // Collision at the destination path — unlink an existing
          // redirect when the caller has permission, otherwise refuse.
          const existingAtNewPath = await Page.findOne({ path: newPagePath });
          if (existingAtNewPath) {
            if (existingAtNewPath.isUnlinkable(user)) {
              try {
                await existingAtNewPath.unlink(user);
              } catch (err) {
                const error = err as Error;
                return c.json(pageBadRequestBody('PAGE_RENAME_FAILED', error.message || 'Failed to unlink redirect page at destination'), 400);
              }
            } else {
              return c.json(pageBadRequestBody('PAGE_EXISTS', `Cannot rename to this page name (${newPagePath}). Page exists.`), 400);
            }
          }

          const operationId = randomUUID();
          const created = await createPageHistoryOperation(crowi, {
            ...operationKey,
            operationId,
            requestFingerprint: fingerprint,
            page: pageData._id,
            fromPath: pageData.path,
            toPath: newPagePath,
            fromStatus: pageData.status ?? null,
            fromStatusPresent: pageData.status != null,
            toStatus: pageData.status ?? null,
            createRedirect: Boolean(create_redirect),
            source,
          });
          if (created.kind === 'lost') {
            if (created.resolution.kind === 'fingerprint-mismatch') {
              return c.json(
                { error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' } },
                409,
              );
            }
            if (created.resolution.kind === 'settled') return replay(created.resolution.operation);
            return c.json({ error: { code: 'PAGE_TRANSITION_IN_PROGRESS' as const, message: 'This page is being moved by another operation.' } }, 409);
          }

          const outcome = await renamePageCommand(crowi, {
            page: pageData,
            fromPath: pageData.path,
            toPath: newPagePath,
            fromStatus: pageData.status ?? null,
            fromStatusPresent: pageData.status != null,
            operationId,
            actor: user._id,
            user,
            source,
            createRedirectPage: Boolean(create_redirect),
          });

          if (outcome.status === 'owned-elsewhere' || outcome.status === 'contended') {
            // The page is mid-move for someone else. Leave our record open: it
            // is still a request nobody answered, and repair can classify it.
            return c.json({ error: { code: 'PAGE_TRANSITION_IN_PROGRESS' as const, message: 'This page is being moved by another operation.' } }, 409);
          }
          if (outcome.status === 'page-missing') {
            await completeOperation(crowi, operationId, { status: 'moot' });
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          if (outcome.status === 'incomplete') {
            const message = 'The page was moved but the rename did not finish. Ask an administrator to run the page-history repair.';
            return c.json({ error: { code: 'PAGE_TRANSITION_INCOMPLETE' as const, message } }, 400);
          }

          if (await hasOperationCompletionEvidence(crowi, created.operation)) {
            await completeOperation(crowi, operationId, { status: 'succeeded' });
          }
          const populated = await Page.populatePageData(outcome.page, null);
          return c.json({ page: pageToResponse(populated), renamed_count: 1 }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error renaming page:', error.message);

          if (error.message === 'Page not found' || error.message === 'Page is not granted for the user') {
            return c.json(PAGE_NOT_FOUND_BODY, 404);
          }
          return c.json(pageBadRequestBody('PAGE_RENAME_FAILED', error.message || 'Failed to rename page'), 400);
        }
      })

      // --------------------------------------------------------------
      // POST /pages/rename-subtree — move a whole subtree by PATH.
      //
      // For a portal-less folder (a path like '/foo/bar/' that has
      // descendants but no page document of its own, so there is no
      // page_id / revision to key on). Always a subtree move: every
      // grant-visible page under `old_path` is rewritten under `new_path`.
      // --------------------------------------------------------------
      .openapi(renameSubtreeRoute, async (c) => {
        const user = c.get('user');
        const { old_path, new_path, create_redirect } = c.req.valid('json');

        debug('renameSubtree called with:', { old_path, new_path, create_redirect, userId: user._id });

        const idempotencyKey = c.req.header('idempotency-key');
        if (!idempotencyKey) {
          return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' as const, message: 'This request requires an Idempotency-Key header.' } }, 400);
        }
        if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
          return c.json(pageBadRequestBody('PAGE_RENAME_FAILED', 'Idempotency-Key must be 16-128 URL-safe characters.'), 400);
        }

        const newPagePath = Page.normalizePath(new_path);
        const oldBase = old_path.replace(/\/+$/, '');
        const newBase = newPagePath.replace(/\/+$/, '');

        // Refuse a destination that normalises to the root portal — every
        // descendant would be rewritten with an empty base.
        if (newBase === '' || !Page.isCreatableName(newBase)) {
          return c.json(pageBadRequestBody('PAGE_INVALID_NAME', `Cannot move the subtree to this path (${newPagePath})`), 400);
        }

        const requestFingerprint = createHash('sha256')
          .update(JSON.stringify({ old_path: oldBase, new_path: newBase, create_redirect: Boolean(create_redirect) }))
          .digest('hex');
        const rootResolution = await resolvePageHistoryOperation(crowi, { actor: user._id, command: 'subtree_rename', idempotencyKey }, requestFingerprint);
        if (rootResolution.kind === 'fingerprint-mismatch') {
          return c.json(
            { error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' } },
            409,
          );
        }
        if (rootResolution.kind !== 'miss') {
          const result = await executeSubtreeRename(crowi, Page, null, user, {
            page: null,
            pageId: null,
            fromPath: oldBase,
            toPath: newBase,
            actor: user._id,
            user,
            source: toPageHistoryEventSource(c.get('authContext')?.kind),
            idempotencyKey,
            requestFingerprint,
            createRedirectPage: Boolean(create_redirect),
          });
          if (!result.ok) {
            if (result.kind === 'fingerprint-mismatch') {
              return c.json(
                { error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' } },
                409,
              );
            }
            if (result.kind === 'validation') {
              return c.json(renameTreeFailedBody('Some pages cannot be moved to the destination path.', result.conflicts), 400);
            }
            debug('Error renaming subtree by path:', result.message);
            return c.json(
              renameTreeFailedBody(`Failed to move the whole subtree — some pages may already have been moved. (${result.message})`, [], true),
              400,
            );
          }
          c.header('Idempotency-Replayed', 'true');
          return c.json({ renamed_count: result.outcome.successes.length }, 200);
        }

        try {
          // Grant-filtered subtree under the folder. Drop the folder path
          // itself and its un-slashed twin (a separate page, not a child) —
          // mirrors the client preview (rename-dialog.tsx).
          const descendantRoot = old_path.endsWith('/') ? old_path : `${old_path}/`;
          const selfPaths = new Set([descendantRoot, oldBase]);
          const subtree = await Page.findListByStartWith(descendantRoot, user, { limit: 0 });
          const descendants = subtree.filter((p) => !selfPaths.has(p.path));

          if (descendants.length === 0) {
            return c.json(renameTreeFailedBody('There are no pages to move under this path.', []), 400);
          }

          // Folder rename moves every descendant. A subtree rooted at
          // `/user/` (or `/`) sweeps in every user's home page
          // (`/user/<name>`), which would bypass the single-page rename
          // guard. Refuse the whole move if any source is a home page.
          const protectedSource = descendants.find((p) => !Page.isRenamableName(p.path));
          if (protectedSource) {
            return c.json(
              renameTreeFailedBody(`This subtree contains a page that cannot be renamed (${protectedSource.path}).`, [
                { path: protectedSource.path, reasons: ['PAGE_INVALID_NAME'] },
              ]),
              400,
            );
          }

          const pathMap = Page.getPathMap(
            descendants.map((p) => ({ path: p.path })),
            oldBase,
            newBase,
          ) as Record<string, string>;
          const result = await executeSubtreeRename(crowi, Page, pathMap, user, {
            page: null,
            pageId: null,
            memberPages: descendants,
            fromPath: oldBase,
            toPath: newBase,
            actor: user._id,
            user,
            source: toPageHistoryEventSource(c.get('authContext')?.kind),
            idempotencyKey,
            requestFingerprint,
            createRedirectPage: Boolean(create_redirect),
          });
          if (!result.ok) {
            if (result.kind === 'fingerprint-mismatch') {
              return c.json(
                { error: { code: 'IDEMPOTENCY_KEY_CONFLICT' as const, message: 'This Idempotency-Key was already used for a different request.' } },
                409,
              );
            }
            if (result.kind === 'validation') {
              return c.json(renameTreeFailedBody('Some pages cannot be moved to the destination path.', result.conflicts), 400);
            }
            debug('Error renaming subtree by path:', result.message);
            return c.json(
              renameTreeFailedBody(`Failed to move the whole subtree — some pages may already have been moved. (${result.message})`, [], true),
              400,
            );
          }

          if (result.outcome.replayed) c.header('Idempotency-Replayed', 'true');
          return c.json({ renamed_count: result.outcome.successes.length }, 200);
        } catch (err) {
          const error = err as Error;
          debug('Error renaming subtree by path:', error.message);
          return c.json(renameTreeFailedBody(error.message || 'Failed to move the subtree.', []), 400);
        }
      })
  );
};
