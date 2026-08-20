import type { PageHistoryEntry, PageHistoryResponse, PageHistoryTracking, PageUser } from '@crowi/api-contract';
import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import { PAGE_HISTORY_EVENT_KINDS, type PageHistoryEventKind } from 'src/models/page-history-event';

/**
 * RFC-0021 Phase 3 — reading a page's content revisions and metadata events as
 * one timeline.
 *
 * The page is split by its tracking boundary. Above it, rows carry a page-local
 * `historySequence` and are ordered by it. Below it are older revisions written
 * before the page began recording history; they have no sequence at all and are
 * ordered by time. An untracked page has no boundary and is entirely the second
 * case.
 *
 * This module never writes. In particular it does NOT materialize the page's
 * outbox — a read that repairs would make every viewer a writer, and the same
 * marker would be projected differently depending on who looked first.
 */

/** How far a caller has walked. Opaque on the wire, strictly validated on the way back in. */
export interface PageHistoryCursor {
  v: 1;
  /** Binds the cursor to one page. A cursor presented against a different page is a client bug, not a permission to read that page. */
  pageId: string;
  /** Frozen at the first request so rows written mid-walk cannot appear in later pages. */
  upper: number | null;
  /** Which half of the timeline the next page starts in. */
  region: 'sequenced' | 'unsequenced';
  /** Last row consumed, in the ordering of its own region. */
  after: { sequence: number; kindRank: number; id: string } | { createdAt: string; id: string };
  /** `null` when the page is untracked. */
  boundary: string | null;
}

const CURSOR_MAX_BYTES = 512;

/** Events sort ahead of content at the same sequence. Not a semantic claim — a deterministic tie-break so a corrupted duplicate cannot reorder between requests. */
const KIND_RANK_EVENT = 1;
const KIND_RANK_CONTENT = 0;

export class PageHistoryCursorError extends Error {
  constructor(reason: string) {
    super(`invalid cursor: ${reason}`);
    this.name = 'PageHistoryCursorError';
  }
}

export class PageHistoryCorruptionError extends Error {
  readonly pageId: string;
  readonly sequence: number;

  constructor(pageId: string, sequence: number) {
    // The identifiers are the point — an operator has to be able to run the
    // repair against this page. No page content or configuration goes in.
    super(`page history has duplicate sequence ${sequence} for page ${pageId}`);
    this.name = 'PageHistoryCorruptionError';
    this.pageId = pageId;
    this.sequence = sequence;
  }
}

export function encodeCursor(cursor: PageHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

const isSafeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

/**
 * Decode and validate a cursor.
 *
 * Deliberately unsigned: the contents are not secret, and a forged cursor can
 * only move the reader around inside a page they are already authorized for,
 * doing at most `limit` rows of work. Validation is strict all the same, so a
 * malformed one fails loudly at the boundary instead of producing a nonsense
 * query deeper in.
 */
export function decodeCursor(raw: string, pageId: string): PageHistoryCursor {
  if (raw.length > CURSOR_MAX_BYTES) throw new PageHistoryCursorError('too long');

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new PageHistoryCursorError('not decodable');
  }
  if (parsed == null || typeof parsed !== 'object') throw new PageHistoryCursorError('not an object');

  const c = parsed as Record<string, unknown>;
  if (c.v !== 1) throw new PageHistoryCursorError('unsupported version');
  if (typeof c.pageId !== 'string') throw new PageHistoryCursorError('missing page');
  // A cursor for another page is refused rather than honoured: authorization is
  // re-checked per request against the REQUESTED page, so following the
  // cursor's page instead would read something nobody checked.
  if (c.pageId !== pageId) throw new PageHistoryCursorError('page mismatch');
  if (c.upper !== null && !isSafeInt(c.upper)) throw new PageHistoryCursorError('bad upper');
  if (c.region !== 'sequenced' && c.region !== 'unsequenced') throw new PageHistoryCursorError('bad region');
  if (c.boundary !== null && typeof c.boundary !== 'string') throw new PageHistoryCursorError('bad boundary');

  const after = c.after as Record<string, unknown> | undefined;
  if (after == null || typeof after !== 'object') throw new PageHistoryCursorError('bad after');
  if (c.region === 'sequenced') {
    if (!isSafeInt(after.sequence) || !isSafeInt(after.kindRank) || typeof after.id !== 'string') throw new PageHistoryCursorError('bad after');
  } else if (typeof after.createdAt !== 'string' || typeof after.id !== 'string') {
    throw new PageHistoryCursorError('bad after');
  }

  return c as unknown as PageHistoryCursor;
}

/**
 * The shape the merge works with, before actors are resolved.
 *
 * `entry` keeps the discriminated union intact — distributing the omit is what
 * preserves it; a bare `Omit` over the union collapses to the common fields and
 * loses `kind` / `revisionId`.
 */
type EntryWithoutActor = PageHistoryEntry extends infer T ? (T extends PageHistoryEntry ? Omit<T, 'actor'> & { actor: null } : never) : never;

interface MergeRow {
  entry: EntryWithoutActor;
  actorId: Types.ObjectId | null;
  sortKey: { sequence: number | null; kindRank: number; id: string; createdAt: number };
}

const isEventKind = (value: unknown): value is PageHistoryEventKind =>
  typeof value === 'string' && (PAGE_HISTORY_EVENT_KINDS as readonly string[]).includes(value);

/**
 * Turn a page's outbox marker into a row, WITHOUT materializing it.
 *
 * A marker that fails the same validation the writer applies is skipped rather
 * than surfaced: it is an entry no writer will ever be able to land, and
 * rendering it would show a reader an event that is not going to happen.
 */
export function projectPendingEntry(pending: unknown): MergeRow | null {
  const entry = pending as { type?: unknown; event?: Record<string, unknown> } | null | undefined;
  if (entry == null || entry.type !== 'page_event') return null;

  const event = entry.event;
  if (event == null || typeof event !== 'object') return null;
  if (!isEventKind(event.kind)) return null;
  if (!isSafeInt(event.sequence)) return null;
  if (event.payload == null || typeof event.payload !== 'object') return null;

  const occurredAt = event.occurredAt instanceof Date ? event.occurredAt : new Date(String(event.occurredAt));
  if (Number.isNaN(occurredAt.getTime())) return null;

  const id = String(event._id ?? '');
  if (id === '') return null;

  return {
    entry: {
      type: 'page_event',
      id,
      sequence: event.sequence as number,
      occurredAt: occurredAt.toISOString(),
      actor: null,
      kind: event.kind,
      payload: event.payload as Record<string, unknown>,
      operationId: typeof event.operationId === 'string' ? event.operationId : null,
      pending: true,
    },
    actorId: event.actor instanceof Types.ObjectId ? event.actor : null,
    sortKey: { sequence: event.sequence as number, kindRank: KIND_RANK_EVENT, id, createdAt: occurredAt.getTime() },
  };
}

const compareSequenced = (a: MergeRow, b: MergeRow): number =>
  (b.sortKey.sequence ?? 0) - (a.sortKey.sequence ?? 0) || b.sortKey.kindRank - a.sortKey.kindRank || (a.sortKey.id < b.sortKey.id ? 1 : -1);

const compareUnsequenced = (a: MergeRow, b: MergeRow): number => b.sortKey.createdAt - a.sortKey.createdAt || (a.sortKey.id < b.sortKey.id ? 1 : -1);

/**
 * Merge the two regions and cut the requested window.
 *
 * The `upper` bound and the cursor are applied to the SETTLED rows, after
 * projection — a pending marker's own sequence is not what ends up durable, so
 * filtering on it would let a row skip past the cursor or slip in above the
 * frozen bound.
 */
export function mergeTimeline(
  rows: MergeRow[],
  options: { sequenced: boolean; upper: number | null; cursor: PageHistoryCursor | null; limit: number; pageId: string },
): { window: MergeRow[]; hasMore: boolean } {
  const bounded = rows.filter((row) => {
    if (!options.sequenced) return true;
    const seq = row.sortKey.sequence;
    if (seq == null) return true;
    return options.upper == null || seq <= options.upper;
  });

  const sorted = bounded.sort(options.sequenced ? compareSequenced : compareUnsequenced);

  // Duplicate detection is scoped to the window on purpose: `{page, sequence}`
  // is unique within events but cannot be enforced across events AND
  // revisions, and re-checking the whole history on every read would make a
  // page's cost grow with its age.
  if (options.sequenced) {
    const seen = new Map<number, string>();
    for (const row of sorted) {
      const seq = row.sortKey.sequence;
      if (seq == null) continue;
      const previous = seen.get(seq);
      if (previous != null && previous !== row.sortKey.id) throw new PageHistoryCorruptionError(options.pageId, seq);
      seen.set(seq, row.sortKey.id);
    }
  }

  const after = options.cursor?.after;
  const remaining = after == null ? sorted : sorted.filter((row) => isAfter(row, after, options.sequenced));

  return { window: remaining.slice(0, options.limit), hasMore: remaining.length > options.limit };
}

function isAfter(row: MergeRow, after: PageHistoryCursor['after'], sequenced: boolean): boolean {
  if (sequenced && 'sequence' in after) {
    if ((row.sortKey.sequence ?? 0) !== after.sequence) return (row.sortKey.sequence ?? 0) < after.sequence;
    if (row.sortKey.kindRank !== after.kindRank) return row.sortKey.kindRank < after.kindRank;
    return row.sortKey.id < after.id;
  }
  if (!sequenced && 'createdAt' in after) {
    const boundary = new Date(after.createdAt).getTime();
    if (row.sortKey.createdAt !== boundary) return row.sortKey.createdAt < boundary;
    return row.sortKey.id < after.id;
  }
  return false;
}

export interface ReadPageHistoryOptions {
  pageId: Types.ObjectId;
  limit: number;
  cursor: PageHistoryCursor | null;
}

export async function readPageHistory(crowi: Crowi, options: ReadPageHistoryOptions): Promise<PageHistoryResponse> {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const PageHistoryEvent = crowi.model('PageHistoryEvent');
  const User = crowi.model('User');
  const pageIdString = String(options.pageId);

  const page = (await Page.findById(options.pageId).select('historySequence historyTracking pendingHistoryEntry').lean().exec()) as {
    historySequence?: number;
    historyTracking?: { state?: string; trackingStartedAt?: Date };
    pendingHistoryEntry?: unknown;
  } | null;
  if (page == null) return { entries: [], nextCursor: null, tracking: { state: 'untracked' } };

  // A boundary needs BOTH a ready state and a recorded start. `migrating` is a
  // retired value, and a ready page missing its start is damaged — neither is a
  // reason to refuse the read, so both fall back to time ordering. Failing here
  // would leave the page's history unreachable with no way to get it back.
  const startedAt = page.historyTracking?.state === 'ready' ? page.historyTracking.trackingStartedAt : undefined;
  const sequenced = options.cursor != null ? options.cursor.boundary != null : startedAt != null;
  const boundary = options.cursor?.boundary != null ? new Date(options.cursor.boundary) : startedAt;
  const upper = options.cursor != null ? options.cursor.upper : (page.historySequence ?? null);

  const fetchLimit = options.limit + 1;
  const rows: MergeRow[] = [];

  if (sequenced && boundary != null) {
    const [events, revisions] = await Promise.all([
      PageHistoryEvent.find({ page: options.pageId, ...(upper == null ? {} : { sequence: { $lte: upper } }) })
        .sort({ sequence: -1, _id: -1 })
        .limit(fetchLimit)
        .lean()
        .exec(),
      Revision.find({ page: options.pageId, historySequence: { $ne: null, ...(upper == null ? {} : { $lte: upper }) } })
        .select('_id createdAt author historySequence')
        .sort({ historySequence: -1, _id: -1 })
        .limit(fetchLimit)
        .lean()
        .exec(),
    ]);
    for (const e of events as Record<string, any>[]) rows.push(eventRow(e));
    for (const r of revisions as Record<string, any>[]) rows.push(contentRow(r, r.historySequence ?? null));

    // The region BELOW the boundary: revisions written before this page began
    // recording history. They carry no sequence and are ordered by time, so
    // they are fetched separately and merged in after the sequenced rows.
    // `$lt` — a revision stamped at exactly the boundary belongs above it, and
    // the repair scan already treats that instant as "should have a sequence".
    const belowBoundary = (await Revision.find({ page: options.pageId, historySequence: null, createdAt: { $lt: boundary } })
      .select('_id createdAt author')
      .sort({ createdAt: -1, _id: -1 })
      .limit(fetchLimit)
      .lean()
      .exec()) as Record<string, any>[];
    for (const r of belowBoundary) rows.push(contentRow(r, null));

    const projected = projectPendingEntry(page.pendingHistoryEntry);
    // Dedupe by the underlying id: while a marker is draining, the same event
    // can be visible both as the marker and as its durable row.
    if (projected != null && !rows.some((row) => row.sortKey.id === projected.sortKey.id)) rows.push(projected);
  } else {
    const revisions = (await Revision.find({ page: options.pageId })
      .select('_id createdAt author')
      .sort({ createdAt: -1, _id: -1 })
      .limit(fetchLimit)
      .lean()
      .exec()) as Record<string, any>[];
    // Reported as `null` regardless of any stored value: this response decided
    // it was untracked, and a concurrent promotion must not make half of it
    // claim a position the rest does not have.
    for (const r of revisions) rows.push(contentRow(r, null));
  }

  const { window, hasMore } = mergeTimeline(rows, { sequenced, upper, cursor: options.cursor, limit: options.limit, pageId: pageIdString });

  // One query for every actor in the window — resolving per row would scale
  // with the page size.
  const actorIds = Array.from(new Set(window.map((row) => row.actorId).filter((id): id is Types.ObjectId => id != null))).map(String);
  const actors = new Map<string, PageUser | null>();
  if (actorIds.length > 0) {
    const users = (await User.find({ _id: { $in: actorIds } })
      .select('_id username name email image createdAt status')
      .lean()
      .exec()) as Record<string, any>[];
    for (const u of users) actors.set(String(u._id), toActor(u, User));
  }

  const entries = window.map((row) => ({
    ...row.entry,
    actor: row.actorId == null ? null : (actors.get(String(row.actorId)) ?? null),
  })) as PageHistoryEntry[];

  const last = window.at(-1);
  const nextCursor =
    hasMore && last != null
      ? encodeCursor({
          v: 1,
          pageId: pageIdString,
          upper,
          region: sequenced ? 'sequenced' : 'unsequenced',
          boundary: sequenced && boundary != null ? boundary.toISOString() : null,
          after: sequenced
            ? { sequence: last.sortKey.sequence ?? 0, kindRank: last.sortKey.kindRank, id: last.sortKey.id }
            : { createdAt: new Date(last.sortKey.createdAt).toISOString(), id: last.sortKey.id },
        })
      : null;

  const tracking: PageHistoryTracking = sequenced && boundary != null ? { state: 'ready', trackingStartedAt: boundary.toISOString() } : { state: 'untracked' };

  return { entries, nextCursor, tracking };
}

function eventRow(e: Record<string, any>): MergeRow {
  const id = String(e._id);
  const occurredAt: Date = e.occurredAt instanceof Date ? e.occurredAt : new Date(e.occurredAt);
  return {
    entry: {
      type: 'page_event',
      id,
      sequence: e.sequence ?? null,
      occurredAt: occurredAt.toISOString(),
      actor: null,
      kind: e.kind,
      payload: e.payload ?? {},
      operationId: e.operationId ?? null,
      ...(e.payload?.subtree === true ? { subtree: true } : {}),
    },
    actorId: e.actor ?? null,
    sortKey: { sequence: e.sequence ?? null, kindRank: KIND_RANK_EVENT, id, createdAt: occurredAt.getTime() },
  };
}

function contentRow(r: Record<string, any>, sequence: number | null): MergeRow {
  const id = String(r._id);
  const createdAt: Date = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
  return {
    entry: {
      type: 'content_revision',
      id,
      sequence,
      occurredAt: createdAt.toISOString(),
      actor: null,
      revisionId: id,
    },
    actorId: r.author ?? null,
    sortKey: { sequence, kindRank: KIND_RANK_CONTENT, id, createdAt: createdAt.getTime() },
  };
}

/**
 * A departed user keeps their `name` — deletion only tombstones the username
 * and email — so resolving them naively would keep publishing that name in
 * every history view. Suspended accounts are treated the same way. The row
 * itself stays: losing the actor is not a reason to lose the fact.
 */
function toActor(u: Record<string, any>, User: any): PageUser | null {
  if (u.status === User.STATUS_DELETED || u.status === User.STATUS_SUSPENDED) return null;
  return {
    _id: String(u._id),
    id: String(u._id),
    username: u.username,
    name: u.name,
    email: u.email,
    image: u.image || null,
    createdAt: (u.createdAt instanceof Date ? u.createdAt : new Date(u.createdAt)).toISOString(),
  };
}
