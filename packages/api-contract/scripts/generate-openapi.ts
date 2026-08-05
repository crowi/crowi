#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase 2 — Hono-driven OpenAPI generator.
 *
 * Replaces the legacy ts-rest based script. This file is invoked
 * via `pnpm --filter @crowi/api-contract generate-openapi` (which runs
 * `tsx scripts/generate-openapi.ts`) and writes
 * `packages/api-contract/openapi.json` + `openapi.yaml`.
 *
 * The strategy until Phase 4 finishes:
 *
 *   1. Instantiate a bare `OpenAPIHono` with no routes.
 *   2. Register every published response/request Zod schema under
 *      `components.schemas` so external SDK generators see the full
 *      data model even while `paths{}` is empty.
 *   3. Emit OpenAPI 3.1.0 via `getOpenAPI31Document()`.
 *
 * As Phase 3-4 commits add `createRoute(...)` + `app.openapi(...)`
 * handler chains to `packages/api/src/hono/`, the `paths{}` block
 * will grow. The Phase 6 cleanup swaps this script over to import
 * the real `honoApp` from `@crowi/api` and emits the full spec.
 *
 * Why not import `@crowi/api`'s `honoApp` today: the api package
 * still hosts Express + ts-rest as the source of truth for every
 * route, and its boot path requires MongoDB / Redis. Building the
 * spec from an api boot would slow CI and add a transient DB dep
 * to a pure contract build. The lightweight scaffold here keeps the
 * generator hermetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenAPIHono } from '@hono/zod-openapi';
import jsYaml from 'js-yaml';

import {
  adminAppRoutes,
  adminAuthRoutes,
  adminCryptoRoutes,
  adminMailRoutes,
  adminPluginsRoutes,
  adminSearchRoutes,
  adminSecurityRoutes,
  adminStorageRoutes,
  adminUsersRoutes,
  appRoutes,
  attachmentRoutes,
  autocompleteRoutes,
  backlinkRoutes,
  bookmarkRoutes,
  commentRoutes,
  draftRoutes,
  installerRoutes,
  inviteAcceptRoutes,
  meRoutes,
  accessTokenRoutes,
  oauthRoutes,
  notificationRoutes,
  pageCollabRoutes,
  pagePreviewRoutes,
  pageRoutes,
  presenceRoutes,
  revisionRoutes,
  searchRoutes,
  tokenAuthRoutes,
  userRoutes,
  AdminPagerSchema,
  AdminRequiredErrorSchema,
  AdminUserIdParamSchema,
  AdminUserMutationResponseSchema,
  ApiErrorSchema,
  ApplicationNotInstalledErrorSchema,
  AppSettingsValidationErrorSchema,
  AttachmentErrorSchema,
  AttachmentMetaSchema,
  AttachmentSchema,
  AttachmentUsageResponseSchema,
  AuthenticationRequiredErrorSchema,
  ConflictErrorSchema,
  CreateAdminRequestSchema,
  CreateAdminResponseSchema,
  CreateDraftRequestSchema,
  CreateDraftResponseSchema,
  DraftBadRequestErrorSchema,
  DraftNotFoundErrorSchema,
  DraftPathConflictErrorSchema,
  DraftSummarySchema,
  EditAdminUserRequestSchema,
  GetAppSettingsResponseSchema,
  GetMailSettingsResponseSchema,
  GetPageResponseSchema,
  GetSeenUsersRequestSchema,
  GetStorageStatusResponseSchema,
  InstallerStatusResponseSchema,
  InternalServerErrorSchema,
  InvalidPageIdErrorSchema,
  InvitedUserResultSchema,
  InviteUsersRequestSchema,
  InviteUsersResponseSchema,
  ListAdminUsersRequestSchema,
  ListAdminUsersResponseSchema,
  ListAttachmentsResponseSchema,
  ListDraftsResponseSchema,
  ListPagesRequestSchema,
  ListPagesResponseSchema,
  ListPluginsResponseSchema,
  MailSettingsValidationErrorSchema,
  MentionSchema,
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  ClientInfoResponseSchema,
  DeviceAuthorizeRequestSchema,
  DeviceAuthorizeResponseSchema,
  DeviceInfoResponseSchema,
  DeviceVerifyRequestSchema,
  DeviceVerifyResponseSchema,
  DiscoveryResponseSchema,
  OAuthErrorSchema,
  RevokeRequestSchema,
  TokenRequestSchema,
  TokenResponseSchema,
  NotFoundErrorSchema,
  PageNotFoundErrorSchema,
  PageNotGrantedErrorSchema,
  PageRevisionErrorSchema,
  PageSchema,
  PageUserSchema,
  PageWithRevisionSchema,
  PagerSchema,
  PastAttachmentUsageSchema,
  PluginConfigResponseSchema,
  PluginConfigValidationErrorSchema,
  PluginFieldSchema,
  PluginInfoSchema,
  PluginNotFoundErrorSchema,
  RecentlyViewedPagesResponseSchema,
  ResetPasswordResponseSchema,
  RevisionMetaSchemaShape,
  RevisionSchema,
  SearchAdminUsersByEmailRequestSchema,
  SearchAdminUsersByEmailResponseSchema,
  SeenUsersResponseSchema,
  SendTestMailErrorSchema,
  SendTestMailRequestSchema,
  SendTestMailResponseSchema,
  ServiceUnavailableErrorSchema,
  ThirdPartyAuthRequiredErrorSchema,
  TocEntrySchema,
  UpdateAdminUserEmailRequestSchema,
  UpdateAppSettingsRequestSchema,
  UpdateAppSettingsResponseSchema,
  UpdateMailSettingsRequestSchema,
  UpdateMailSettingsResponseSchema,
  UpdatePageRequestSchema,
  UpdatePluginConfigRequestSchema,
  UpdatePluginConfigResponseSchema,
  UploadAttachmentErrorSchema,
  UploadAttachmentResponseSchema,
  UserPublicSchema,
  UserStatusErrorSchema,
  ValidationErrorSchema,
  WikiLinkSchema,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputDir = join(__dirname, '..');

const app = new OpenAPIHono();

/**
 * Register every public response/request schema with the OpenAPI
 * registry so they appear in `components.schemas` even before any
 * `createRoute` references them. Phase 3-4 handlers add their own
 * routes which will reference these by `$ref`.
 *
 * Schema names are kept aligned with the export name (minus the
 * `Schema` suffix) so consumers can correlate `import {Page} from
 * '@crowi/api-contract'` with `#/components/schemas/Page`.
 */
const schemas = [
  // common error envelopes
  ['ApiError', ApiErrorSchema],
  ['ApplicationNotInstalledError', ApplicationNotInstalledErrorSchema],
  ['AuthenticationRequiredError', AuthenticationRequiredErrorSchema],
  ['AdminRequiredError', AdminRequiredErrorSchema],
  ['UserStatusError', UserStatusErrorSchema],
  ['ThirdPartyAuthRequiredError', ThirdPartyAuthRequiredErrorSchema],
  ['InternalServerError', InternalServerErrorSchema],
  ['InvalidPageIdError', InvalidPageIdErrorSchema],
  ['ValidationError', ValidationErrorSchema],
  ['NotFoundError', NotFoundErrorSchema],
  ['ConflictError', ConflictErrorSchema],
  ['ServiceUnavailableError', ServiceUnavailableErrorSchema],

  // oauth (RFC-0010 Phase 3)
  ['OAuthError', OAuthErrorSchema],
  ['AuthorizeRequest', AuthorizeRequestSchema],
  ['AuthorizeResponse', AuthorizeResponseSchema],
  ['TokenRequest', TokenRequestSchema],
  ['TokenResponse', TokenResponseSchema],
  ['RevokeRequest', RevokeRequestSchema],
  ['DiscoveryResponse', DiscoveryResponseSchema],

  // oauth device grant (RFC-0010 Phase 4 / RFC 8628)
  ['DeviceAuthorizeRequest', DeviceAuthorizeRequestSchema],
  ['DeviceAuthorizeResponse', DeviceAuthorizeResponseSchema],
  ['DeviceInfoResponse', DeviceInfoResponseSchema],
  ['DeviceVerifyRequest', DeviceVerifyRequestSchema],
  ['DeviceVerifyResponse', DeviceVerifyResponseSchema],

  // oauth client-info (RFC-0016 Phase 0)
  ['ClientInfoResponse', ClientInfoResponseSchema],

  // user / shared
  ['UserPublic', UserPublicSchema],
  ['PageUser', PageUserSchema],

  // page
  ['Page', PageSchema],
  ['PageWithRevision', PageWithRevisionSchema],
  ['Revision', RevisionSchema],
  ['RevisionMeta', RevisionMetaSchemaShape],
  ['TocEntry', TocEntrySchema],
  ['WikiLink', WikiLinkSchema],
  ['Mention', MentionSchema],
  ['Pager', PagerSchema],
  ['ListPagesRequest', ListPagesRequestSchema],
  ['ListPagesResponse', ListPagesResponseSchema],
  ['GetPageResponse', GetPageResponseSchema],
  ['UpdatePageRequest', UpdatePageRequestSchema],
  ['PageNotFoundError', PageNotFoundErrorSchema],
  ['PageNotGrantedError', PageNotGrantedErrorSchema],
  ['PageRevisionError', PageRevisionErrorSchema],
  ['GetSeenUsersRequest', GetSeenUsersRequestSchema],
  ['SeenUsersResponse', SeenUsersResponseSchema],
  ['RecentlyViewedPagesResponse', RecentlyViewedPagesResponseSchema],

  // attachment
  ['Attachment', AttachmentSchema],
  ['AttachmentMeta', AttachmentMetaSchema],
  ['ListAttachmentsResponse', ListAttachmentsResponseSchema],
  ['PastAttachmentUsage', PastAttachmentUsageSchema],
  ['AttachmentUsageResponse', AttachmentUsageResponseSchema],
  ['AttachmentError', AttachmentErrorSchema],
  ['UploadAttachmentResponse', UploadAttachmentResponseSchema],
  ['UploadAttachmentError', UploadAttachmentErrorSchema],

  // draft
  ['CreateDraftRequest', CreateDraftRequestSchema],
  ['CreateDraftResponse', CreateDraftResponseSchema],
  ['DraftPathConflictError', DraftPathConflictErrorSchema],
  ['DraftBadRequestError', DraftBadRequestErrorSchema],
  ['DraftNotFoundError', DraftNotFoundErrorSchema],
  ['DraftSummary', DraftSummarySchema],
  ['ListDraftsResponse', ListDraftsResponseSchema],

  // installer
  ['InstallerStatusResponse', InstallerStatusResponseSchema],
  ['CreateAdminRequest', CreateAdminRequestSchema],
  ['CreateAdminResponse', CreateAdminResponseSchema],

  // admin
  ['AdminPager', AdminPagerSchema],
  ['AdminUserIdParam', AdminUserIdParamSchema],
  ['AdminUserMutationResponse', AdminUserMutationResponseSchema],
  ['ListAdminUsersRequest', ListAdminUsersRequestSchema],
  ['ListAdminUsersResponse', ListAdminUsersResponseSchema],
  ['SearchAdminUsersByEmailRequest', SearchAdminUsersByEmailRequestSchema],
  ['SearchAdminUsersByEmailResponse', SearchAdminUsersByEmailResponseSchema],
  ['InviteUsersRequest', InviteUsersRequestSchema],
  ['InvitedUserResult', InvitedUserResultSchema],
  ['InviteUsersResponse', InviteUsersResponseSchema],
  ['EditAdminUserRequest', EditAdminUserRequestSchema],
  ['ResetPasswordResponse', ResetPasswordResponseSchema],
  ['UpdateAdminUserEmailRequest', UpdateAdminUserEmailRequestSchema],
  ['GetAppSettingsResponse', GetAppSettingsResponseSchema],
  ['UpdateAppSettingsRequest', UpdateAppSettingsRequestSchema],
  ['UpdateAppSettingsResponse', UpdateAppSettingsResponseSchema],
  ['AppSettingsValidationError', AppSettingsValidationErrorSchema],
  ['GetMailSettingsResponse', GetMailSettingsResponseSchema],
  ['UpdateMailSettingsRequest', UpdateMailSettingsRequestSchema],
  ['UpdateMailSettingsResponse', UpdateMailSettingsResponseSchema],
  ['SendTestMailRequest', SendTestMailRequestSchema],
  ['SendTestMailResponse', SendTestMailResponseSchema],
  ['SendTestMailError', SendTestMailErrorSchema],
  ['MailSettingsValidationError', MailSettingsValidationErrorSchema],
  ['GetStorageStatusResponse', GetStorageStatusResponseSchema],
  ['PluginField', PluginFieldSchema],
  ['PluginInfo', PluginInfoSchema],
  ['ListPluginsResponse', ListPluginsResponseSchema],
  ['PluginConfigResponse', PluginConfigResponseSchema],
  ['UpdatePluginConfigRequest', UpdatePluginConfigRequestSchema],
  ['UpdatePluginConfigResponse', UpdatePluginConfigResponseSchema],
  ['PluginNotFoundError', PluginNotFoundErrorSchema],
  ['PluginConfigValidationError', PluginConfigValidationErrorSchema],
] as const;

for (const [name, schema] of schemas) {
  app.openAPIRegistry.register(name, schema);
}

// Route definitions migrated from ts-rest in RFC-0006 Phase 3+. Each
// resource exports an `xxxRoutes` object whose entries are `createRoute(
// ...)` definitions; registering them on the bare `OpenAPIHono` writes
// them into `paths{}` without needing the real handler implementation
// (this script intentionally cannot import `@crowi/api` — see the file
// header for the hermeticity rationale).
const routeGroups = [
  appRoutes,
  installerRoutes,
  tokenAuthRoutes,
  // Public invite-acceptance (GET preview + POST accept). Registered
  // right after tokenAuth to mirror the buildHonoApp chain
  // (installer -> tokenAuth -> inviteAccept -> ... -> me).
  inviteAcceptRoutes,
  meRoutes,
  // RFC-0010 Phase 2 — PAT management rides the `/me/*` apply; registered
  // right after meRoutes to mirror the buildHonoApp chain.
  accessTokenRoutes,
  // RFC-0010 Phase 3 — OAuth authorization-server endpoints (authorize /
  // token / revoke / discovery). Registered after access-token to mirror
  // the buildHonoApp chain.
  oauthRoutes,
  userRoutes,
  bookmarkRoutes,
  backlinkRoutes,
  commentRoutes,
  revisionRoutes,
  // page registers AFTER revision so the spec `paths{}` ordering
  // matches the runtime handler chain (revision -> page -> page-preview
  // -> pageCollab -> presence -> notification — see
  // `packages/api/src/hono/index.ts:buildHonoApp`).
  pageRoutes,
  pagePreviewRoutes,
  pageCollabRoutes,
  presenceRoutes,
  // Batch 6 — draft / autocomplete / attachment. The `/pages/drafts`
  // and `/pages/autocomplete` literal sub-paths sit under the
  // revision-owned `/pages/*` apply at runtime; the spec ordering
  // mirrors the buildHonoApp chain (revision -> page -> page-preview
  // -> pageCollab -> presence -> draft -> autocomplete -> attachment
  // -> notification).
  draftRoutes,
  autocompleteRoutes,
  attachmentRoutes,
  // Batch 7 — search. Singleton literal path `/search` (OUTSIDE the
  // revision-owned `/pages/*` apply). Spec ordering mirrors the
  // buildHonoApp chain (attachment -> search -> adminCrypto ->
  // notification).
  searchRoutes,
  // Batch 8 — adminCrypto. Two literal paths under `/admin/crypto/*`,
  // admin-only (first time `createJwtAdminRequired` lands on Hono).
  adminCryptoRoutes,
  // Batch 9 — the 8 admin sub-contracts (app / auth / security / mail
  // / storage / search / users / plugins). Spec ordering
  // mirrors the buildHonoApp chain.
  adminAppRoutes,
  adminAuthRoutes,
  adminSecurityRoutes,
  adminMailRoutes,
  adminStorageRoutes,
  adminSearchRoutes,
  adminUsersRoutes,
  adminPluginsRoutes,
  notificationRoutes,
];
for (const group of routeGroups) {
  for (const route of Object.values(group)) {
    // `openapi(route, handler)` requires a handler; `_def` is the
    // internal path used by the bare-spec generator. The handler is
    // never invoked, so we can pass a stub that returns 200.
    app.openapi(route, (c) =>
      c.json(
        // biome-ignore lint/suspicious/noExplicitAny: stub handler — value
        // never reaches the wire because the script only emits the spec
        {} as any,
        200,
      ),
    );
  }
}

// JWT bearer scheme — preserved from the legacy ts-rest generator.
app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'JWT token authentication',
});

const doc = app.getOpenAPI31Document({
  openapi: '3.1.0',
  info: {
    title: 'Crowi API',
    description: 'API for Crowi - Markdown-based Wiki Application',
    version: '2.0.0',
  },
  servers: [
    {
      url: 'http://localhost:3000/api',
      description: 'Local development server',
    },
    {
      url: 'https://your-crowi-instance.com/api',
      description: 'Production server',
    },
  ],
});

mkdirSync(outputDir, { recursive: true });
const jsonPath = join(outputDir, 'openapi.json');
const jsonText = `${JSON.stringify(doc, null, 2)}\n`;
writeFileSync(jsonPath, jsonText);
console.log(`OpenAPI specification generated at: ${jsonPath}`);

// Round-trip through JSON before dumping YAML — Batch 9 introduced
// per-route `hook` overrides on admin.app / admin.mail, and Hono's
// `getOpenAPI31Document` leaks the function through into the doc
// object. JSON.stringify drops functions silently; YAML's dumper
// throws. The round-trip strips functions uniformly so the two
// generated artefacts stay byte-identical at the data level.
const yamlPath = join(outputDir, 'openapi.yaml');
writeFileSync(yamlPath, jsYaml.dump(JSON.parse(jsonText)));
console.log(`OpenAPI YAML specification generated at: ${yamlPath}`);
