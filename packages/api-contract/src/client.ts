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
 *   contracts) and exports `AppType` as an intersection of every
 *   sub-chain's `typeof`. The real `@crowi/api` handler chain produces
 *   the same shape because both sides consume the same `createRoute`
 *   definitions, so the `hc<AppType>` client is type-safe against the
 *   real server.
 *
 * If the route-definition <-> handler-implementation match ever drifts
 * (e.g. a contract is registered here but never wired in `@crowi/api`),
 * runtime requests will 404 — covered by integration tests in
 * `packages/api/src/hono/handlers/*.test.ts`.
 *
 * **Phase 6 — TS2589 escape hatch removal**:
 *
 * Phase 4 Batch 9 hit TypeScript error 2589 ("type instantiation
 * excessively deep") when the contract chain reached 90+ chained
 * `.openapi(...)` calls; the previous workaround flattened the four
 * sub-chains into one via `.route('/', sub)` calls and surfaced
 * `AppType = typeof contractApp`, which still tripped 2589 in
 * downstream `hc<AppType>` consumers. That commit reached
 * for `@ts-expect-error` on the `hc<AppType>(baseUrl)` call and
 * exported `CrowiApiClient = any`, which forced four frontend hooks to
 * cast `response.json() as <Schema>`.
 *
 * The fix in this file:
 *
 * 1. The route surface is partitioned into six independent
 *    `OpenAPIHono` chains, each holding ≤ ~22 `.openapi(...)` calls so
 *    no single chain exceeds TS's instantiation-depth ceiling on its
 *    own.
 * 2. `AppType` is declared as the **intersection** of every chain's
 *    `typeof`. `hc<T>` from `hono/client` constrains `T` to `Hono<any,
 *    any, any>`, which an intersection of multiple `OpenAPIHono`
 *    chains satisfies (each summand is a Hono), and the inferred
 *    `Client<T, Prefix>` propagates each chain's routes through
 *    `UnionToIntersection<Client<...>>` in the upstream hc declaration.
 * 3. The chains are **not** merged via `.route('/', sub)`; that call
 *    is what caused the type to flatten and explode in the previous
 *    layout. Merging is only useful when the runtime needs a single
 *    `app.fetch` entry-point, which is not the case here (the runtime
 *    is `@crowi/api`'s real handler chain — these stubs never execute).
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { hc } from 'hono/client';
import type { z } from 'zod';

import { adminAppRoutes } from './contracts/admin/app';
import { adminAuthRoutes } from './contracts/admin/auth';
import { adminMailRoutes } from './contracts/admin/mail';
import { adminPluginsRoutes } from './contracts/admin/plugins';
import { adminSearchRoutes } from './contracts/admin/search';
import { adminSecurityRoutes } from './contracts/admin/security';
import { adminStorageRoutes } from './contracts/admin/storage';
import { adminUsersRoutes } from './contracts/admin/users';
import { appRoutes } from './contracts/app';
import { attachmentRoutes } from './contracts/attachment';
import { autocompleteRoutes } from './contracts/autocomplete';
import { backlinkRoutes } from './contracts/backlink';
import { bookmarkRoutes } from './contracts/bookmark';
import { commentRoutes } from './contracts/comment';
import { draftRoutes } from './contracts/draft';
import { installerRoutes } from './contracts/installer';
import { meRoutes } from './contracts/me';
import { accessTokenRoutes } from './contracts/access-token';
import { oauthRoutes } from './contracts/oauth';
import { notificationRoutes } from './contracts/notification';
import { pageCollabRoutes } from './contracts/page-collab';
import { pageRoutes } from './contracts/page';
import { pagePreviewRoutes } from './contracts/page-preview';
import { presenceRoutes } from './contracts/presence';
import { revisionRoutes } from './contracts/revision';
import { adminCryptoRoutes } from './contracts/adminCrypto';
import { searchRoutes } from './contracts/search';
import { tokenAuthRoutes } from './contracts/tokenAuth';
import { inviteAcceptRoutes } from './contracts/inviteAccept';
import { passwordResetRoutes } from './contracts/passwordReset';
import { activationRoutes } from './contracts/activation';
import { emailChangeRoutes } from './contracts/emailChange';
import { userRoutes } from './contracts/user';
import type { AppInfoResponseSchema } from './schemas/app';
import type { GetBacklinksResponseSchema } from './schemas/backlink';
import type { BookmarkResponseSchema, ListMyBookmarksResponseSchema, RemoveBookmarkResponseSchema } from './schemas/bookmark';
import type { AddCommentResponseSchema, DeleteCommentResponseSchema, ListCommentsResponseSchema } from './schemas/comment';
import type { CreateAdminResponseSchema, InstallerStatusResponseSchema } from './schemas/installer';
import type {
  PasswordUpdateSuccessSchema,
  PictureUploadResponseSchema,
  RecentlyViewedPagesResponseSchema,
  SuccessResponseSchema,
  UserProfileResponseSchema,
} from './schemas/me';
import type { AccessTokenSchema, CreateAccessTokenResponseSchema, ListAccessTokensResponseSchema } from './schemas/access-token';
import type {
  AuthorizeResponseSchema,
  DeviceAuthorizeResponseSchema,
  DeviceInfoResponseSchema,
  DeviceVerifyResponseSchema,
  DiscoveryResponseSchema,
  RevokeResponseSchema,
  TokenResponseSchema,
} from './schemas/oauth-endpoints';
import type {
  ListNotificationsResponseSchema,
  MarkAllAsReadResponseSchema,
  NotificationStatusResponseSchema,
  NotificationsTokenResponseSchema,
  OpenNotificationResponseSchema,
} from './schemas/notification';
import type { WsTokenResponseSchema } from './schemas/collab';
import type {
  GetPageResponseSchema,
  ListPageChildrenResponseSchema,
  ListPagesResponseSchema,
  PageSchema,
  SeenUsersResponseSchema,
  WatchStatusResponseSchema,
} from './schemas/page';
import type { PreviewPageResponseSchema } from './schemas/page-preview';
import type { LikersResponseSchema, PresenceTokenResponseSchema } from './schemas/presence';
import type { GetRevisionResponseSchema, GetRevisionsResponseSchema, ListRevisionsResponseSchema } from './schemas/revision';
import type { SearchPagesResponseSchema } from './schemas/search';
import type { CryptoStatusResponseSchema, ReencryptResponseSchema } from './schemas/adminCrypto';
import type { TokenAuthResponseSchema } from './schemas/auth';
import type { ListUsersResponseSchema, UserBookmarksResponseSchema, UserPageResponseSchema, UserPagesResponseSchema } from './schemas/user';
import type { CreateDraftResponseSchema, ListDraftsResponseSchema } from './schemas/draft';
import type { AutocompleteResponseSchema } from './schemas/autocomplete';
import type {
  AddAttachmentResponseSchema,
  AttachmentMetaSchema,
  AttachmentUsageResponseSchema,
  ListAttachmentsResponseSchema,
  RemoveAttachmentResponseSchema,
  UploadAttachmentResponseSchema,
} from './schemas/attachment';
import type { GetAppSettingsResponseSchema, UpdateAppSettingsResponseSchema } from './schemas/admin/app';
import type { GetAuthSettingsResponseSchema, UpdateAuthSettingsResponseSchema } from './schemas/admin/auth';
import type { GetMailSettingsResponseSchema, SendTestMailResponseSchema, UpdateMailSettingsResponseSchema } from './schemas/admin/mail';
import type {
  ClearRenderCacheResponseSchema,
  ListPluginsResponseSchema,
  PluginConfigResponseSchema,
  UpdatePluginConfigResponseSchema,
} from './schemas/admin/plugins';
import type { GetSearchStatusResponseSchema } from './schemas/admin/search';
import type { GetSecuritySettingsResponseSchema, UpdateSecuritySettingsResponseSchema } from './schemas/admin/security';
import type { GetStorageStatusResponseSchema } from './schemas/admin/storage';
import type {
  AdminUserMutationResponseSchema,
  DeleteAdminUserResponseSchema,
  InviteUsersResponseSchema,
  ListAdminUsersResponseSchema,
  PendingUsersCountResponseSchema,
  ResetPasswordResponseSchema,
  SearchAdminUsersByEmailResponseSchema,
} from './schemas/admin/users';

type AppInfoResponse = z.infer<typeof AppInfoResponseSchema>;
type InstallerStatusResponse = z.infer<typeof InstallerStatusResponseSchema>;
type CreateAdminResponse = z.infer<typeof CreateAdminResponseSchema>;
type TokenAuthResponse = z.infer<typeof TokenAuthResponseSchema>;
type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;
type PictureUploadResponse = z.infer<typeof PictureUploadResponseSchema>;
type SuccessResponse = z.infer<typeof SuccessResponseSchema>;
type PasswordUpdateSuccess = z.infer<typeof PasswordUpdateSuccessSchema>;
type AccessToken = z.infer<typeof AccessTokenSchema>;
type ListAccessTokensResponse = z.infer<typeof ListAccessTokensResponseSchema>;
type CreateAccessTokenResponse = z.infer<typeof CreateAccessTokenResponseSchema>;
type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;
type TokenResponse = z.infer<typeof TokenResponseSchema>;
type RevokeResponse = z.infer<typeof RevokeResponseSchema>;
type DiscoveryResponse = z.infer<typeof DiscoveryResponseSchema>;
type DeviceAuthorizeResponse = z.infer<typeof DeviceAuthorizeResponseSchema>;
type DeviceInfoResponse = z.infer<typeof DeviceInfoResponseSchema>;
type DeviceVerifyResponse = z.infer<typeof DeviceVerifyResponseSchema>;
type RecentlyViewedPagesResponse = z.infer<typeof RecentlyViewedPagesResponseSchema>;
type UserPageResponse = z.infer<typeof UserPageResponseSchema>;
type UserBookmarksResponse = z.infer<typeof UserBookmarksResponseSchema>;
type UserPagesResponse = z.infer<typeof UserPagesResponseSchema>;
type ListUsersResponse = z.infer<typeof ListUsersResponseSchema>;
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
type SearchPagesResponse = z.infer<typeof SearchPagesResponseSchema>;
type CryptoStatusResponse = z.infer<typeof CryptoStatusResponseSchema>;
type ReencryptResponse = z.infer<typeof ReencryptResponseSchema>;
type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;
type MarkAllAsReadResponse = z.infer<typeof MarkAllAsReadResponseSchema>;
type NotificationStatusResponse = z.infer<typeof NotificationStatusResponseSchema>;
type NotificationsTokenResponse = z.infer<typeof NotificationsTokenResponseSchema>;
type OpenNotificationResponse = z.infer<typeof OpenNotificationResponseSchema>;
type Page = z.infer<typeof PageSchema>;
type GetPageResponse = z.infer<typeof GetPageResponseSchema>;
type ListPagesResponse = z.infer<typeof ListPagesResponseSchema>;
type ListPageChildrenResponse = z.infer<typeof ListPageChildrenResponseSchema>;
type SeenUsersResponse = z.infer<typeof SeenUsersResponseSchema>;
type WatchStatusResponse = z.infer<typeof WatchStatusResponseSchema>;
type PreviewPageResponse = z.infer<typeof PreviewPageResponseSchema>;
type WsTokenResponse = z.infer<typeof WsTokenResponseSchema>;
type PresenceTokenResponse = z.infer<typeof PresenceTokenResponseSchema>;
type LikersResponse = z.infer<typeof LikersResponseSchema>;
type CreateDraftResponse = z.infer<typeof CreateDraftResponseSchema>;
type ListDraftsResponse = z.infer<typeof ListDraftsResponseSchema>;
type AutocompleteResponse = z.infer<typeof AutocompleteResponseSchema>;
type ListAttachmentsResponse = z.infer<typeof ListAttachmentsResponseSchema>;
type AddAttachmentResponse = z.infer<typeof AddAttachmentResponseSchema>;
type AttachmentUsageResponse = z.infer<typeof AttachmentUsageResponseSchema>;
type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;
type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponseSchema>;
type RemoveAttachmentResponse = z.infer<typeof RemoveAttachmentResponseSchema>;
// admin sub-contract response types
type GetAppSettingsResponse = z.infer<typeof GetAppSettingsResponseSchema>;
type UpdateAppSettingsResponse = z.infer<typeof UpdateAppSettingsResponseSchema>;
type GetAuthSettingsResponse = z.infer<typeof GetAuthSettingsResponseSchema>;
type UpdateAuthSettingsResponse = z.infer<typeof UpdateAuthSettingsResponseSchema>;
type GetSecuritySettingsResponse = z.infer<typeof GetSecuritySettingsResponseSchema>;
type UpdateSecuritySettingsResponse = z.infer<typeof UpdateSecuritySettingsResponseSchema>;
type GetMailSettingsResponse = z.infer<typeof GetMailSettingsResponseSchema>;
type UpdateMailSettingsResponse = z.infer<typeof UpdateMailSettingsResponseSchema>;
type SendTestMailResponse = z.infer<typeof SendTestMailResponseSchema>;
type GetStorageStatusResponse = z.infer<typeof GetStorageStatusResponseSchema>;
type GetSearchStatusResponse = z.infer<typeof GetSearchStatusResponseSchema>;
type ListAdminUsersResponse = z.infer<typeof ListAdminUsersResponseSchema>;
type SearchAdminUsersByEmailResponse = z.infer<typeof SearchAdminUsersByEmailResponseSchema>;
type InviteUsersResponse = z.infer<typeof InviteUsersResponseSchema>;
type AdminUserMutationResponse = z.infer<typeof AdminUserMutationResponseSchema>;
type ResetPasswordResponse = z.infer<typeof ResetPasswordResponseSchema>;
type DeleteAdminUserResponse = z.infer<typeof DeleteAdminUserResponseSchema>;
type PendingUsersCountResponse = z.infer<typeof PendingUsersCountResponseSchema>;
type ListPluginsResponse = z.infer<typeof ListPluginsResponseSchema>;
type PluginConfigResponse = z.infer<typeof PluginConfigResponseSchema>;
type UpdatePluginConfigResponse = z.infer<typeof UpdatePluginConfigResponseSchema>;
type ClearRenderCacheResponse = z.infer<typeof ClearRenderCacheResponseSchema>;

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
  theme: 'system',
  image: null,
  hasPassword: false,
  createdAt: '',
};

const stubAccessToken: AccessToken = {
  id: '',
  name: '',
  scopes: [],
  expiresAt: null,
  lastUsedAt: null,
  createdAt: '',
};

const stubCreateAccessToken: CreateAccessTokenResponse = { ...stubAccessToken, token: '' };

// OAuth endpoint stubs (RFC-0010 Phase 3).
const stubAuthorize: AuthorizeResponse = { redirectUri: '' };
const stubToken: TokenResponse = {
  access_token: '',
  token_type: 'Bearer',
  expires_in: 0,
  refresh_token: '',
  scope: '',
};
const stubRevoke: RevokeResponse = {};
const stubDiscovery: DiscoveryResponse = {
  issuer: '',
  authorization_endpoint: '',
  token_endpoint: '',
  revocation_endpoint: '',
  scopes_supported: [],
  response_types_supported: [],
  grant_types_supported: [],
  code_challenge_methods_supported: [],
  token_endpoint_auth_methods_supported: [],
};
// OAuth device-grant stubs (RFC-0010 Phase 4 / RFC 8628).
const stubDeviceAuthorize: DeviceAuthorizeResponse = {
  device_code: '',
  user_code: '',
  verification_uri: '',
  verification_uri_complete: '',
  expires_in: 0,
  interval: 0,
};
const stubDeviceInfo: DeviceInfoResponse = { client_id: '', scopes: [] };
const stubDeviceVerify: DeviceVerifyResponse = { status: 'approved' };

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

const stubListUsers: ListUsersResponse = {
  users: [],
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
const stubAddComment: AddCommentResponse = { comment: stubComment, newlyWatching: false };
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
const stubNotificationsToken: NotificationsTokenResponse = {
  token: '',
  selfUserId: '',
  expiresAt: '',
};
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
const stubListPageChildren: ListPageChildrenResponse = { children: [] };
const stubSeenUsers: SeenUsersResponse = { seenUsers: [], seenUsersCount: 0 };
const stubWatchStatus: WatchStatusResponse = { watching: false };
const stubPreview: PreviewPageResponse = { renderedAst: null };
const stubWsToken: WsTokenResponse = {
  wsToken: '',
  pageId: '',
  expiresAt: '',
  readonly: false,
};
const stubPresenceToken: PresenceTokenResponse = {
  token: '',
  pageId: '',
  selfUserId: '',
  expiresAt: '',
};
const stubLikers: LikersResponse = { users: [], totalCount: 0 };

const stubCreateDraft: CreateDraftResponse = { pageId: '' };
const stubListDrafts: ListDraftsResponse = { drafts: [] };
const stubAutocomplete: AutocompleteResponse = { results: [] };
const stubAttachment = {
  _id: '',
  page: '',
  creator: stubUserPublic,
  filePath: '',
  fileName: '',
  originalName: '',
  fileFormat: '',
  fileSize: 0,
  createdAt: '',
  url: '',
  inUse: false,
} as const;
const stubListAttachments: ListAttachmentsResponse = { attachments: [] };
const stubAddAttachment: AddAttachmentResponse = { attachment: stubAttachment, url: '' };
const stubAttachmentUsage: AttachmentUsageResponse = { pagePath: '', latest: [], past: [] };
const stubAttachmentMeta: AttachmentMeta = (() => {
  const { inUse: _inUse, ...rest } = stubAttachment;
  return rest;
})();
const stubUploadAttachment: UploadAttachmentResponse = { url: '', filename: '', mimeType: '', sizeBytes: 0 };
const stubRemoveAttachment: RemoveAttachmentResponse = { success: true };
const stubSearchPages: SearchPagesResponse = { meta: { total: 0, results: 0 }, data: [] };
const stubCryptoStatus: CryptoStatusResponse = {
  encryptionConfigured: false,
  unencryptedCount: 0,
  encryptedCount: 0,
  entries: [],
};
const stubReencrypt: ReencryptResponse = { rewritten: 0, alreadyEncrypted: 0, missing: 0 };

// Batch 9 — admin sub-contract stubs.
const stubGetAppSettings: GetAppSettingsResponse = {
  app: { title: '', confidential: '' },
  isUploadable: false,
  registrationMode: {},
  setupChecklistDismissed: false,
};
const stubUpdateAppSettings: UpdateAppSettingsResponse = { ok: true };
const stubAuthSettings: GetAuthSettingsResponse = { requireThirdPartyAuth: false, disablePasswordAuth: false };
const stubSecuritySettings: GetSecuritySettingsResponse = {
  registrationMode: 'Open',
  registrationWhiteList: [],
};
const stubMailSettings: GetMailSettingsResponse = {
  from: '',
  activeDriver: '',
  activePlugin: '',
};
const stubUpdateMailSettings: UpdateMailSettingsResponse = { ok: true };
const stubSendTestMail: SendTestMailResponse = { ok: true, to: '' };
const stubStorageStatus: GetStorageStatusResponse = { active: null, drivers: [] };
const stubSearchStatus: GetSearchStatusResponse = { active: null, drivers: [] };
const stubAdminPager = {
  page: 1,
  pagesCount: 0,
  pages: [] as number[],
  total: 0,
  previous: null,
  previousDots: false,
  next: null,
  nextDots: false,
};
const stubListAdminUsers: ListAdminUsersResponse = { users: [], pager: stubAdminPager };
const stubSearchAdminUsersByEmail: SearchAdminUsersByEmailResponse = { users: [] };
const stubInviteUsers: InviteUsersResponse = { results: [] };
const stubAdminUserMutation: AdminUserMutationResponse = { user: stubUserPublic };
const stubResetPassword: ResetPasswordResponse = { user: stubUserPublic, newPassword: '' };
const stubDeleteAdminUser: DeleteAdminUserResponse = { deletedId: '' };
const stubPendingUsersCount: PendingUsersCountResponse = { count: 0 };
const stubListPlugins: ListPluginsResponse = { plugins: [] };
const stubPluginConfig: PluginConfigResponse = { name: '', fields: [], values: {} };
const stubUpdatePluginConfig: UpdatePluginConfigResponse = { ok: true, hotReloaded: false, reconfigureFailed: false };
const stubClearRenderCache: ClearRenderCacheResponse = { ok: true, clearedAt: '', removedCount: 0 };

// app boot / token-auth / me / user — 20 routes. The `_id` user is
// freshly spelt out in `tokenMeRoute` because the user shape returned
// by `/auth/me` (legacy JWT verify endpoint) embeds `status` and is
// nominally different from `stubUser` (no `status` field).
const appAuthMeUserChain = new OpenAPIHono()
  .openapi(appRoutes.getAppInfoRoute, (c) =>
    c.json({ title: null, confidential: null, version: '', apiVersion: 'v2', capabilities: [] } satisfies AppInfoResponse, 200),
  )
  .openapi(installerRoutes.getInstallerStatusRoute, (c) => c.json({ status: 'installer_required' } satisfies InstallerStatusResponse, 200))
  .openapi(installerRoutes.createAdminRoute, (c) => c.json({ status: 'ok' } satisfies CreateAdminResponse, 200))
  .openapi(tokenAuthRoutes.tokenLoginRoute, (c) => c.json(stubTokens, 200))
  .openapi(tokenAuthRoutes.tokenRegisterRoute, (c) => c.json({ status: 'confirmation_required' as const }, 200))
  .openapi(inviteAcceptRoutes.invitePreviewRoute, (c) => c.json({ email: 'stub@example.com' }, 200))
  .openapi(inviteAcceptRoutes.acceptInviteRoute, (c) => c.json(stubTokens, 200))
  .openapi(passwordResetRoutes.forgotPasswordRoute, (c) => c.json({ ok: true as const }, 200))
  .openapi(passwordResetRoutes.validateResetTokenRoute, (c) => c.json({ ok: true as const }, 200))
  .openapi(passwordResetRoutes.selfResetPasswordRoute, (c) => c.json(stubTokens, 200))
  .openapi(activationRoutes.validateActivationTokenRoute, (c) => c.json({ ok: true as const }, 200))
  .openapi(activationRoutes.activateAccountRoute, (c) => c.json(stubTokens, 200))
  .openapi(emailChangeRoutes.validateEmailChangeTokenRoute, (c) => c.json({ ok: true as const, email: 'stub@example.com' }, 200))
  .openapi(emailChangeRoutes.confirmEmailChangeRoute, (c) => c.json({ ok: true as const, email: 'stub@example.com' }, 200))
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
  .openapi(meRoutes.updateThemeRoute, (c) => c.json({ status: 'ok' as const, theme: 'system' as const }, 200))
  .openapi(meRoutes.uploadPictureRoute, (c) => c.json({ status: true } satisfies PictureUploadResponse, 200))
  .openapi(meRoutes.deletePictureRoute, (c) => c.json({ status: 'ok' } satisfies SuccessResponse, 200))
  .openapi(meRoutes.updatePasswordRoute, (c) => c.json({ status: 'ok', message: '' } satisfies PasswordUpdateSuccess, 200))
  .openapi(meRoutes.recentlyViewedPagesRoute, (c) => c.json({ pages: [] } satisfies RecentlyViewedPagesResponse, 200))
  .openapi(accessTokenRoutes.listAccessTokensRoute, (c) => c.json({ accessTokens: [] } satisfies ListAccessTokensResponse, 200))
  .openapi(accessTokenRoutes.createAccessTokenRoute, (c) => c.json(stubCreateAccessToken, 201))
  .openapi(accessTokenRoutes.deleteAccessTokenRoute, (c) => c.json(stubAccessToken, 200))
  .openapi(userRoutes.getUserPageRoute, (c) => c.json(stubUserPage, 200))
  .openapi(userRoutes.getUserBookmarksRoute, (c) => c.json(stubUserBookmarks, 200))
  .openapi(userRoutes.getUserPagesRoute, (c) => c.json(stubUserPages, 200))
  .openapi(userRoutes.listMembersRoute, (c) => c.json(stubListUsers, 200));

// bookmark / backlink / comment / revision — 11 routes. Revision's
// list-by-ids endpoint registers before the by-id endpoint to mirror
// the runtime chain (first-match-wins on the Hono router).
const bookmarkBacklinkCommentRevisionChain = new OpenAPIHono()
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
  .openapi(revisionRoutes.getRevisionRoute, (c) => c.json(stubGetRevision, 200));

// page / page-preview / pageCollab / presence — 18 routes. Page CRUD
// registers AFTER revision in the runtime chain so the shared
// `/pages/*` `createJwtAuth` apply in revision is reused. Inside this
// block, literal sub-paths (`/pages/list`, `/pages/grant`, `/pages/seen`,
// `/pages/seen-users`, `/pages/like`, `/pages/unlike`, `/pages/watch`,
// `/pages/revert`, `/pages/rename`) come before the bare `/pages` CRUD
// endpoints — same first-match-wins ordering used by the revision /
// notification chains.
const pageChain = new OpenAPIHono()
  .openapi(pageRoutes.getPageRoute, (c) => c.json(stubPageWithRevision, 200))
  .openapi(pageRoutes.listPagesRoute, (c) => c.json(stubListPages, 200))
  .openapi(pageRoutes.listPageChildrenRoute, (c) => c.json(stubListPageChildren, 200))
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
  .openapi(pageRoutes.renamePageRoute, (c) => c.json({ ...stubPageResponse, renamed_count: 1 }, 200))
  .openapi(pageRoutes.renameSubtreeRoute, (c) => c.json({ renamed_count: 0 }, 200))
  // page-preview — single endpoint, `/pages/preview` (literal under
  // `/pages/*`). Method is POST so it does not collide with GET /pages
  // (getPage) or POST /pages (createPage) — Hono dispatches by
  // method+path so this is purely organisational.
  .openapi(pagePreviewRoutes.previewPageRoute, (c) => c.json(stubPreview, 200))
  // pageCollab + presence — `/pages/{id}/<suffix>` routes that share
  // the revision handler's `/pages/*` jwtAuth apply. RFC-0003 wsToken
  // and RFC-0005 presence token / likers list. The path uses a 24-hex
  // ObjectId in position 2 vs. the literal `/pages/list` etc., so no
  // matcher collision is possible.
  .openapi(pageCollabRoutes.getYjsTokenRoute, (c) => c.json(stubWsToken, 200))
  .openapi(presenceRoutes.getPresenceTokenRoute, (c) => c.json(stubPresenceToken, 200))
  .openapi(presenceRoutes.getLikersRoute, (c) => c.json(stubLikers, 200));

const lateContractApp = new OpenAPIHono()
  // Batch 6 — draft / autocomplete / attachment (RFC-0004). The
  // literal sub-paths (`/pages/drafts`, `/pages/autocomplete`,
  // `/pages/{pageId}/attachments[/usage]`) all sit under `/pages/*`
  // but use distinct method+path tuples, so they do not collide with
  // the page / revision routes above (Hono dispatches by full
  // method+path). The attachment usage route registers before the
  // bare list route to match the runtime chain.
  .openapi(draftRoutes.createDraftRoute, (c) => c.json(stubCreateDraft, 201))
  .openapi(draftRoutes.listDraftsRoute, (c) => c.json(stubListDrafts, 200))
  .openapi(draftRoutes.cancelDraftRoute, (c) => c.json(stubCreateDraft, 200))
  .openapi(autocompleteRoutes.autocompleteUsersRoute, (c) => c.json(stubAutocomplete, 200))
  .openapi(autocompleteRoutes.autocompletePagesRoute, (c) => c.json(stubAutocomplete, 200))
  .openapi(attachmentRoutes.getAttachmentUsageRoute, (c) => c.json(stubAttachmentUsage, 200))
  .openapi(attachmentRoutes.listAttachmentsRoute, (c) => c.json(stubListAttachments, 200))
  .openapi(attachmentRoutes.addAttachmentRoute, (c) => c.json(stubAddAttachment, 200))
  .openapi(attachmentRoutes.uploadAttachmentRoute, (c) => c.json(stubUploadAttachment, 200))
  .openapi(attachmentRoutes.getAttachmentMetaRoute, (c) => c.json(stubAttachmentMeta, 200))
  .openapi(attachmentRoutes.removeAttachmentRoute, (c) => c.json(stubRemoveAttachment, 200))
  // Batch 7 — search. Singleton literal path `/search`, installs jwtAuth
  // on the path itself (no other handler owns `/search`). Registered
  // before notification to mirror the buildHonoApp chain.
  .openapi(searchRoutes.searchPagesRoute, (c) => c.json(stubSearchPages, 200))
  // Batch 8 — adminCrypto. Two literal paths under `/admin/crypto/*`,
  // admin-only (first time `createJwtAdminRequired(crowi)` lands on
  // Hono). Registered between search and notification to mirror the
  // buildHonoApp chain.
  .openapi(adminCryptoRoutes.getCryptoStatusRoute, (c) => c.json(stubCryptoStatus, 200))
  .openapi(adminCryptoRoutes.reencryptAllRoute, (c) => c.json(stubReencrypt, 200))
  .openapi(notificationRoutes.listNotificationsRoute, (c) => c.json(stubListNotifications, 200))
  .openapi(notificationRoutes.markAllAsReadRoute, (c) => c.json(stubMarkAllAsRead, 200))
  // `/notifications/token` + `/notifications/status` are literal paths
  // and MUST register before `/notifications/{id}/open` so the template
  // route never shadows them (same first-match-wins reason as the
  // revision chain).
  .openapi(notificationRoutes.getNotificationsTokenRoute, (c) => c.json(stubNotificationsToken, 200))
  .openapi(notificationRoutes.getUnreadCountRoute, (c) => c.json(stubNotificationStatus, 200))
  .openapi(notificationRoutes.openNotificationRoute, (c) => c.json(stubOpenNotification, 200));

/**
 * Batch 9 — admin sub-contracts (26 endpoints across two chains):
 *
 * - `adminSettingsContractApp`: the 6 read+write settings sub-contracts
 *   (app / auth / security / mail / storage / search) = 11 routes.
 * - `adminUsersPluginsContractApp`: the larger users (10) + plugins (5)
 *   sub-contracts = 15 routes.
 *
 * Phase 6 (TS2589 escape hatch removal) — these chains are no longer
 * concatenated onto a single `contractApp` via `.route('/', sub)`.
 * Instead, every chain stands alone and `AppType` below is an
 * intersection of their `typeof`s, which `hc<T>` happily collapses via
 * its built-in `UnionToIntersection<Client<T, Prefix>>` plumbing.
 */
const adminSettingsContractApp = new OpenAPIHono()
  .openapi(adminAppRoutes.getAppSettingsRoute, (c) => c.json(stubGetAppSettings, 200))
  .openapi(adminAppRoutes.updateAppSettingsRoute, (c) => c.json(stubUpdateAppSettings, 200))
  .openapi(adminAuthRoutes.getAuthSettingsRoute, (c) => c.json(stubAuthSettings, 200))
  .openapi(adminAuthRoutes.updateAuthSettingsRoute, (c) => c.json(stubAuthSettings, 200))
  .openapi(adminSecurityRoutes.getSecuritySettingsRoute, (c) => c.json(stubSecuritySettings, 200))
  .openapi(adminSecurityRoutes.updateSecuritySettingsRoute, (c) => c.json(stubSecuritySettings, 200))
  .openapi(adminMailRoutes.getMailSettingsRoute, (c) => c.json(stubMailSettings, 200))
  .openapi(adminMailRoutes.updateMailSettingsRoute, (c) => c.json(stubUpdateMailSettings, 200))
  .openapi(adminMailRoutes.sendTestMailRoute, (c) => c.json(stubSendTestMail, 200))
  .openapi(adminStorageRoutes.getStorageStatusRoute, (c) => c.json(stubStorageStatus, 200))
  .openapi(adminSearchRoutes.getSearchStatusRoute, (c) => c.json(stubSearchStatus, 200));

const adminUsersPluginsContractApp = new OpenAPIHono()
  // admin.users — 12 endpoints. Literal `/admin/users/search` and
  // `/admin/users/pending-count` register before `/admin/users/{id}`
  // paths so they do not collide with the id-template routes (Hono
  // matches first-defined).
  .openapi(adminUsersRoutes.listUsersRoute, (c) => c.json(stubListAdminUsers, 200))
  .openapi(adminUsersRoutes.searchUsersByEmailRoute, (c) => c.json(stubSearchAdminUsersByEmail, 200))
  .openapi(adminUsersRoutes.pendingUsersCountRoute, (c) => c.json(stubPendingUsersCount, 200))
  .openapi(adminUsersRoutes.inviteUsersRoute, (c) => c.json(stubInviteUsers, 200))
  .openapi(adminUsersRoutes.editUserRoute, (c) => c.json(stubAdminUserMutation, 200))
  .openapi(adminUsersRoutes.makeAdminRoute, (c) => c.json(stubAdminUserMutation, 200))
  .openapi(adminUsersRoutes.removeFromAdminRoute, (c) => c.json(stubAdminUserMutation, 200))
  .openapi(adminUsersRoutes.activateUserRoute, (c) => c.json(stubAdminUserMutation, 200))
  .openapi(adminUsersRoutes.suspendUserRoute, (c) => c.json(stubAdminUserMutation, 200))
  .openapi(adminUsersRoutes.resetPasswordRoute, (c) => c.json(stubResetPassword, 200))
  .openapi(adminUsersRoutes.updateUserEmailRoute, (c) => c.json(stubAdminUserMutation, 200))
  .openapi(adminUsersRoutes.deleteUserRoute, (c) => c.json(stubDeleteAdminUser, 200))
  // admin.plugins — 5 endpoints. `clear-all` and `clear-plugin` use
  // different literal paths so no collision risk.
  .openapi(adminPluginsRoutes.listPluginsRoute, (c) => c.json(stubListPlugins, 200))
  .openapi(adminPluginsRoutes.getPluginConfigRoute, (c) => c.json(stubPluginConfig, 200))
  .openapi(adminPluginsRoutes.updatePluginConfigRoute, (c) => c.json(stubUpdatePluginConfig, 200))
  .openapi(adminPluginsRoutes.clearRenderCacheAllRoute, (c) => c.json(stubClearRenderCache, 200))
  .openapi(adminPluginsRoutes.clearRenderCachePluginRoute, (c) => c.json(stubClearRenderCache, 200));

/**
 * OAuth 2.0 authorization-server endpoints (RFC-0010 Phase 3) — 4 routes.
 * Kept on its own chain (rather than extended onto the near-full
 * `appAuthMeUserChain`) to stay well under TS's instantiation-depth
 * ceiling, per the TS2589 mitigation documented in this file's header.
 */
const oauthContractApp = new OpenAPIHono()
  .openapi(oauthRoutes.authorizeRoute, (c) => c.json(stubAuthorize, 200))
  .openapi(oauthRoutes.tokenRoute, (c) => c.json(stubToken, 200))
  .openapi(oauthRoutes.revokeRoute, (c) => c.json(stubRevoke, 200))
  .openapi(oauthRoutes.discoveryRoute, (c) => c.json(stubDiscovery, 200))
  .openapi(oauthRoutes.deviceAuthorizeRoute, (c) => c.json(stubDeviceAuthorize, 200))
  .openapi(oauthRoutes.deviceInfoRoute, (c) => c.json(stubDeviceInfo, 200))
  .openapi(oauthRoutes.deviceVerifyRoute, (c) => c.json(stubDeviceVerify, 200));

/**
 * Per-chain type aliases. These are **exported** so the dts bundler
 * (tsup) keeps them as named declarations in `dist/index.d.ts`; if we
 * referenced the `const` chain variables via `typeof` from inside
 * `CrowiApiClient` without exporting them, tsup would inline the
 * declarations and skip emitting `bookmarkBacklinkCommentRevisionChain`
 * etc., causing downstream consumers to see `any` for those summands
 * of the intersection.
 *
 * Each alias resolves to an `OpenAPIHono<Env, RoutesSchema>` shape
 * carrying every route in that chain's `.openapi(...)` calls.
 */
export type AppAuthMeUserChain = typeof appAuthMeUserChain;
export type BookmarkBacklinkCommentRevisionChain = typeof bookmarkBacklinkCommentRevisionChain;
export type PageChain = typeof pageChain;
export type LateContractApp = typeof lateContractApp;
export type AdminSettingsContractApp = typeof adminSettingsContractApp;
export type AdminUsersPluginsContractApp = typeof adminUsersPluginsContractApp;
export type OAuthContractApp = typeof oauthContractApp;

/**
 * `AppType` is exposed as an alias of one representative sub-chain so
 * legacy consumers that `import type { AppType }` keep building. The
 * accurate client surface is `CrowiApiClient` below, which intersects
 * the per-chain `hc` instantiations one at a time so TypeScript never
 * has to fold every chain's schema into a single `Client<T, Prefix>`
 * type expression. (Folding-via-intersection was the layout we tried
 * first and it tripped TS2589 in `Client<T, Prefix>`'s
 * `T extends HonoBase<any, infer S, any>` arm — `infer S` only sees
 * the first summand, so only one chain's routes showed up on the
 * proxy.)
 */
export type AppType = AppAuthMeUserChain;

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
 * Inferred proxy type for the typed Hono client. Built as an
 * intersection of one `hc<ChainType>` return type per sub-chain so
 * TypeScript evaluates `Client<T, Prefix>` separately for each summand
 * — avoiding the TS2589 instantiation-depth blow-up that the previous
 * single-chain layout triggered at 90+ chained `.openapi(...)` calls.
 *
 * The runtime needs only **one** `hc(...)` call because the Hono client
 * is a path-traversal `Proxy`: it lazily reflects whatever property
 * chain the caller dots into. The actual route dispatch happens on the
 * server, so the proxy's runtime behaviour is identical regardless of
 * which `AppType` we hand `hc`. We hand it one chain (`AppType`) and
 * then assert the returned proxy as the full intersection below.
 */
export type CrowiApiClient = ReturnType<typeof hc<AppAuthMeUserChain>> &
  ReturnType<typeof hc<BookmarkBacklinkCommentRevisionChain>> &
  ReturnType<typeof hc<PageChain>> &
  ReturnType<typeof hc<LateContractApp>> &
  ReturnType<typeof hc<AdminSettingsContractApp>> &
  ReturnType<typeof hc<AdminUsersPluginsContractApp>> &
  ReturnType<typeof hc<OAuthContractApp>>;

/**
 * Build a typed Hono client against the contract chain. Constructs a
 * single Hono `hc(...)` proxy and re-types it as the multi-chain
 * intersection `CrowiApiClient` (see above for the runtime/type
 * disconnect rationale).
 */
export const createClient = (baseUrl: string, options: ClientOptions = {}): CrowiApiClient =>
  hc<AppType>(baseUrl, {
    headers: options.headers,
    fetch: options.fetch,
  }) as unknown as CrowiApiClient;
