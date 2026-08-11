import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';

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
  status: 'succeeded' | 'failed' | 'partial';
  completedAt: Date;
  detail?: string;
}

export interface PageHistoryOperationDocument extends Document {
  _id: Types.ObjectId;
  /** The user who initiated the command. `null` only for a `system`-sourced operation. */
  actor: Types.ObjectId | null;
  /** Free-form command scope (e.g. `'rename'`, `'grant'`, `'trash'`) — Phase 2 defines the concrete set. */
  command: string;
  /** Client-generated `Idempotency-Key` — 16-128 URL-safe characters (RFC §5.3). */
  idempotencyKey: string;
  /** Server-generated opaque operation id, never accepted as a request field. */
  operationId: string;
  /** Fingerprint of the request body, so a same-key replay with a DIFFERENT body is rejected rather than silently resumed. */
  requestFingerprint: string;
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

/** RFC §5.3 — 16-128 URL-safe characters. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const leaseSchema = new Schema<PageHistoryOperationLease>(
  {
    owner: { type: String, required: true },
    until: { type: Date, required: true },
  },
  { _id: false },
);

const resultSchema = new Schema<PageHistoryOperationResult>(
  {
    status: { type: String, enum: ['succeeded', 'failed', 'partial'], required: true },
    completedAt: { type: Date, required: true },
    detail: { type: String },
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

export default (_crowi: Crowi) => {
  const PageHistoryOperation = model<PageHistoryOperationDocument, PageHistoryOperationModel>('PageHistoryOperation', pageHistoryOperationSchema);
  return PageHistoryOperation;
};
