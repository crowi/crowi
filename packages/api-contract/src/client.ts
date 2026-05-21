/// <reference lib="dom" />
/**
 * RFC-0006 — typed Hono client factory.
 *
 * Wraps the runtime `hc<AppType>(baseUrl)` call from `hono/client` with
 * the request-init plumbing the web app needs (auth header / pluggable
 * fetch). Exports an `AppType` that describes the Hono route surface
 * declared by every `createRoute(...)` in `@crowi/api-contract/contracts`.
 *
 * **AppType placement decision (Phase 3 build-order smoke test, see
 * `docs/migrations/0006-hono-context.md` §11 & §14)**:
 *
 * - **Option 1** (`@crowi/api-contract` imports `AppType` from
 *   `@crowi/api/hono`) **failed** the smoke test — `pnpm --filter
 *   @crowi/api-contract build` runs before `@crowi/api`'s `dist/` is
 *   emitted (workspace dep graph: `@crowi/api -> @crowi/api-contract`,
 *   not the reverse), so the dts compile cannot resolve
 *   `@crowi/api/hono`.
 *
 * - **Option 2 adopted**: `@crowi/api-contract` is the single source of
 *   truth for `AppType`. It builds a no-op Hono chain that mirrors the
 *   real route surface (every `createRoute(...)` exported by the
 *   contracts) and exports `AppType = typeof contractApp`. The real
 *   `@crowi/api` handler chain produces the same shape because both
 *   sides consume the same `createRoute` definitions, so the
 *   `hc<AppType>` client is type-safe against the real server.
 *
 * If the route-definition <-> handler-implementation match ever drifts
 * (e.g. a contract is registered here but never wired in `@crowi/api`),
 * runtime requests will 404 — covered by integration tests in
 * `packages/api/src/hono/handlers/*.test.ts`.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { hc } from 'hono/client';
import type { z } from 'zod';

import { appRoutes } from './contracts/app';
import { backlinkRoutes } from './contracts/backlink';
import { bookmarkRoutes } from './contracts/bookmark';
import { commentRoutes } from './contracts/comment';
import { installerRoutes } from './contracts/installer';
import { meRoutes } from './contracts/me';
import { notificationRoutes } from './contracts/notification';
import { pageRoutes } from './contracts/page';
import { pagePreviewRoutes } from './contracts/page-preview';
import { revisionRoutes } from './contracts/revision';
import { tokenAuthRoutes } from './contracts/tokenAuth';
import { userRoutes } from './contracts/user';
import type { AppInfoResponseSchema } from './schemas/app';
import type { GetBacklinksResponseSchema } from './schemas/backlink';
import type { BookmarkResponseSchema, ListMyBookmarksResponseSchema, RemoveBookmarkResponseSchema } from './schemas/bookmark';
import type { AddCommentResponseSchema, DeleteCommentResponseSchema, ListCommentsResponseSchema } from './schemas/comment';
import type { CreateAdminResponseSchema, InstallerStatusResponseSchema } from './schemas/installer';
import type {
  ApiTokenResponseSchema,
  PasswordUpdateSuccessSchema,
  PictureUploadResponseSchema,
  RecentlyViewedPagesResponseSchema,
  SuccessResponseSchema,
  UserProfileResponseSchema,
} from './schemas/me';
import type {
  ListNotificationsResponseSchema,
  MarkAllAsReadResponseSchema,
  NotificationStatusResponseSchema,
  OpenNotificationResponseSchema,
} from './schemas/notification';
import type { GetPageResponseSchema, ListPagesResponseSchema, PageSchema, SeenUsersResponseSchema, WatchStatusResponseSchema } from './schemas/page';
import type { PreviewPageResponseSchema } from './schemas/page-preview';
import type { GetRevisionResponseSchema, GetRevisionsResponseSchema, ListRevisionsResponseSchema } from './schemas/revision';
import type { TokenAuthResponseSchema } from './schemas/auth';
import type { UserBookmarksResponseSchema, UserPageResponseSchema, UserPagesResponseSchema } from './schemas/user';

type AppInfoResponse = z.infer<typeof AppInfoResponseSchema>;
type InstallerStatusResponse = z.infer<typeof InstallerStatusResponseSchema>;
type CreateAdminResponse = z.infer<typeof CreateAdminResponseSchema>;
type TokenAuthResponse = z.infer<typeof TokenAuthResponseSchema>;
type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;
type PictureUploadResponse = z.infer<typeof PictureUploadResponseSchema>;
type SuccessResponse = z.infer<typeof SuccessResponseSchema>;
type PasswordUpdateSuccess = z.infer<typeof PasswordUpdateSuccessSchema>;
type ApiTokenResponse = z.infer<typeof ApiTokenResponseSchema>;
type RecentlyViewedPagesResponse = z.infer<typeof RecentlyViewedPagesResponseSchema>;
type UserPageResponse = z.infer<typeof UserPageResponseSchema>;
type UserBookmarksResponse = z.infer<typeof UserBookmarksResponseSchema>;
type UserPagesResponse = z.infer<typeof UserPagesResponseSchema>;
type BookmarkResponse = z.infer<typeof BookmarkResponseSchema>;
type ListMyBookmarksResponse = z.infer<typeof ListMyBookmarksResponseSchema>;
type RemoveBookmarkResponse = z.infer<typeof RemoveBookmarkResponseSchema>;
type GetBacklinksResponse = z.infer<typeof GetBacklinksResponseSchema>;
type ListCommentsResponse = z.infer<typeof ListCommentsResponseSchema>;
type AddCommentResponse = z.infer<typeof AddCommentResponseSchema>;
type DeleteCommentResponse = z.infer<typeof DeleteCommentResponseSchema>;
type ListRevisionsResponse = z.infer<typeof ListRevisionsResponseSchema>;
type GetRevisionResponse = z.infer<typeof GetRevisionResponseSchema>;
type GetRevisionsResponse = z.infer<typeof GetRevisionsResponseSchema>;
type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;
type MarkAllAsReadResponse = z.infer<typeof MarkAllAsReadResponseSchema>;
type NotificationStatusResponse = z.infer<typeof NotificationStatusResponseSchema>;
type OpenNotificationResponse = z.infer<typeof OpenNotificationResponseSchema>;
type Page = z.infer<typeof PageSchema>;
type GetPageResponse = z.infer<typeof GetPageResponseSchema>;
type ListPagesResponse = z.infer<typeof ListPagesResponseSchema>;
type SeenUsersResponse = z.infer<typeof SeenUsersResponseSchema>;
type WatchStatusResponse = z.infer<typeof WatchStatusResponseSchema>;
type PreviewPageResponse = z.infer<typeof PreviewPageResponseSchema>;

/**
 * Spec-only Hono chain mirroring the route surface every consumer must
 * be able to talk to. The handlers below never execute at runtime —
 * `@crowi/api` registers the real handlers — so they return schema-
 * conforming stub bodies purely to thread the response type through
 * `OpenAPIHono`'s per-route type accumulator. Phase 4 commits extend
 * this chain one resource at a time so `AppType` stays in lock-step
 * with the real `@crowi/api` chain.
 *
 * Stub bodies use the success status only (200 / 201); the error arms
 * are part of the route's `responses` map and `hc`'s type inference
 * picks them up automatically.
 */
const stubUser = {
  id: '',
  username: '',
  email: '',
  name: '',
  admin: false,
} as const;

const stubTokens: TokenAuthResponse = {
  accessToken: '',
  refreshToken: '',
  expiresIn: 0,
  user: stubUser,
};

const stubProfile: UserProfileResponse = {
  id: '',
  username: '',
  name: '',
  email: 'stub@example.com',
  lang: 'en',
  image: null,
  hasPassword: false,
  createdAt: '',
};

const stubUserPublic = {
  _id: '',
  id: '',
  username: '',
  name: '',
  email: 'stub@example.com',
  image: null,
  introduction: '',
  createdAt: '',
  admin: false,
} as const;

const stubUserPage: UserPageResponse = {
  user: stubUserPublic,
  createdPagesCount: 0,
  bookmarksCount: 0,
};

const stubPager = { prev: null, next: null, offset: 0 } as const;

const stubUserBookmarks: UserBookmarksResponse = {
  bookmarks: [],
  pager: stubPager,
  total: 0,
};

const stubUserPages: UserPagesResponse = {
  pages: [],
  pager: stubPager,
  total: 0,
};

const stubBookmarkResponse: BookmarkResponse = { bookmark: null };
const stubListMyBookmarks: ListMyBookmarksResponse = { bookmarks: [], pager: stubPager, total: 0 };
const stubRemoveBookmark: RemoveBookmarkResponse = { ok: true };
const stubBacklinks: GetBacklinksResponse = { backlinks: [], hasNext: false };
const stubListComments: ListCommentsResponse = { comments: [] };
const stubComment = {
  _id: '',
  page: '',
  creator: null,
  revision: '',
  comment: '',
  commentPosition: -1,
  createdAt: '',
};
const stubAddComment: AddCommentResponse = { comment: stubComment };
const stubDeleteComment: DeleteCommentResponse = { ok: true };
const stubListRevisions: ListRevisionsResponse = { revisions: [], pager: stubPager };
const stubRevision = {
  _id: '',
  path: '',
  body: '',
  format: 'markdown',
  author: null,
  createdAt: '',
};
const stubGetRevision: GetRevisionResponse = { revision: stubRevision };
const stubGetRevisions: GetRevisionsResponse = { revisions: [] };
const stubListNotifications: ListNotificationsResponse = { notifications: [], pager: stubPager };
const stubMarkAllAsRead: MarkAllAsReadResponse = { ok: true };
const stubNotificationStatus: NotificationStatusResponse = { count: 0 };
const stubOpenNotification: OpenNotificationResponse = {
  notification: {
    _id: '',
    user: '',
    targetModel: 'Page',
    target: { _id: '', path: '', status: null },
    action: 'COMMENT',
    status: 'OPENED',
    actionUsers: [],
    createdAt: '',
  },
};

// Page stub — every optional field omitted so the schema's defaults
// kick in (commentCount default 0, etc.).
const stubPage: Page = {
  _id: '',
  path: '',
  commentCount: 0,
  createdAt: '',
};

const stubPageWithRevision: GetPageResponse = {
  page: {
    _id: '',
    path: '',
    revision: {
      _id: '',
      path: '',
      body: '',
      format: 'markdown',
      createdAt: '',
    },
    commentCount: 0,
    createdAt: '',
  },
};

const stubPageResponse = { page: stubPage };
const stubListPages: ListPagesResponse = { pages: [], pager: stubPager, portalPage: null };
const stubSeenUsers: SeenUsersResponse = { seenUsers: [], seenUsersCount: 0 };
const stubWatchStatus: WatchStatusResponse = { watching: false };
const stubPreview: PreviewPageResponse = { renderedAst: null };

const contractApp = new OpenAPIHono()
  .openapi(appRoutes.getAppInfoRoute, (c) => c.json({ title: null } satisfies AppInfoResponse, 200))
  .openapi(installerRoutes.getInstallerStatusRoute, (c) => c.json({ status: 'installer_required' } satisfies InstallerStatusResponse, 200))
  .openapi(installerRoutes.createAdminRoute, (c) => c.json({ status: 'ok' } satisfies CreateAdminResponse, 200))
  .openapi(tokenAuthRoutes.tokenLoginRoute, (c) => c.json(stubTokens, 200))
  .openapi(tokenAuthRoutes.tokenRegisterRoute, (c) => c.json(stubTokens, 201))
  .openapi(tokenAuthRoutes.tokenRefreshRoute, (c) => c.json(stubTokens, 200))
  .openapi(tokenAuthRoutes.tokenLogoutRoute, (c) => c.json({ message: '' }, 200))
  .openapi(tokenAuthRoutes.tokenMeRoute, (c) =>
    c.json(
      {
        user: {
          id: '',
          username: '',
          email: 'stub@example.com',
          name: '',
          status: 0,
          admin: false,
          createdAt: '',
        },
      },
      200,
    ),
  )
  .openapi(meRoutes.getProfileRoute, (c) => c.json(stubProfile, 200))
  .openapi(meRoutes.updateProfileRoute, (c) => c.json(stubProfile, 200))
  .openapi(meRoutes.uploadPictureRoute, (c) => c.json({ status: true } satisfies PictureUploadResponse, 200))
  .openapi(meRoutes.deletePictureRoute, (c) => c.json({ status: 'ok' } satisfies SuccessResponse, 200))
  .openapi(meRoutes.updatePasswordRoute, (c) => c.json({ status: 'ok', message: '' } satisfies PasswordUpdateSuccess, 200))
  .openapi(meRoutes.getApiTokenRoute, (c) => c.json({ status: 'ok', apiToken: '' } satisfies ApiTokenResponse, 200))
  .openapi(meRoutes.resetApiTokenRoute, (c) => c.json({ status: 'ok', apiToken: '' } satisfies ApiTokenResponse, 200))
  .openapi(meRoutes.recentlyViewedPagesRoute, (c) => c.json({ pages: [] } satisfies RecentlyViewedPagesResponse, 200))
  .openapi(userRoutes.getUserPageRoute, (c) => c.json(stubUserPage, 200))
  .openapi(userRoutes.getUserBookmarksRoute, (c) => c.json(stubUserBookmarks, 200))
  .openapi(userRoutes.getUserPagesRoute, (c) => c.json(stubUserPages, 200))
  .openapi(bookmarkRoutes.getBookmarkRoute, (c) => c.json(stubBookmarkResponse, 200))
  .openapi(bookmarkRoutes.listMyBookmarksRoute, (c) => c.json(stubListMyBookmarks, 200))
  .openapi(bookmarkRoutes.addBookmarkRoute, (c) => c.json(stubBookmarkResponse, 200))
  .openapi(bookmarkRoutes.removeBookmarkRoute, (c) => c.json(stubRemoveBookmark, 200))
  .openapi(backlinkRoutes.getBacklinksRoute, (c) => c.json(stubBacklinks, 200))
  .openapi(commentRoutes.listCommentsRoute, (c) => c.json(stubListComments, 200))
  .openapi(commentRoutes.addCommentRoute, (c) => c.json(stubAddComment, 200))
  .openapi(commentRoutes.deleteCommentRoute, (c) => c.json(stubDeleteComment, 200))
  .openapi(revisionRoutes.listRevisionsRoute, (c) => c.json(stubListRevisions, 200))
  // `/pages/revisions` (list-by-ids) registers before `/pages/revisions/{id}`
  // to match the runtime chain — see the contract file header for why
  // ordering matters.
  .openapi(revisionRoutes.getRevisionsRoute, (c) => c.json(stubGetRevisions, 200))
  .openapi(revisionRoutes.getRevisionRoute, (c) => c.json(stubGetRevision, 200))
  // page resource — 14 endpoints. Registers AFTER revision so the
  // shared `/pages/*` `createJwtAuth` apply in revision is reused
  // by the page handler (Hono does not dedupe middleware references).
  // Inside this block, literal sub-paths (`/pages/list`, `/pages/grant`,
  // `/pages/seen`, `/pages/seen-users`, `/pages/like`, `/pages/unlike`,
  // `/pages/watch`, `/pages/revert`, `/pages/rename`) come before the
  // bare `/pages` CRUD endpoints — same first-match-wins ordering used
  // by the revision / notification chains above.
  .openapi(pageRoutes.getPageRoute, (c) => c.json(stubPageWithRevision, 200))
  .openapi(pageRoutes.listPagesRoute, (c) => c.json(stubListPages, 200))
  .openapi(pageRoutes.createPageRoute, (c) => c.json(stubPageResponse, 200))
  .openapi(pageRoutes.updatePageRoute, (c) => c.json(stubPageResponse, 200))
  .openapi(pageRoutes.setPageGrantRoute, (c) => c.json(stubPageResponse, 200))
  .openapi(pageRoutes.seenPageRoute, (c) => c.json(stubSeenUsers, 200))
  .openapi(pageRoutes.getSeenUsersRoute, (c) => c.json(stubSeenUsers, 200))
  .openapi(pageRoutes.likePageRoute, (c) => c.json(stubPageResponse, 200))
  .openapi(pageRoutes.unlikePageRoute, (c) => c.json(stubPageResponse, 200))
  .openapi(pageRoutes.getWatchStatusRoute, (c) => c.json(stubWatchStatus, 200))
  .openapi(pageRoutes.setWatchStatusRoute, (c) => c.json(stubWatchStatus, 200))
  .openapi(pageRoutes.deletePageRoute, (c) => c.json(stubPageResponse, 200))
  .openapi(pageRoutes.revertDeletedPageRoute, (c) => c.json(stubPageResponse, 200))
  .openapi(pageRoutes.renamePageRoute, (c) => c.json(stubPageResponse, 200))
  // page-preview — single endpoint, `/pages/preview` (literal under
  // `/pages/*`). Method is POST so it does not collide with GET /pages
  // (getPage) or POST /pages (createPage) — Hono dispatches by
  // method+path so this is purely organisational.
  .openapi(pagePreviewRoutes.previewPageRoute, (c) => c.json(stubPreview, 200))
  .openapi(notificationRoutes.listNotificationsRoute, (c) => c.json(stubListNotifications, 200))
  .openapi(notificationRoutes.markAllAsReadRoute, (c) => c.json(stubMarkAllAsRead, 200))
  // `/notifications/status` registers before `/notifications/{id}/open`
  // for the same literal-vs-template reason as the revision chain.
  .openapi(notificationRoutes.getUnreadCountRoute, (c) => c.json(stubNotificationStatus, 200))
  .openapi(notificationRoutes.openNotificationRoute, (c) => c.json(stubOpenNotification, 200));

export type AppType = typeof contractApp;

/**
 * Default request init applied to every call unless the caller overrides
 * it. The `headers` shape matches Hono's `hc` (a plain record / async
 * supplier of one); `fetch` matches the fetch spec exactly.
 */
export interface ClientOptions {
  /** Extra default headers (e.g. `Authorization: Bearer ...`). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /**
   * Pluggable fetch implementation (used by the web app to inject the
   * refresh-token loop). Defaults to the global `fetch`.
   */
  fetch?: typeof fetch;
}

/**
 * Build a typed Hono client against the contract `AppType`.
 *
 * `baseUrl` should already include the `/api/v2` prefix because the
 * Hono `OpenAPIHono` chain is mounted there (see
 * `packages/api/src/routes/index.ts`).
 */
export const createClient = (baseUrl: string, options: ClientOptions = {}) =>
  hc<AppType>(baseUrl, {
    headers: options.headers,
    fetch: options.fetch,
  });

export type CrowiApiClient = ReturnType<typeof createClient>;
