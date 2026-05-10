import { z } from 'zod';
import { UserPublicSchema } from './userPublic';

// Page grant enum - matches Page model constants
export const PageGrantSchema = z.enum(['1', '2', '3', '4']).transform((val) => Number(val));
export const PageGrantEnum = {
  PUBLIC: 1,
  RESTRICTED: 2,
  SPECIFIED: 3,
  OWNER: 4,
} as const;

// Page status enum - matches Page model constants
export const PageStatusSchema = z.enum(['wip', 'published', 'deleted', 'deprecated']);
export const PageStatusEnum = {
  WIP: 'wip',
  PUBLISHED: 'published',
  DELETED: 'deleted',
  DEPRECATED: 'deprecated',
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
  // RFC-0002 Phase 3: transformed mdast (parse + core plugins +
  // shiki) for the web client to render without re-parsing the body.
  // Typed as opaque `unknown` because mdast is too deep / external-
  // spec to maintain a strict Zod schema for. Only single-page detail
  // (`getPage`) and single-revision detail (`getRevision`) emit it;
  // list endpoints skip it for payload weight.
  renderedAst: z.unknown().optional(),
});
export type Revision = z.infer<typeof RevisionSchema>;

// Page extended data schema
export const PageExtendedSchema = z.record(z.any()).optional();

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

// List pages request schema
export const ListPagesRequestSchema = z.object({
  path: z.string().optional(),
  user: z.string().optional(),
  limit: z.coerce.number().optional().default(50),
  offset: z.coerce.number().optional().default(0),
  include_deleted: z.coerce.boolean().optional().default(false),
});
export type ListPagesRequest = z.infer<typeof ListPagesRequestSchema>;

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
});
export type ListPagesResponse = z.infer<typeof ListPagesResponseSchema>;

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

// Rename page request schema
export const RenamePageRequestSchema = z.object({
  page_id: z.string(),
  new_path: z.string(),
  revision_id: z.string().optional(),
  create_redirect: z.boolean().optional(),
});
export type RenamePageRequest = z.infer<typeof RenamePageRequestSchema>;

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

export type PageNotFoundError = z.infer<typeof PageNotFoundErrorSchema>;
export type PageNotGrantedError = z.infer<typeof PageNotGrantedErrorSchema>;
export type PageRevisionError = z.infer<typeof PageRevisionErrorSchema>;

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
