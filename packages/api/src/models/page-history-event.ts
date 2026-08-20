import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';
// From the leaf module, NOT `./page` — importing `GRANTS` from `page.ts`
// would form a page.ts <-> page-history-event.ts cycle (page.ts's
// `pendingHistoryEntry` mirror imports types from this file). See
// `page-grants.ts`'s doc comment for the concrete failure that cycle causes
// under `tsx` (a TDZ `ReferenceError`, reproduced via
// `rebuild-attachment-display-derivatives-sigint-harness.ts`).
import { GRANTS } from './page-grants';

/**
 * RFC-0021 §5.1/§5.2/§5.6 — Phase 1 (`feature-page-history-phase1-model`).
 *
 * `PageHistoryEvent` is the page-local metadata-history record: rename /
 * visibility / trash / restore / publish / creation. Hard delete is
 * deliberately NOT a kind here — it is recorded in a separate,
 * path-keyed `PageDeletionRecord` collection (RFC §5.6, Phase 4), because a
 * hard-deleted Page's own history collection is purged along with it. That
 * is also why this envelope carries no `scope` discriminator and no
 * `expiresAt` / retention index: every row here lives exactly as long as
 * the Page it belongs to.
 *
 * Phase 1 defines the schema, indexes, and payload validation ONLY. No
 * writer creates a `PageHistoryEvent` yet — that is Phase 2's command
 * cutover. The only code that touches this collection in Phase 1 is
 * `service/page-history/materialize.ts` (idempotent upsert-by-`_id` from a
 * Page outbox entry) and its tests.
 */
export const PAGE_HISTORY_EVENT_KINDS = ['page_created', 'page_renamed', 'visibility_changed', 'page_trashed', 'page_restored', 'draft_published'] as const;
export type PageHistoryEventKind = (typeof PAGE_HISTORY_EVENT_KINDS)[number];

export const PAGE_HISTORY_EVENT_SOURCES = ['web', 'oauth', 'pat', 'collab', 'system'] as const;
export type PageHistoryEventSource = (typeof PAGE_HISTORY_EVENT_SOURCES)[number];

/** RFC §5.2 — kind-specific payload shapes. Deliberately excludes `grantedUsers`, user ids, share tokens, and emails. */
export interface PageHistoryPayloadByKind {
  page_created: { path: string; grant: number; status: 'published' | 'draft' };
  page_renamed: { fromPath: string; toPath: string; redirectCreated: boolean; subtree: boolean };
  visibility_changed: { fromGrant: number; toGrant: number };
  page_trashed: { fromPath: string; toPath: string };
  page_restored: { fromPath: string; toPath: string };
  draft_published: { fromStatus: 'draft'; toStatus: 'published' };
}

/**
 * The field set each kind's payload owns — the authoritative table the
 * `pre('validate')` hook below enforces against. NOT exported: earlier
 * revisions of this feature also fed this table into
 * `service/page-history/materialize.ts`'s drain identity filter (a
 * content-based "does this payload still look the same" check); the spec
 * later replaced that with matching `Page.pendingHistoryEntry.entryId`
 * alone (see `models/page.ts`'s `PendingHistoryEntry` doc comment), so this
 * table's only remaining job is this schema's own kind-scoped validation.
 */
const PAYLOAD_FIELDS_BY_KIND: Record<PageHistoryEventKind, readonly string[]> = {
  page_created: ['path', 'grant', 'status'],
  page_renamed: ['fromPath', 'toPath', 'redirectCreated', 'subtree'],
  visibility_changed: ['fromGrant', 'toGrant'],
  page_trashed: ['fromPath', 'toPath'],
  page_restored: ['fromPath', 'toPath'],
  draft_published: ['fromStatus', 'toStatus'],
};

/** Every field name that appears in ANY kind's payload — the superset the nested `payload` schema declares. */
const ALL_PAYLOAD_FIELDS = Array.from(new Set(Object.values(PAYLOAD_FIELDS_BY_KIND).flat()));

const isRecord = (value: unknown): value is Record<string, unknown> => value != null && typeof value === 'object' && !Array.isArray(value);

/** Shared, side-effect-free payload validation for durable writes and pending read projection. */
const invalidPayloadField = (kind: PageHistoryEventKind, payload: unknown): string | null => {
  if (!isRecord(payload)) return 'payload';
  const allowed = PAYLOAD_FIELDS_BY_KIND[kind];
  const forbidden = Object.keys(payload).find((field) => !allowed.includes(field));
  if (forbidden != null) return forbidden;
  const missing = allowed.find((field) => payload[field] === undefined || payload[field] === null);
  if (missing != null) return missing;

  switch (kind) {
    case 'page_created':
      if (typeof payload.path !== 'string') return 'path';
      if (!GRANTS.includes(payload.grant as (typeof GRANTS)[number])) return 'grant';
      return payload.status === 'published' || payload.status === 'draft' ? null : 'status';
    case 'page_renamed':
      if (typeof payload.fromPath !== 'string') return 'fromPath';
      if (typeof payload.toPath !== 'string') return 'toPath';
      if (typeof payload.redirectCreated !== 'boolean') return 'redirectCreated';
      return typeof payload.subtree === 'boolean' ? null : 'subtree';
    case 'visibility_changed':
      if (!GRANTS.includes(payload.fromGrant as (typeof GRANTS)[number])) return 'fromGrant';
      return GRANTS.includes(payload.toGrant as (typeof GRANTS)[number]) ? null : 'toGrant';
    case 'page_trashed':
    case 'page_restored':
      if (typeof payload.fromPath !== 'string') return 'fromPath';
      return typeof payload.toPath === 'string' ? null : 'toPath';
    case 'draft_published':
      if (payload.fromStatus !== 'draft') return 'fromStatus';
      return payload.toStatus === 'published' ? null : 'toStatus';
  }
};

export function isValidPageHistoryEventPayload(kind: PageHistoryEventKind, payload: unknown): payload is PageHistoryPayloadByKind[PageHistoryEventKind] {
  return invalidPayloadField(kind, payload) === null;
}

export interface PageHistoryEventDocument extends Document {
  _id: Types.ObjectId;
  page: Types.ObjectId;
  sequence: number;
  kind: PageHistoryEventKind;
  actor: Types.ObjectId | null;
  occurredAt: Date;
  operationId: string;
  source: PageHistoryEventSource;
  payload: PageHistoryPayloadByKind[PageHistoryEventKind];
}

// biome-ignore lint/suspicious/noEmptyInterface: Phase 1 adds no statics — materialize.ts talks to the base Model directly.
export interface PageHistoryEventModel extends Model<PageHistoryEventDocument> {}

/**
 * The nested `payload` schema. A superset of every kind's fields, all
 * individually optional at the raw-schema level (so a single Mongoose
 * SchemaType can represent all 6 shapes without `Mixed`); the
 * `pre('validate')` hook below is what actually enforces "kind X requires
 * exactly kind X's fields and none of anyone else's" (RFC §5.1: "not
 * `Mixed`" + the spec's Validation contract: "`payload` は kind 別 schema で
 * 検証する"). Declaring only these named fields also means an unlisted key
 * (`grantedUsers`, a user id, a share token, an email — AC-2) is silently
 * stripped by Mongoose's default `strict: true` cast before the hook even
 * runs.
 *
 * Exported so `models/page.ts`'s `pendingHistoryEntry.event` mirror (the
 * pre-materialization outbox copy of this same envelope) can reuse the
 * identical schema instead of a second Mixed/duplicated definition.
 *
 * `strict: 'throw'` (codex review attempt 2, AC-2's test-plan wording:
 * "禁止フィールドを含む payload が schema で拒否される" — REJECTED, not silently
 * stripped). Mongoose's default `strict: true` casts an undeclared key
 * (`grantedUsers`, a user id, a share token, an email — none of which are
 * declared fields on ANY kind here) out of the document silently, before
 * `pre('validate')` below ever runs — which satisfies "the schema doesn't
 * store it" but not "rejected". `'throw'` makes assigning an undeclared key
 * a synchronous `StrictModeError` instead, at both `new PageHistoryEvent(...)`
 * and the `pendingHistoryEntry.event` outbox mirror in `models/page.ts`
 * (same schema object — desirable defense in depth, not a separate change).
 */
export const pageHistoryEventPayloadSchema = new Schema(
  {
    path: { type: String },
    grant: { type: Number, enum: GRANTS },
    status: { type: String, enum: ['published', 'draft'] },
    fromPath: { type: String },
    toPath: { type: String },
    redirectCreated: { type: Boolean },
    subtree: { type: Boolean },
    fromGrant: { type: Number, enum: GRANTS },
    toGrant: { type: Number, enum: GRANTS },
    fromStatus: { type: String, enum: ['draft'] },
    toStatus: { type: String, enum: ['published'] },
  },
  { _id: false, strict: 'throw' },
);

const pageHistoryEventSchema = new Schema<PageHistoryEventDocument, PageHistoryEventModel>({
  page: { type: Schema.Types.ObjectId, ref: 'Page', required: true },
  sequence: { type: Number, required: true },
  kind: { type: String, enum: PAGE_HISTORY_EVENT_KINDS, required: true },
  actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  occurredAt: { type: Date, required: true },
  operationId: { type: String, required: true },
  source: { type: String, enum: PAGE_HISTORY_EVENT_SOURCES, required: true },
  payload: { type: pageHistoryEventPayloadSchema, required: true },
});

// RFC §5.3 — `{ page, sequence }` is the page-local ordering key and the
// cross-collection half of the normative "no shared sequence" invariant
// (see `service/page-history/repair.ts`).
pageHistoryEventSchema.index({ page: 1, sequence: 1 }, { unique: true, name: 'pageHistoryEvent_page_sequence_unique' });
pageHistoryEventSchema.index({ page: 1, sequence: -1, _id: -1 }, { name: 'pageHistoryEvent_page_sequence_cursor' });
// RFC §5.3 — makes a command retry idempotent while still allowing a single
// higher-level operation to write several different kinds (e.g. a
// body-plus-grant save's content + visibility rows share one operationId).
pageHistoryEventSchema.index({ page: 1, operationId: 1, kind: 1 }, { unique: true, name: 'pageHistoryEvent_page_operationId_kind_unique' });

/**
 * Kind-scoped payload validation (RFC §5.1: "not `Mixed`"; spec Validation
 * contract: "`payload` は kind 別 schema で検証する"). A single merged schema
 * would let a `visibility_changed` event carry `page_created`'s `path`
 * field, since both are declared on the same superset schema above — this
 * hook is what actually makes each kind's payload shape effective.
 */
pageHistoryEventSchema.pre('validate', function () {
  const allowed = PAYLOAD_FIELDS_BY_KIND[this.kind as PageHistoryEventKind];
  if (allowed == null) {
    // `kind`'s own `enum` validator already rejects an unknown kind — this
    // is defense in depth only, never the primary guard.
    return;
  }

  const payloadObj =
    (this.payload as unknown as { toObject?: () => Record<string, unknown> })?.toObject?.() ?? (this.payload as unknown as Record<string, unknown>) ?? {};

  const invalidField = invalidPayloadField(this.kind, payloadObj);
  if (invalidField != null) {
    this.invalidate(`payload.${invalidField}`, `payload.${invalidField} is not valid for kind "${this.kind}"`);
  }

  for (const field of ALL_PAYLOAD_FIELDS) {
    const hasValue = payloadObj[field] !== undefined && payloadObj[field] !== null;
    if (!allowed.includes(field) && hasValue) {
      this.invalidate(`payload.${field}`, `payload.${field} is not a valid field for kind "${this.kind}"`);
    }
  }
  for (const field of allowed) {
    if (payloadObj[field] === undefined || payloadObj[field] === null) {
      this.invalidate(`payload.${field}`, `payload.${field} is required for kind "${this.kind}"`);
    }
  }
});

export default (_crowi: Crowi) => {
  const PageHistoryEvent = model<PageHistoryEventDocument, PageHistoryEventModel>('PageHistoryEvent', pageHistoryEventSchema);
  return PageHistoryEvent;
};
