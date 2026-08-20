import type { PageHistoryEntry, PageHistoryResponse, PageHistoryTracking, PageUser } from '@crowi/api-contract';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import {
  PAGE_HISTORY_EVENT_KINDS,
  PAGE_HISTORY_EVENT_SOURCES,
  type PageHistoryEventDocument,
  type PageHistoryEventKind,
  type PageHistoryPayloadByKind,
  isValidPageHistoryEventPayload,
} from 'src/models/page-history-event';
import type { RevisionDocument } from 'src/models/revision';
import type { UserDocument, UserModel } from 'src/models/user';

interface CursorBase {
  v: 1;
  pageId: string;
}

interface SequencedCursor extends CursorBase {
  upper: number;
  region: 'sequenced';
  after: { sequence: number; kindRank: 0 | 1; id: string };
  boundary: string;
}

interface ReadyUnsequencedCursor extends CursorBase {
  upper: number;
  region: 'unsequenced';
  after: { createdAt: string; id: string };
  boundary: string;
}

interface UntrackedCursor extends CursorBase {
  upper: null;
  region: 'unsequenced';
  after: { createdAt: string; id: string };
  boundary: null;
}

export type PageHistoryCursor = SequencedCursor | ReadyUnsequencedCursor | UntrackedCursor;

const CURSOR_MAX_BYTES = 512;
const KIND_RANK_EVENT = 1 as const;
const KIND_RANK_CONTENT = 0 as const;
const CURSOR_KEYS = ['after', 'boundary', 'pageId', 'region', 'upper', 'v'];

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
    super(`page history has duplicate sequence ${sequence} for page ${pageId}`);
    this.name = 'PageHistoryCorruptionError';
    this.pageId = pageId;
    this.sequence = sequence;
  }
}

export function encodeCursor(cursor: PageHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

const isRecord = (value: unknown): value is Record<string, unknown> => value != null && typeof value === 'object' && !Array.isArray(value);
const isSafeSequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const isCanonicalObjectId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{24}$/.test(value) && Types.ObjectId.isValid(value);
const isCanonicalDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
};

export function decodeCursor(raw: string, pageId: string): PageHistoryCursor {
  if (raw.length === 0) throw new PageHistoryCursorError('bad length');
  if (raw.length > CURSOR_MAX_BYTES) throw new PageHistoryCursorError('too long');
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new PageHistoryCursorError('not canonical base64url');

  let decoded: Buffer;
  let parsed: unknown;
  try {
    decoded = Buffer.from(raw, 'base64url');
    if (decoded.toString('base64url') !== raw) throw new Error('non-canonical');
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new PageHistoryCursorError('not decodable');
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, CURSOR_KEYS)) throw new PageHistoryCursorError('bad shape');
  if (parsed.v !== 1) throw new PageHistoryCursorError('unsupported version');
  if (!isCanonicalObjectId(parsed.pageId) || parsed.pageId !== pageId) throw new PageHistoryCursorError('page mismatch');
  if (!isRecord(parsed.after)) throw new PageHistoryCursorError('bad after');

  if (parsed.region === 'sequenced') {
    if (!isSafeSequence(parsed.upper)) throw new PageHistoryCursorError('bad upper');
    if (!isCanonicalDate(parsed.boundary)) throw new PageHistoryCursorError('bad boundary');
    if (!hasExactKeys(parsed.after, ['id', 'kindRank', 'sequence'])) throw new PageHistoryCursorError('bad after');
    if (
      !isSafeSequence(parsed.after.sequence) ||
      (parsed.after.kindRank !== KIND_RANK_CONTENT && parsed.after.kindRank !== KIND_RANK_EVENT) ||
      !isCanonicalObjectId(parsed.after.id)
    ) {
      throw new PageHistoryCursorError('bad after');
    }
    return parsed as unknown as SequencedCursor;
  }

  if (parsed.region !== 'unsequenced' || !hasExactKeys(parsed.after, ['createdAt', 'id'])) throw new PageHistoryCursorError('bad region');
  if (!isCanonicalDate(parsed.after.createdAt) || !isCanonicalObjectId(parsed.after.id)) throw new PageHistoryCursorError('bad after');
  if (parsed.boundary === null) {
    if (parsed.upper !== null) throw new PageHistoryCursorError('untracked cursor has upper');
    return parsed as unknown as UntrackedCursor;
  }
  if (!isCanonicalDate(parsed.boundary) || !isSafeSequence(parsed.upper)) throw new PageHistoryCursorError('bad ready bounds');
  return parsed as unknown as ReadyUnsequencedCursor;
}

type EntryWithoutActor = PageHistoryEntry extends infer T ? (T extends PageHistoryEntry ? Omit<T, 'actor'> & { actor: null } : never) : never;

interface MergeRow {
  entry: EntryWithoutActor;
  actorId: Types.ObjectId | null;
  savedById?: Types.ObjectId | null;
  contributorIds?: Types.ObjectId[];
  sortKey: { sequence: number | null; kindRank: 0 | 1; id: string; createdAt: number };
}

interface PageLean {
  historySequence?: number;
  historyTracking?: { state?: string; trackingStartedAt?: Date };
  pendingHistoryEntry?: unknown;
}

interface EventLean
  extends Pick<PageHistoryEventDocument, '_id' | 'page' | 'sequence' | 'kind' | 'actor' | 'occurredAt' | 'operationId' | 'source' | 'payload'> {}

interface RevisionLean extends Pick<RevisionDocument, '_id' | 'createdAt' | 'author' | 'historySequence' | 'savedBy' | 'contributors' | 'editVia'> {}
interface UserLean extends Pick<UserDocument, '_id' | 'username' | 'name' | 'email' | 'image' | 'createdAt' | 'status'> {}

const isEventKind = (value: unknown): value is PageHistoryEventKind =>
  typeof value === 'string' && (PAGE_HISTORY_EVENT_KINDS as readonly string[]).includes(value);

export function projectPendingEntry(pending: unknown, expectedPageId: Types.ObjectId | string): MergeRow | null {
  if (!isRecord(pending) || pending.type !== 'page_event' || !isRecord(pending.event)) return null;
  const event = pending.event;
  if (
    !isCanonicalObjectId(String(event._id ?? '')) ||
    !isCanonicalObjectId(String(event.page ?? '')) ||
    String(event.page) !== String(expectedPageId) ||
    !isSafeSequence(event.sequence) ||
    !isEventKind(event.kind) ||
    typeof event.operationId !== 'string' ||
    event.operationId.length === 0 ||
    typeof event.source !== 'string' ||
    !(PAGE_HISTORY_EVENT_SOURCES as readonly string[]).includes(event.source) ||
    !isValidPageHistoryEventPayload(event.kind, event.payload)
  ) {
    return null;
  }
  if (event.actor !== null && event.actor !== undefined && !Types.ObjectId.isValid(String(event.actor))) return null;
  const occurredAt = event.occurredAt instanceof Date ? event.occurredAt : new Date(String(event.occurredAt));
  if (Number.isNaN(occurredAt.getTime())) return null;

  const id = String(event._id);
  const payload = event.payload as PageHistoryPayloadByKind[PageHistoryEventKind];
  return {
    entry: {
      type: 'page_event',
      id,
      sequence: event.sequence,
      occurredAt: occurredAt.toISOString(),
      actor: null,
      kind: event.kind,
      payload,
      operationId: event.operationId,
      pending: true,
      ...('subtree' in payload && payload.subtree === true ? { subtree: true } : {}),
    },
    actorId: event.actor == null ? null : new Types.ObjectId(String(event.actor)),
    sortKey: { sequence: event.sequence, kindRank: KIND_RANK_EVENT, id, createdAt: occurredAt.getTime() },
  };
}

const compareSequenced = (a: MergeRow, b: MergeRow): number =>
  (b.sortKey.sequence ?? 0) - (a.sortKey.sequence ?? 0) || b.sortKey.kindRank - a.sortKey.kindRank || (a.sortKey.id < b.sortKey.id ? 1 : -1);
const compareUnsequenced = (a: MergeRow, b: MergeRow): number => b.sortKey.createdAt - a.sortKey.createdAt || (a.sortKey.id < b.sortKey.id ? 1 : -1);

function isAfter(row: MergeRow, after: PageHistoryCursor['after'], sequenced: boolean): boolean {
  if (sequenced && 'sequence' in after) {
    if ((row.sortKey.sequence ?? 0) !== after.sequence) return (row.sortKey.sequence ?? 0) < after.sequence;
    if (row.sortKey.kindRank !== after.kindRank) return row.sortKey.kindRank < after.kindRank;
    return row.sortKey.id < after.id;
  }
  if (!sequenced && 'createdAt' in after) {
    const createdAt = new Date(after.createdAt).getTime();
    if (row.sortKey.createdAt !== createdAt) return row.sortKey.createdAt < createdAt;
    return row.sortKey.id < after.id;
  }
  return false;
}

export function mergeTimeline(
  rows: MergeRow[],
  options: { sequenced: boolean; upper: number | null; cursor: PageHistoryCursor | null; limit: number; pageId: string },
): { window: MergeRow[]; hasMore: boolean } {
  const after = options.cursor?.after;
  const sorted = rows
    .filter((row) => !options.sequenced || row.sortKey.sequence == null || (options.upper != null && row.sortKey.sequence <= options.upper))
    .filter((row) => after == null || isAfter(row, after, options.sequenced))
    .sort(options.sequenced ? compareSequenced : compareUnsequenced);

  if (options.sequenced) {
    const seen = new Map<number, string>();
    for (const row of sorted) {
      if (row.sortKey.sequence == null) continue;
      const previous = seen.get(row.sortKey.sequence);
      if (previous != null && previous !== row.sortKey.id) throw new PageHistoryCorruptionError(options.pageId, row.sortKey.sequence);
      seen.set(row.sortKey.sequence, row.sortKey.id);
    }
  }
  return { window: sorted.slice(0, options.limit), hasMore: sorted.length > options.limit };
}

export interface ReadPageHistoryOptions {
  pageId: Types.ObjectId;
  limit: number;
  cursor: PageHistoryCursor | null;
}

const sequencedAfter = (cursor: SequencedCursor, rank: 0 | 1, field: 'sequence' | 'historySequence'): Record<string, unknown> => {
  const sameSequence =
    rank < cursor.after.kindRank
      ? { [field]: cursor.after.sequence }
      : rank === cursor.after.kindRank
        ? { [field]: cursor.after.sequence, _id: { $lt: new Types.ObjectId(cursor.after.id) } }
        : null;
  return {
    $or: [{ [field]: { $lt: cursor.after.sequence } }, ...(sameSequence == null ? [] : [sameSequence])],
  };
};

const unsequencedAfter = (cursor: ReadyUnsequencedCursor | UntrackedCursor): Record<string, unknown> => ({
  $or: [
    { createdAt: { $lt: new Date(cursor.after.createdAt) } },
    { createdAt: new Date(cursor.after.createdAt), _id: { $lt: new Types.ObjectId(cursor.after.id) } },
  ],
});

export async function readPageHistory(crowi: Crowi, options: ReadPageHistoryOptions): Promise<PageHistoryResponse> {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const PageHistoryEvent = crowi.model('PageHistoryEvent');
  const User = crowi.model('User');
  const pageIdString = String(options.pageId);
  const page = (await Page.findById(options.pageId).select('historySequence historyTracking pendingHistoryEntry').lean().exec()) as PageLean | null;
  if (page == null) return { entries: [], nextCursor: null, tracking: { state: 'untracked' } };

  const startedAt = page.historyTracking?.state === 'ready' ? page.historyTracking.trackingStartedAt : undefined;
  const readyWalk = options.cursor?.boundary != null || (options.cursor == null && startedAt != null);
  const boundary = options.cursor?.boundary != null ? new Date(options.cursor.boundary) : startedAt;
  const upper = readyWalk ? (options.cursor?.upper ?? page.historySequence ?? 0) : null;
  const region = options.cursor?.region ?? (readyWalk ? 'sequenced' : 'unsequenced');
  const fetchLimit = options.limit + 1;

  const sequencedRows: MergeRow[] = [];
  if (readyWalk && boundary != null && upper != null && region === 'sequenced') {
    let settledPending: MergeRow | null = null;
    const pending =
      isRecord(page.pendingHistoryEntry) && page.pendingHistoryEntry.type === 'page_event' && isRecord(page.pendingHistoryEntry.event)
        ? page.pendingHistoryEntry.event
        : null;
    if (pending != null && Types.ObjectId.isValid(String(pending._id ?? ''))) {
      const durable = (await PageHistoryEvent.findOne({ _id: new Types.ObjectId(String(pending._id)), page: options.pageId })
        .select('_id page sequence kind actor occurredAt operationId source payload')
        .lean()
        .exec()) as EventLean | null;
      settledPending = durable == null ? projectPendingEntry(page.pendingHistoryEntry, options.pageId) : eventRow(durable);
    } else {
      settledPending = projectPendingEntry(page.pendingHistoryEntry, options.pageId);
    }

    const continuation = options.cursor?.region === 'sequenced' ? options.cursor : null;
    const eventFilter: Record<string, unknown> = { page: options.pageId, sequence: { $lte: upper } };
    const revisionFilter: Record<string, unknown> = { page: options.pageId, historySequence: { $ne: null, $lte: upper } };
    if (continuation != null) {
      Object.assign(eventFilter, sequencedAfter(continuation, KIND_RANK_EVENT, 'sequence'));
      Object.assign(revisionFilter, sequencedAfter(continuation, KIND_RANK_CONTENT, 'historySequence'));
    }

    const [events, revisions] = await Promise.all([
      PageHistoryEvent.find(eventFilter)
        .select('_id page sequence kind actor occurredAt operationId source payload')
        .sort({ sequence: -1, _id: -1 })
        .limit(fetchLimit)
        .lean()
        .exec() as Promise<EventLean[]>,
      Revision.find(revisionFilter)
        .select('_id createdAt author historySequence savedBy contributors editVia')
        .sort({ historySequence: -1, _id: -1 })
        .limit(fetchLimit)
        .lean()
        .exec() as Promise<RevisionLean[]>,
    ]);
    sequencedRows.push(...events.map(eventRow), ...revisions.map((revision) => contentRow(revision, revision.historySequence ?? null)));
    if (settledPending != null && !sequencedRows.some((row) => row.entry.type === 'page_event' && row.sortKey.id === settledPending?.sortKey.id)) {
      sequencedRows.push(settledPending);
    }
  }

  const sequencedWindow = mergeTimeline(sequencedRows, {
    sequenced: true,
    upper,
    cursor: region === 'sequenced' ? options.cursor : null,
    limit: fetchLimit,
    pageId: pageIdString,
  }).window;

  const unsequencedFilter: Record<string, unknown> = { page: options.pageId };
  if (readyWalk && boundary != null) {
    unsequencedFilter.historySequence = null;
    unsequencedFilter.createdAt = { $lt: boundary };
  }
  if (options.cursor?.region === 'unsequenced') Object.assign(unsequencedFilter, unsequencedAfter(options.cursor));
  const revisions = (await Revision.find(unsequencedFilter)
    .select('_id createdAt author savedBy contributors editVia')
    .sort({ createdAt: -1, _id: -1 })
    .limit(fetchLimit)
    .lean()
    .exec()) as RevisionLean[];
  const unsequencedRows = revisions.map((revision) => contentRow(revision, null)).sort(compareUnsequenced);

  const combined = region === 'unsequenced' ? unsequencedRows : [...sequencedWindow, ...unsequencedRows];
  const window = combined.slice(0, options.limit);
  const hasMore = combined.length > options.limit;

  const actorIds = Array.from(
    new Set(
      window
        .flatMap((row) => [row.actorId, row.savedById, ...(row.contributorIds ?? [])])
        .filter((id): id is Types.ObjectId => id != null)
        .map(String),
    ),
  );
  const actors = new Map<string, PageUser | null>();
  if (actorIds.length > 0) {
    const users = (await User.find({ _id: { $in: actorIds } })
      .select('_id username name email image createdAt status')
      .lean()
      .exec()) as UserLean[];
    for (const user of users) actors.set(String(user._id), toActor(user, User));
  }

  const entries = window.map((row) => {
    const actor = row.actorId == null ? null : (actors.get(String(row.actorId)) ?? null);
    if (row.entry.type === 'page_event') return { ...row.entry, actor };

    const savedBy = row.savedById === undefined ? undefined : row.savedById === null ? null : (actors.get(String(row.savedById)) ?? null);
    const contributors = row.contributorIds?.map((id) => actors.get(String(id)) ?? null).filter((user): user is PageUser => user != null);
    return {
      ...row.entry,
      actor,
      ...(row.savedById !== undefined ? { savedBy } : {}),
      ...(row.contributorIds !== undefined ? { contributors: contributors ?? [] } : {}),
    };
  }) as PageHistoryEntry[];

  const last = window.at(-1);
  let nextCursor: string | null = null;
  if (hasMore && last != null) {
    const common = { v: 1 as const, pageId: pageIdString };
    if (last.sortKey.sequence != null && readyWalk && boundary != null && upper != null) {
      nextCursor = encodeCursor({
        ...common,
        upper,
        region: 'sequenced',
        boundary: boundary.toISOString(),
        after: { sequence: last.sortKey.sequence, kindRank: last.sortKey.kindRank, id: last.sortKey.id },
      });
    } else {
      nextCursor = encodeCursor({
        ...common,
        upper: readyWalk && upper != null ? upper : null,
        region: 'unsequenced',
        boundary: readyWalk && boundary != null ? boundary.toISOString() : null,
        after: { createdAt: new Date(last.sortKey.createdAt).toISOString(), id: last.sortKey.id },
      } as ReadyUnsequencedCursor | UntrackedCursor);
    }
  }

  const tracking: PageHistoryTracking = readyWalk && boundary != null ? { state: 'ready', trackingStartedAt: boundary.toISOString() } : { state: 'untracked' };
  return { entries, nextCursor, tracking };
}

function eventRow(event: EventLean): MergeRow {
  const id = String(event._id);
  const occurredAt = event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt);
  return {
    entry: {
      type: 'page_event',
      id,
      sequence: event.sequence,
      occurredAt: occurredAt.toISOString(),
      actor: null,
      kind: event.kind,
      payload: event.payload,
      operationId: event.operationId,
      ...('subtree' in event.payload && event.payload.subtree === true ? { subtree: true } : {}),
    },
    actorId: event.actor ?? null,
    sortKey: { sequence: event.sequence, kindRank: KIND_RANK_EVENT, id, createdAt: occurredAt.getTime() },
  };
}

function contentRow(revision: RevisionLean, sequence: number | null): MergeRow {
  const id = String(revision._id);
  const createdAt = revision.createdAt instanceof Date ? revision.createdAt : new Date(revision.createdAt);
  return {
    entry: {
      type: 'content_revision',
      id,
      sequence,
      occurredAt: createdAt.toISOString(),
      actor: null,
      revisionId: id,
      ...(revision.editVia !== undefined ? { editVia: revision.editVia } : {}),
    },
    actorId: revision.author ?? null,
    savedById: revision.savedBy === undefined ? undefined : (revision.savedBy ?? null),
    contributorIds: revision.contributors === undefined ? undefined : revision.contributors,
    sortKey: { sequence, kindRank: KIND_RANK_CONTENT, id, createdAt: createdAt.getTime() },
  };
}

function toActor(user: UserLean, User: UserModel): PageUser | null {
  if (user.status === User.STATUS_DELETED || user.status === User.STATUS_SUSPENDED) return null;
  return {
    _id: String(user._id),
    id: String(user._id),
    username: user.username,
    name: user.name,
    email: user.email,
    image: user.image || null,
    createdAt: (user.createdAt instanceof Date ? user.createdAt : new Date(user.createdAt)).toISOString(),
  };
}
