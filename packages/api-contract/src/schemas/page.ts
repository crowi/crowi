import { z } from '@hono/zod-openapi';
import { RevisionTypeSchema } from './collab';
import { RenderedAstArtifactKeySchema, RenderedAstValueSchema } from './rendered-ast';
import { UserPublicSchema } from './user-public';

// Page grant enum - matches Page model constants
export const PageGrantSchema = z.enum(['1', '2', '3', '4']).transform((val) => Number(val));
export const PageGrantEnum = {
  PUBLIC: 1,
  RESTRICTED: 2,
  SPECIFIED: 3,
  OWNER: 4,
} as const;

// Page status enum - matches Page model constants. `'draft'` (RFC-0004)
// surfaces on the listing when the viewer reads their own unpublished
// drafts, so the schema must accept it or the row's `status` would be
// elided client-side and the UI couldn't render a "draft" indicator.
export const PageStatusSchema = z.enum(['wip', 'published', 'deleted', 'deprecated', 'draft']);
export const PageStatusEnum = {
  WIP: 'wip',
  PUBLISHED: 'published',
  DELETED: 'deleted',
  DEPRECATED: 'deprecated',
  DRAFT: 'draft',
} as const;

// Page type enum
export const PageTypeSchema = z.enum(['portal', 'user', 'public']);
export const PageTypeEnum = {
  PORTAL: 'portal',
  USER: 'user',
  PUBLIC: 'public',
} as const;

// User schema - minimal user information for page responses
export const PageUserSchema = z.object({
  _id: z.string(),
  id: z.string().optional(), // for compatibility
  username: z.string(),
  name: z.string(),
  email: z.string().email(),
  image: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type PageUser = z.infer<typeof PageUserSchema>;

// TOC entry — derived from a revision body's headings, populated on
// save and (for older revisions) computed on the fly during read.
export const TocEntrySchema = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string(),
  anchorId: z.string(),
});
export type TocEntryResponse = z.infer<typeof TocEntrySchema>;

// `[[Page]]` / `[[/path]]` / `[[Page|Display]]` / `[[Page#section]]`
// references extracted from the body. RFC-0002 Phase 2.
export const WikiLinkSchema = z.object({
  /** Verbatim source between the `[[` `]]` (no surrounding brackets). */
  raw: z.string(),
  /** Normalised target (left of the `|`, fragment trimmed for resolution). */
  target: z.string(),
  /** Optional pipe-aliased display text (right of the `|`). */
  displayText: z.string().optional(),
});
export type WikiLinkResponse = z.infer<typeof WikiLinkSchema>;

// `@username` references extracted from the body. Username is
// pre-validated to `[A-Za-z0-9_-]{1,64}` by the extractor.
export const MentionSchema = z.object({
  username: z.string(),
});
export type MentionResponse = z.infer<typeof MentionSchema>;

// Revision-bound metadata derived from the body. RFC-0002 Phase 2
// adds wikiLinks / mentions / codeBlockLanguages alongside `toc`.
export const RevisionMetaSchemaShape = z.object({
  toc: z.array(TocEntrySchema).optional(),
  wikiLinks: z.array(WikiLinkSchema).optional(),
  mentions: z.array(MentionSchema).optional(),
  codeBlockLanguages: z.array(z.string()).optional(),
  // feature-backlink-raw-space-metadata: raw destinations recovered by
  // `renderer/core/raw-space-links.ts` (`[label](/a b)` — a raw-space
  // absolute path CommonMark itself rejects as a link). Verbatim, NOT
  // decoded — `Backlink.createBySavedPage` runs the same
  // `stripFragmentAndQuery` -> `decodeLinkPath` pipeline the regex-based
  // extraction path uses. Mirrors `wikiLinks` above: pushed by the core
  // transform into `PipelineMetadata`, persisted verbatim on `revision.meta`.
  rawSpaceLinks: z.array(z.string()).optional(),
});
export type RevisionMetaShape = z.infer<typeof RevisionMetaSchemaShape>;

// Revision schema - matches RevisionDocument
export const RevisionSchema = z.object({
  _id: z.string(),
  path: z.string(),
  body: z.string(),
  format: z.string().default('markdown'),
  author: PageUserSchema.nullable().optional(),
  createdAt: z.string(),
  meta: RevisionMetaSchemaShape.optional(),
  // RFC-0002 Phase 3 / RFC-0023: transformed mdast. Requests that
  // declare `X-Crowi-Ast-Version: 1` receive the typed envelope
  // (`{astVersion, root}`); everyone else (including the web,
  // permanently) receives the stored bare mdast `Root` verbatim and
  // unvalidated — see `schemas/rendered-ast.ts` for the full contract.
  // Only single-page detail (`getPage`), the listPages portal document
  // and single-revision detail (`getRevision`) emit it; list rows skip
  // it for payload weight.
  renderedAst: RenderedAstValueSchema.optional(),
  // RFC-0023 (design doc §14): identity of the served AST artifact —
  // `rendererVersion` for a verbatim stored AST, a per-response nonce
  // when the served tree differs from the stored one (pending-marker
  // retry / freshness-mismatch recompute). The web render memo keys on
  // `[revisionId, renderedAstArtifactKey]`.
  renderedAstArtifactKey: RenderedAstArtifactKeySchema.optional(),
  // RFC-0002 round 3.1: semver of the renderer pipeline that produced
  // `renderedAst`. The read path uses this to detect stale entries
  // (rebuilt by `renderer:rebuild` once RFC-0008 lands). Absent on
  // revisions saved before this field was introduced.
  rendererVersion: z.string().optional(),
  // RFC-0003 collaborative-save fields. All optional; v1.x revisions
  // emit none of them. See `packages/api/src/models/revision.ts` for
  // semantics. The list-page endpoint currently does not surface
  // these — they only appear on the Phase 5+ checkpoint Revisions
  // produced by Hocuspocus and on the single-revision detail route.
  parentRevisionId: z.string().nullable().optional(),
  type: RevisionTypeSchema.optional(),
  savedBy: z.union([z.string(), PageUserSchema]).nullable().optional(),
  contributors: z.array(z.union([z.string(), PageUserSchema])).optional(),
  message: z.string().optional(),
  // RFC-0010 — edit channel ('web' | 'oauth' | 'pat'); absent on
  // pre-RFC-0010 / collaborative / browser revisions.
  editVia: z.enum(['web', 'oauth', 'pat']).optional(),
});
export type Revision = z.infer<typeof RevisionSchema>;

// Page extended data schema
export const PageExtendedSchema = z.record(z.string(), z.any()).optional();

// Base page schema - matches PageDocument
export const PageSchema = z.object({
  _id: z.string(),
  path: z.string(),
  revision: z.union([z.string(), RevisionSchema]).optional(),
  redirectTo: z.string().nullable().optional(),
  status: PageStatusSchema.nullable().optional(),
  grant: z.number().optional(),
  grantedUsers: z.array(z.string()).optional(),
  creator: z.union([z.string(), PageUserSchema]).nullable().optional(),
  lastUpdateUser: z.union([z.string(), PageUserSchema]).nullable().optional(),
  liker: z.array(z.string()).optional(),
  commentCount: z.number().default(0),
  extended: PageExtendedSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  // RFC-0003 collaborative-edit fields. All optional; `null` is the
  // "no live state yet" value. Existing read endpoints (list /
  // detail) do not currently emit these — the contract is widened
  // here so Phase 5+ endpoints can return them without a contract
  // bump. `yjsState` is intentionally omitted from the contract:
  // the binary blob lives only inside Hocuspocus and never crosses
  // the HTTP API.
  currentRevision: z.string().nullable().optional(),
  yjsCheckpointAt: z.string().nullable().optional(),
  // dynamic fields
  latestRevision: z.string().optional(),
  likerCount: z.number().optional(),
  seenUsersCount: z.number().optional(),
});
export type Page = z.infer<typeof PageSchema>;

// Page with populated revision - for detailed page responses
export const PageWithRevisionSchema = PageSchema.extend({
  revision: RevisionSchema,
  creator: PageUserSchema.nullable().optional(),
  lastUpdateUser: PageUserSchema.nullable().optional(),
});
export type PageWithRevision = z.infer<typeof PageWithRevisionSchema>;

// Get page request schema - using query parameters
export const GetPageRequestSchema = z.object({
  path: z.string().optional(),
  page_id: z.string().optional(),
  revision_id: z.string().optional(),
});
export type GetPageRequest = z.infer<typeof GetPageRequestSchema>;

// Get page response schema
export const GetPageResponseSchema = z.object({
  page: PageWithRevisionSchema,
});
export type GetPageResponse = z.infer<typeof GetPageResponseSchema>;

// feature-restricted-grant-share-banner Phase 1 — response for
// `claimPageLinkAccessRoute` (`POST /pages/link-access`). Reuses
// `GetPageResponseSchema` (not the bare `PageResponseSchema` in
// `contracts/page.ts`) because the web hook returns the same
// `PageWithRevision` shape as `usePage`, and adds `granted`: whether *this*
// call just wrote the caller into `grantedUsers` (as opposed to a
// pass-through 200 for a page the caller already had access to — public /
// creator / already-granted).
export const ClaimPageLinkAccessResponseSchema = GetPageResponseSchema.extend({ granted: z.boolean() });
export type ClaimPageLinkAccessResponse = z.infer<typeof ClaimPageLinkAccessResponseSchema>;

// List pages request schema
export const ListPagesRequestSchema = z.object({
  path: z.string().optional(),
  user: z.string().optional(),
  limit: z.coerce.number().optional().default(50),
  offset: z.coerce.number().optional().default(0),
  // NOT `z.coerce.boolean()`: that uses JS `Boolean(v)`, so the string
  // `"false"` (which is how the web client serialises `false` on the
  // query string) coerces to `true`. That silently flipped
  // `include_deleted` on, which made the listing skip the draft/status
  // filter and leak other users' drafts. Parse the string explicitly so
  // only `"true"` / `true` is truthy; anything else (incl. `"false"`,
  // absent) is `false`.
  include_deleted: z
    .preprocess((v) => v === true || v === 'true' || v === '1', z.boolean())
    .optional()
    .default(false),
  // Sort field + direction for the listing. Defaults preserve the legacy
  // "newest-updated first" order so existing callers are unaffected.
  // `path` sorts alphabetically by full page path (≈ name order).
  sort: z.enum(['updatedAt', 'createdAt', 'path']).optional().default('updatedAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  // When listing a portal path (`/foo/`), open the portal document at this
  // past revision so the catch-all can mirror `?revision_id=` on portals.
  // Only the `portalPage` is rewound — the child rows always reflect the
  // latest. Absent for normal listings.
  revision_id: z.string().optional(),
});
export type ListPagesRequest = z.infer<typeof ListPagesRequestSchema>;
export type ListPagesSort = ListPagesRequest['sort'];

// Pager schema
export const PagerSchema = z.object({
  prev: z.number().nullable(),
  next: z.number().nullable(),
  offset: z.number(),
});
export type Pager = z.infer<typeof PagerSchema>;

// List pages response schema
export const ListPagesResponseSchema = z.object({
  pages: z.array(PageSchema),
  pager: PagerSchema,
  portalPage: PageSchema.nullable().optional(),
  // When listing a portal path (`/foo/`) that has NO portal document of
  // its own but a content page DOES live at the stripped path (`/foo`),
  // this carries that content page. The list view uses it to suppress the
  // "Create Portal" CTA and surface a "portalize this page" banner instead
  // (feature-update-pages-list-ux §4). Mutually exclusive with `portalPage`
  // — only set when `portalPage` is null. Absent / null for ordinary
  // listings.
  contentPage: PageSchema.nullable().optional(),
  // feature-profile-stats-and-page-total — the exact count of the viewer-
  // visible set `pages` pages from (i.e. matching `pages`' visibility
  // conditions, independent of `limit`/`offset`, and excluding whichever
  // ids `portalPage`/`contentPage` already removed from `pages`). Not part
  // of `PagerSchema` — mirrors `ListUsersResponseSchema.total`, a sibling
  // top-level field alongside `pager`.
  total: z.number(),
});
export type ListPagesResponse = z.infer<typeof ListPagesResponseSchema>;

// Sidebar hierarchy — the immediate child "directories" (next path
// segment) directly under a portal path, aggregated server-side. Backs
// the list-page / single-page sidebar tree. Unpaginated: a single
// portal's direct children are bounded enough to return whole, and the
// sidebar needs the *complete* set of first-level segments (a paginated
// /pages/list slice would drop segments past the page boundary).
export const PageChildSegmentSchema = z.object({
  // The bare segment name immediately under the queried path
  // (e.g. 'rfc' for /crowi/rfc/... when querying /crowi/).
  segment: z.string(),
  // Portal-style path for this segment (always trailing-slashed),
  // e.g. '/crowi/rfc/'. Drop the trailing slash for the page path when
  // the segment is a leaf page (see `isPage`).
  path: z.string(),
  // True when a real page is saved at the segment path itself
  // (e.g. `/crowi/rfc`, no trailing slash) — i.e. the segment is a
  // navigable page, not only an inferred directory.
  isPage: z.boolean(),
  // True when a real portal page is saved at `path` (→ compass icon).
  hasPortal: z.boolean(),
  // Number of descendant content pages strictly under this segment
  // (excludes the segment's own page / portal docs). A rough "how much
  // lives here" hint; > 0 means the segment is an expandable directory.
  count: z.number(),
  // ISO8601 timestamp of the segment's representative page: the segment's
  // own page when `isPage` is true, otherwise the most-recently-updated
  // descendant (including the portal doc itself). `null` when no
  // representative page's timestamp could be derived. Optional so
  // existing clients (web SidebarTree) that don't read it keep working
  // unchanged — additive contract extension, feature-child-segments-metadata.
  lastUpdatedAt: z.string().nullable().optional(),
  // The representative page's last updater (same page as `lastUpdatedAt`
  // above). `null` when the updater can't be resolved (e.g. a deleted
  // user, or legacy rows predating `lastUpdateUser`).
  updater: PageUserSchema.nullable().optional(),
});
export type PageChildSegment = z.infer<typeof PageChildSegmentSchema>;

// List page children request schema
export const ListPageChildrenRequestSchema = z.object({
  // Portal path to list children of. Trailing slash optional — the
  // handler normalises it. '/' lists the top-level segments.
  path: z.string(),
});
export type ListPageChildrenRequest = z.infer<typeof ListPageChildrenRequestSchema>;

// List page children response schema
export const ListPageChildrenResponseSchema = z.object({
  // Sorted alphabetically by segment.
  children: z.array(PageChildSegmentSchema),
});
export type ListPageChildrenResponse = z.infer<typeof ListPageChildrenResponseSchema>;

// Create page request schema
export const CreatePageRequestSchema = z.object({
  path: z.string(),
  body: z.string(),
  grant: z.number().optional(),
});
export type CreatePageRequest = z.infer<typeof CreatePageRequestSchema>;

// Update page request schema
export const UpdatePageRequestSchema = z.object({
  page_id: z.string(),
  body: z.string(),
  revision_id: z.string().optional(),
  grant: z.number().optional(),
});
export type UpdatePageRequest = z.infer<typeof UpdatePageRequestSchema>;

// Revert-to-revision request schema
//
// Restore a page's body to one of its past revisions by stacking that
// body as a NEW revision on top of the current latest (non-destructive —
// the whole history is preserved). `revision_id` is the past revision to
// revert TO; there is no base/optimistic-lock field because the revert is
// always applied on top of the server-side latest (see the handler).
export const RevertToRevisionRequestSchema = z.object({
  page_id: z.string(),
  revision_id: z.string(),
});
export type RevertToRevisionRequest = z.infer<typeof RevertToRevisionRequestSchema>;

// Set page grant request schema
//
// A lightweight grant-only update. Unlike `updatePage` this does NOT
// push a new revision — it only mutates `page.grant` / `grantedUsers`
// (see Page.updateGrant). Used by the editor's grant (visibility)
// selector so changing a page's visibility never produces a no-op
// revision in the history.
export const SetPageGrantRequestSchema = z.object({
  page_id: z.string(),
  grant: z.number().int(),
});
export type SetPageGrantRequest = z.infer<typeof SetPageGrantRequestSchema>;

// Rename page request schema
export const RenamePageRequestSchema = z.object({
  page_id: z.string(),
  new_path: z.string(),
  revision_id: z.string().optional(),
  create_redirect: z.boolean().optional(),
  // When true, rename the page together with its whole (grant-visible)
  // descendant subtree (renameTree) instead of just the single page.
  // Defaults to false — the single-page rename behaviour.
  include_descendants: z.boolean().optional(),
});
export type RenamePageRequest = z.infer<typeof RenamePageRequestSchema>;

// Rename page response schema
//
// Shared by single-page and subtree renames. `renamed_count` is the number
// of pages whose path was rewritten (1 for a single rename, root + descendants
// for a subtree). `partial` is set when a subtree rename failed midway —
// best-effort / non-transactional, so some pages may already have moved.
export const RenamePageResponseSchema = z.object({
  page: PageSchema,
  renamed_count: z.number(),
});
export type RenamePageResponse = z.infer<typeof RenamePageResponseSchema>;

// Structured 400 returned when a subtree rename (include_descendants:true)
// cannot proceed because one or more destination paths collide or are not a
// creatable name. `conflicts` tells the client which path failed and why
// (i18n keys from Page.checkPagesRenamable, e.g.
// 'rename_tree.error.already_exists' / 'rename_tree.error.can_not_use_this_name').
export const RenameTreeErrorSchema = z.object({
  error: z.object({
    code: z.literal('PAGE_RENAME_TREE_FAILED'),
    message: z.string(),
    conflicts: z.array(
      z.object({
        path: z.string(),
        reasons: z.array(z.string()),
      }),
    ),
    // True when the failure happened after some pages were already moved
    // (non-transactional best-effort). When omitted/false the failure was
    // detected up-front and nothing was moved.
    partial: z.boolean().optional(),
  }),
});
export type RenameTreeError = z.infer<typeof RenameTreeErrorSchema>;

// Rename-subtree request schema
//
// Moves a whole subtree by *path* rather than by page_id — used to rename a
// portal-less list page (a folder like `/foo/bar/` that has descendants but no
// page document of its own, so there is no page_id / revision to key on).
// Always a subtree move: every grant-visible page under `old_path` is rewritten
// to sit under `new_path`.
export const RenameSubtreeRequestSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  create_redirect: z.boolean().optional(),
});
export type RenameSubtreeRequest = z.infer<typeof RenameSubtreeRequestSchema>;

// Rename-subtree response — how many pages were rewritten. There is no root
// page to return (the folder had none), so the client navigates to the new
// folder path itself.
export const RenameSubtreeResponseSchema = z.object({
  renamed_count: z.number(),
});
export type RenameSubtreeResponse = z.infer<typeof RenameSubtreeResponseSchema>;

// Error response schemas
export const PageNotFoundErrorSchema = z.object({
  error: z.object({
    code: z.literal('PAGE_NOT_FOUND'),
    message: z.literal('Page not found'),
  }),
});

export const PageNotGrantedErrorSchema = z.object({
  error: z.object({
    code: z.literal('PAGE_NOT_GRANTED'),
    message: z.literal('Page is not granted for the user'),
  }),
});

export const PageRevisionErrorSchema = z.object({
  error: z.object({
    code: z.literal('PAGE_REVISION_ERROR'),
    message: z.string(),
  }),
});

/**
 * RFC-0021 §5.3 — the `Idempotency-Key` a history-producing command requires:
 * 16-128 URL-safe characters. Lives here rather than beside the Mongoose model
 * because the dependency runs api -> api-contract, so the contract cannot
 * import it back from `@crowi/api`.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * RFC-0021 Phase 2c-2 error shapes. Defined and exported here, but deliberately
 * NOT yet added to any route's response union — the per-command specs attach
 * them to the routes they introduce. Declaring them now is what puts the four
 * codes into the generated OpenAPI enum without changing a single route.
 */
export const IdempotencyKeyRequiredErrorSchema = z.object({
  error: z.object({
    code: z.literal('IDEMPOTENCY_KEY_REQUIRED'),
    message: z.string(),
  }),
});

export const IdempotencyKeyConflictErrorSchema = z.object({
  error: z.object({
    code: z.literal('IDEMPOTENCY_KEY_CONFLICT'),
    message: z.string(),
  }),
});

export const PageTransitionInProgressErrorSchema = z.object({
  error: z.object({
    code: z.literal('PAGE_TRANSITION_IN_PROGRESS'),
    message: z.string(),
  }),
});

export const PageTransitionIncompleteErrorSchema = z.object({
  error: z.object({
    code: z.literal('PAGE_TRANSITION_INCOMPLETE'),
    message: z.string(),
  }),
});

export type PageNotFoundError = z.infer<typeof PageNotFoundErrorSchema>;
export type PageNotGrantedError = z.infer<typeof PageNotGrantedErrorSchema>;
export type PageRevisionError = z.infer<typeof PageRevisionErrorSchema>;
export type IdempotencyKeyRequiredError = z.infer<typeof IdempotencyKeyRequiredErrorSchema>;
export type IdempotencyKeyConflictError = z.infer<typeof IdempotencyKeyConflictErrorSchema>;
export type PageTransitionInProgressError = z.infer<typeof PageTransitionInProgressErrorSchema>;
export type PageTransitionIncompleteError = z.infer<typeof PageTransitionIncompleteErrorSchema>;

export const SeenPageRequestSchema = z.object({
  page_id: z.string(),
});
export type SeenPageRequest = z.infer<typeof SeenPageRequestSchema>;

export const SeenUsersResponseSchema = z.object({
  seenUsers: z.array(UserPublicSchema),
  seenUsersCount: z.number(),
});
export type SeenUsersResponse = z.infer<typeof SeenUsersResponseSchema>;

export const GetSeenUsersRequestSchema = z.object({
  page_id: z.string(),
  // Optional cap on returned `seenUsers`. `seenUsersCount` always reflects
  // the full count regardless of `limit`. Omit for the full list.
  limit: z.coerce.number().int().positive().optional(),
});
export type GetSeenUsersRequest = z.infer<typeof GetSeenUsersRequestSchema>;

// Watch (notification subscription) schemas
export const GetWatchStatusRequestSchema = z.object({
  page_id: z.string(),
});
export type GetWatchStatusRequest = z.infer<typeof GetWatchStatusRequestSchema>;

export const WatchStatusResponseSchema = z.object({
  watching: z.boolean(),
});
export type WatchStatusResponse = z.infer<typeof WatchStatusResponseSchema>;

export const SetWatchStatusRequestSchema = z.object({
  page_id: z.string(),
  watching: z.boolean(),
});
export type SetWatchStatusRequest = z.infer<typeof SetWatchStatusRequestSchema>;
