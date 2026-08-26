import { type ErrorCode, IDEMPOTENCY_KEY_PATTERN } from '@crowi/api-contract';
import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';

import { PAGE_HISTORY_EVENT_SOURCES, type PageHistoryEventSource } from './page-history-event';

/**
 * RFC-0021 §5.3/§5.5a — the idempotency record behind every history-
 * producing command. Deliberately a SEPARATE bounded collection rather than
 * Page-embedded state: it carries a lease and a terminal result so a crashed
 * worker's takeover is safe, and a subtree operation's target map must
 * outlive any single Page's document.
 *
 * Phase 1 (`feature-page-history-phase1-model`) ships the schema and
 * indexes only — no command writes a row here yet (that starts in Phase 2).
 * `command` is left as a free-form string rather than a fixed enum because
 * Phase 2 owns the concrete command taxonomy (rename / rename_tree / grant /
 * trash / restore / publish / create, ...); pinning it here would be a
 * guess this spec has no authority to make.
 */
export interface PageHistoryOperationSubtreeTarget {
  pageId: Types.ObjectId;
  fromPath: string;
  toPath: string;
}

export interface PageHistoryOperationLease {
  owner: string;
  until: Date;
}

export interface PageHistoryOperationResult {
  status: 'succeeded' | 'failed' | 'partial' | 'moot';
  completedAt: Date;
  detail?: string;
  /** Error code of a failed terminal outcome, so a replay answers with the recorded response instead of re-deciding it. */
  code?: ErrorCode;
  /** Human-readable half of that recorded response. */
  message?: string;
}

export interface PageHistoryOperationDocument extends Document {
  _id: Types.ObjectId;
  /** The user who initiated the command. `null` only for a `system`-sourced operation. */
  actor: Types.ObjectId | null;
  /**
   * Free-form command scope. So far: `'rename'`, `'trash'`, `'restore'`, and
   * subtree rename's pair `'subtree_rename'` (the root record) /
   * `'subtree_rename_member'` (one per page it moves). The member's name is
   * deliberately not `'rename'`: its idempotency key is derived from the root's,
   * so sharing the scope would let a caller's own single-page rename collide
   * with a derived key.
   */
  command: string;
  /** Client-generated `Idempotency-Key` — 16-128 URL-safe characters (RFC §5.3). */
  idempotencyKey: string;
  /** Server-generated opaque operation id, never accepted as a request field. */
  operationId: string;
  /** Fingerprint of the request body, so a same-key replay with a DIFFERENT body is rejected rather than silently resumed. */
  requestFingerprint: string;
  /**
   * Durable command input for a single-Page command (RFC-0021 Phase 2c-2).
   *
   * These carry everything a resumed or replayed execution needs, so recovery
   * never re-derives intent from the Page's current state — by then the Page
   * may already be mid-transition. None of them has a schema default: the
   * command writes the complete set at insert time, and their absence on a row
   * means the row predates single-Page commands rather than "took the default".
   */
  page?: Types.ObjectId;
  fromPath?: string;
  toPath?: string;
  fromStatus?: string | null;
  /**
   * Whether the Page carried a `status` field at all when the command was
   * accepted. A legacy Page has no `status`, and `{ status: undefined }` is
   * dropped on the way to Mongo, so the entering CAS has to pin
   * `{ status: { $exists: false } }` instead of a value — this flag is what
   * tells a resumed execution which of the two to rebuild.
   */
  fromStatusPresent?: boolean;
  toStatus?: string | null;
  createRedirect?: boolean;
  source?: PageHistoryEventSource;
  /** Page ids sealed by a subtree root operation. Absent on member and single-page records. */
  memberPageIds?: Types.ObjectId[];
  /** Event-grouping id shared by every member of a subtree root operation. */
  groupOperationId?: string;
  /** Subtree rename's persisted original target map (RFC §6.5) — absent for a single-Page command. */
  subtreeTargets?: PageHistoryOperationSubtreeTarget[];
  /** Per-Page progress for a multi-Page (subtree) operation, keyed by Page id string. */
  pageStates: Map<string, string>;
  /** Crash-recovery lease — null once the operation reaches a terminal result or before any worker has claimed it. */
  lease: PageHistoryOperationLease | null;
  /** Terminal outcome — null while the operation is still in flight. */
  result: PageHistoryOperationResult | null;
  /** Retry-token nonce this operation's signed `retryToken` binds to (RFC §5.3 — a convenience only; recovery never depends on it). */
  retryTokenNonce?: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// biome-ignore lint/suspicious/noEmptyInterface: Phase 1 adds no statics — Phase 2's command services own the create/lease/resolve helpers.
export interface PageHistoryOperationModel extends Model<PageHistoryOperationDocument> {}

/**
 * RFC §5.3 — 16-128 URL-safe characters. The pattern itself now lives in
 * `@crowi/api-contract` (the contract validates the header and cannot import
 * from `@crowi/api`); re-exported here so the model's existing importers keep
 * one import site.
 */
export { IDEMPOTENCY_KEY_PATTERN };

const leaseSchema = new Schema<PageHistoryOperationLease>(
  {
    owner: { type: String, required: true },
    until: { type: Date, required: true },
  },
  { _id: false },
);

const resultSchema = new Schema<PageHistoryOperationResult>(
  {
    status: { type: String, enum: ['succeeded', 'failed', 'partial', 'moot'], required: true },
    completedAt: { type: Date, required: true },
    detail: { type: String },
    code: { type: String },
    message: { type: String },
  },
  { _id: false },
);

const subtreeTargetSchema = new Schema<PageHistoryOperationSubtreeTarget>(
  {
    pageId: { type: Schema.Types.ObjectId, ref: 'Page', required: true },
    fromPath: { type: String, required: true },
    toPath: { type: String, required: true },
  },
  { _id: false },
);

const pageHistoryOperationSchema = new Schema<PageHistoryOperationDocument, PageHistoryOperationModel>({
  actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  command: { type: String, required: true },
  idempotencyKey: { type: String, required: true, match: IDEMPOTENCY_KEY_PATTERN },
  operationId: { type: String, required: true },
  requestFingerprint: { type: String, required: true },
  // Single-Page command input (Phase 2c-2). No defaults anywhere below: the
  // command writes the complete set, and absence must stay distinguishable
  // from a defaulted value.
  page: { type: Schema.Types.ObjectId, ref: 'Page' },
  fromPath: { type: String },
  toPath: { type: String },
  fromStatus: { type: String },
  fromStatusPresent: { type: Boolean },
  toStatus: { type: String },
  createRedirect: { type: Boolean },
  source: { type: String, enum: PAGE_HISTORY_EVENT_SOURCES },
  memberPageIds: { type: [Schema.Types.ObjectId], ref: 'Page', default: undefined },
  groupOperationId: { type: String },
  subtreeTargets: { type: [subtreeTargetSchema], default: undefined },
  pageStates: { type: Map, of: String, default: () => new Map() },
  lease: { type: leaseSchema, default: null },
  result: { type: resultSchema, default: null },
  retryTokenNonce: { type: String },
  expiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// RFC §5.3/§5.5a — a client's `Idempotency-Key` resolves to exactly one
// durable operation record per (actor, command) scope; a replay with the
// same key returns/resumes that record.
pageHistoryOperationSchema.index(
  { actor: 1, command: 1, idempotencyKey: 1 },
  { unique: true, name: 'pageHistoryOperation_actor_command_idempotencyKey_unique' },
);
// The server-generated operationId is the record's own alternate identity —
// referenced by `PageHistoryEvent.operationId` and `Revision.historyOperationId`.
pageHistoryOperationSchema.index({ operationId: 1 }, { unique: true, name: 'pageHistoryOperation_operationId_unique' });
// RFC §5.3 — "retry-token record id and nonce" are unique: the record id is
// `_id` (already unique by construction); the nonce gets its own sparse
// unique index (sparse: not every record has issued a retryToken yet).
pageHistoryOperationSchema.index({ retryTokenNonce: 1 }, { unique: true, sparse: true, name: 'pageHistoryOperation_retryTokenNonce_unique' });
// Phase 2c-2's repair sweep walks the still-in-flight records (`result: null`)
// in `_id` order and resumes from a caller-supplied cursor, so the sort key has
// to be part of the index — an equality-only index would leave the sort to an
// in-memory pass over every unfinished operation.
pageHistoryOperationSchema.index({ result: 1, _id: 1 }, { name: 'pageHistoryOperation_result_id' });
// TTL — MongoDB removes a row once `expiresAt` is in the past
// (`expireAfterSeconds: 0`). `expiresAt` stays `null` until `completeOperation`
// sets it alongside the terminal `result`, so an in-flight row (still `null`)
// is never a TTL match — only a settled operation's retention deadline is.
pageHistoryOperationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'pageHistoryOperation_expiresAt_ttl' });

export default (_crowi: Crowi) => {
  const PageHistoryOperation = model<PageHistoryOperationDocument, PageHistoryOperationModel>('PageHistoryOperation', pageHistoryOperationSchema);
  return PageHistoryOperation;
};
