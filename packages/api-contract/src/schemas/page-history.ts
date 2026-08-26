import { z } from '@hono/zod-openapi';

import { PageUserSchema } from './page';

/** Kind-specific payloads shared by event writers and history readers. */
export interface PageHistoryPayloadByKind {
  page_created: { path: string; grant: number; status: 'published' | 'draft' };
  page_renamed: { fromPath: string; toPath: string; redirectCreated: boolean; subtree: boolean };
  visibility_changed: { fromGrant: number; toGrant: number };
  page_trashed: { fromPath: string; toPath: string };
  page_restored: { fromPath: string; toPath: string };
  draft_published: { fromStatus: 'draft'; toStatus: 'published' };
}

/**
 * RFC-0021 Phase 3 — the merged page timeline.
 *
 * Content revisions and metadata events are two collections that a reader sees
 * as one list, so the wire shape is a discriminated union rather than two
 * parallel arrays: the client renders in the order the server produced, and
 * cannot accidentally interleave them itself.
 */

/**
 * A row's stable identity, used for ordering ties and for the client's
 * selection state. Opaque to the client — it only ever compares it.
 */
export const PageHistoryRowIdSchema = z.string().openapi({ example: '66a1f2c3d4e5f60718293a4b' });

const rowBase = {
  id: PageHistoryRowIdSchema,
  /**
   * Position in the page-local ordering. `null` for rows below the tracking
   * boundary and for an untracked page — those are ordered by time instead, and
   * inventing a synthetic sequence for them would claim an ordering the data
   * does not have.
   */
  sequence: z.number().int().nullable(),
  occurredAt: z.string().datetime(),
  actor: PageUserSchema.nullable(),
};

export const PageHistoryContentRowSchema = z
  .object({
    ...rowBase,
    type: z.literal('content_revision'),
    revisionId: z.string(),
    savedBy: PageUserSchema.nullable().optional(),
    contributors: z.array(PageUserSchema).optional(),
    editVia: z.enum(['web', 'oauth', 'pat']).optional(),
    /** Present only while the row is still in the page's outbox — it has no durable revision yet. */
    pending: z.boolean().optional(),
  })
  .openapi('PageHistoryContentRow');

export const PageHistoryEventRowSchema = z
  .object({
    ...rowBase,
    type: z.literal('page_event'),
    kind: z.enum(['page_created', 'page_renamed', 'visibility_changed', 'page_trashed', 'page_restored', 'draft_published']),
    /** Kind-specific detail. Its shape is fixed per kind by the server's own event schema. */
    payload: z.record(z.string(), z.unknown()),
    /** Groups rows produced by one command. Only ever rows of THIS page — never a lookup across pages. */
    operationId: z.string().nullable(),
    /** True when the owning operation moved a subtree. The client shows a badge; it never resolves the other pages. */
    subtree: z.boolean().optional(),
    pending: z.boolean().optional(),
  })
  .openapi('PageHistoryEventRow');

export const PageHistoryEntrySchema = z.discriminatedUnion('type', [PageHistoryContentRowSchema, PageHistoryEventRowSchema]).openapi('PageHistoryEntry');

/**
 * Whether this page records metadata history, and from when.
 *
 * Discriminated so a client cannot read `trackingStartedAt` off a page that has
 * none: an untracked page has no boundary at all, and its rows are ordered
 * purely by time.
 */
export const PageHistoryTrackingSchema = z
  .discriminatedUnion('state', [z.object({ state: z.literal('ready'), trackingStartedAt: z.string().datetime() }), z.object({ state: z.literal('untracked') })])
  .openapi('PageHistoryTracking');

export const PageHistoryResponseSchema = z
  .object({
    entries: z.array(PageHistoryEntrySchema),
    /** Opaque continuation token. Absent when the timeline is exhausted. */
    nextCursor: z.string().nullable(),
    tracking: PageHistoryTrackingSchema,
  })
  .openapi('PageHistoryResponse');

export const PageHistoryQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const PageHistoryPageIdParamSchema = z.object({
  pageId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .openapi({ param: { name: 'pageId', in: 'path' }, example: '66a1f2c3d4e5f60718293a4b' }),
});

export type PageHistoryRowId = z.infer<typeof PageHistoryRowIdSchema>;
export type PageHistoryContentRow = z.infer<typeof PageHistoryContentRowSchema>;
export type PageHistoryEventRow = z.infer<typeof PageHistoryEventRowSchema>;
export type PageHistoryEntry = z.infer<typeof PageHistoryEntrySchema>;
export type PageHistoryTracking = z.infer<typeof PageHistoryTrackingSchema>;
export type PageHistoryResponse = z.infer<typeof PageHistoryResponseSchema>;
export type PageHistoryQuery = z.infer<typeof PageHistoryQuerySchema>;
