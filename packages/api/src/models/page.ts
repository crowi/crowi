import type { PageUser } from '@crowi/api-contract';
import type { InvalidateReason } from '@crowi/collab';
import Debug from 'debug';
import { Document, Model, model, Schema, Types } from 'mongoose';
import Crowi from 'src/crowi';
import { changePageVisibility } from 'src/service/page-history/commands/visibility';
import { allocateContentSequence } from 'src/service/page-history/content-sequence';
import { purgePageHistoryEvents } from 'src/service/page-history/purge';
import { escapeRegExp } from 'src/util/regex';
import { type PopulatedUser, toISOStringOrNull, toPageUser, toStringId } from 'src/util/ts-rest-helpers';
import {
  PAGE_HISTORY_EVENT_KINDS,
  PAGE_HISTORY_EVENT_SOURCES,
  type PageHistoryEventKind,
  type PageHistoryEventSource,
  type PageHistoryPayloadByKind,
  pageHistoryEventPayloadSchema,
} from './page-history-event';
// Split into their own leaf module (feature-page-history-phase1-model) so
// `page-history-event.ts` can depend on `GRANTS` without a page.ts <->
// page-history-event.ts import cycle — see `page-grants.ts`'s doc comment
// for why the cycle matters (a `tsx`-run entry point throws a TDZ
// `ReferenceError` on it; `ts-jest` silently tolerated it). Imported (for
// this file's own use) AND re-exported below unchanged, so every existing
// `from 'src/models/page'` import site keeps working.
import { GRANT_OWNER, GRANT_PUBLIC, GRANT_RESTRICTED, GRANT_SPECIFIED, GRANTS, PAGE_GRANT_ERROR } from './page-grants';
import { RevisionDocument } from './revision';
import { UserDocument } from './user';

export { GRANT_OWNER, GRANT_PUBLIC, GRANT_RESTRICTED, GRANT_SPECIFIED, GRANTS, PAGE_GRANT_ERROR };

export const STATUS_WIP = 'wip';
export const STATUS_PUBLISHED = 'published';
export const STATUS_DELETED = 'deleted';
export const STATUS_DEPRECATED = 'deprecated';
/**
 * RFC-0004: first-class draft state. A page created via `POST
 * /api/pages/drafts` (Phase 3) starts as `draft` and transitions to
 * `published` exactly once when the author first saves. The transition
 * is one-way — there is no path back to `draft`. Draft pages are
 * visible only to their author: listing / search / backlink queries
 * exclude other users' drafts (see `findListByStartWith` /
 * `findListByCreator`), and collab WebSocket connections to a draft
 * page are rejected for non-authors (see `routes/ts-rest/page-collab.ts`
 * + `@crowi/collab` `onAuthenticate`).
 */
export const STATUS_DRAFT = 'draft';
export const STATUSES = [STATUS_WIP, STATUS_PUBLISHED, STATUS_DELETED, STATUS_DEPRECATED, STATUS_DRAFT] as const;

/**
 * A user's home page (`/user/<username>`). Its path is bound to the
 * username, so it can be neither renamed nor deleted (it is also not a
 * valid rename *destination*). Tolerates an optional trailing slash for
 * defence-in-depth. Deeper pages under the home (`/user/<name>/memo`)
 * are normal pages and are NOT matched. Shared by `isDeletableName` /
 * `isRenamableName` so the two guards never drift; mirrors the web
 * `isUserHomePath`.
 */
export const USER_HOME_PAGE_PATH = /^\/user\/[^/]+\/?$/;

/**
 * `$or` status clause for "pages visible to a given viewer" (RFC-0004):
 * published and legacy-null pages are always visible; a `draft` page is
 * visible only to its creator.
 *
 * When the surrounding query is already pinned to a single `creator`,
 * pass that as `creatorId` — the draft clause is then a bare
 * `{ status: 'draft' }`, included only when `viewerId === creatorId`.
 * When the query spans multiple creators, omit `creatorId` — the draft
 * clause carries its own `creator: viewerId` constraint.
 */
export function visiblePageStatusOr(viewerId: Types.ObjectId | string, creatorId?: Types.ObjectId | string): Array<Record<string, unknown>> {
  const or: Array<Record<string, unknown>> = [{ status: null }, { status: STATUS_PUBLISHED }];
  if (creatorId === undefined) {
    or.push({ status: STATUS_DRAFT, creator: viewerId });
  } else if (String(viewerId) === String(creatorId)) {
    or.push({ status: STATUS_DRAFT });
  }
  return or;
}
/**
 * `$or` grant clause for "pages readable by a given user": public and
 * legacy-null pages are always readable; restricted / specified / owner
 * pages only when the user is in `grantedUsers`; the page's creator can
 * always read it regardless of `grantedUsers` membership (kept in sync
 * with the in-memory `isGrantedFor` rule below).
 */
export function visiblePageGrantOr(userId: Types.ObjectId | string): Array<Record<string, unknown>> {
  return [
    { grant: null },
    { grant: GRANT_PUBLIC },
    { grant: GRANT_RESTRICTED, grantedUsers: userId },
    { grant: GRANT_SPECIFIED, grantedUsers: userId },
    { grant: GRANT_OWNER, grantedUsers: userId },
    { creator: userId },
  ];
}

/**
 * Match conditions for "pages authored by `creatorId` that `viewerId` can
 * see" — the profile "created pages" set. `findListByCreator` builds its
 * `find()` from this; callers that need an accurate *count* of the same set
 * (`GET /user/{username}` `createdPagesCount`, `GET /user/{username}/pages`
 * `total`, `GET /pages/list?user=` `total` — feature-profile-stats-and-page-total)
 * call it directly instead of re-deriving the conditions inline, so the two
 * queries can never drift apart.
 *
 * Mirrors `findListByCreator`'s own rule: the creator's own drafts are
 * visible only to themself (`visiblePageStatusOr`), and any other viewer is
 * further restricted to `GRANT_PUBLIC` rows — the creator listing never
 * exposes restricted/specified/owner pages to someone other than the
 * creator, even if the viewer is in `grantedUsers`.
 */
export function creatorPageListMatch(creatorId: Types.ObjectId | string, viewerId: Types.ObjectId | string): Record<string, unknown> {
  const match: Record<string, unknown> = {
    creator: creatorId,
    redirectTo: null,
    $or: visiblePageStatusOr(viewerId, creatorId),
  };
  if (String(creatorId) !== String(viewerId)) {
    match.grant = GRANT_PUBLIC;
  }
  return match;
}

/**
 * Match conditions for "pages starting with `path`, visible to `viewerId`"
 * — the portal/path-listing set. `findListByStartWith` builds its `find()`
 * from this; `GET /pages/list`'s `total` for the same branch
 * (feature-profile-stats-and-page-total) calls it directly so the listing
 * and its count share one visibility rule.
 *
 * `path` is matched unescaped (`new RegExp('^' + path)`) — pre-existing
 * `findListByStartWith` behaviour, not changed here.
 *
 * `opt.excludeIds` (feature-profile-stats-and-page-total) folds a
 * `_id: $nin` clause into the SAME match `find` and `count` share, for the
 * `portalPage` / `contentPage` ids `GET /pages/list` surfaces separately
 * and drops from `pages`. Excluding them here — rather than filtering the
 * `find()` results afterward — keeps `pages.length` accurate against
 * `limit` at the skip/limit boundary, so `pager.next` and `total` never
 * drift from what a client can actually page through.
 */
export function startWithPageListMatch(
  path: string,
  viewerId: Types.ObjectId | string,
  opt: { includeDeletedPage?: boolean; excludeIds?: Types.ObjectId[] } = {},
): Record<string, unknown> {
  const pathCondition: Record<string, string | RegExp>[] = [{ path: new RegExp(`^${path}`) }];
  if (path.match(/\/$/) && path.length > 1) {
    pathCondition.push({ path: path.substring(0, path.length - 1) });
  }
  const andClauses: Record<string, unknown>[] = [{ $or: pathCondition }];
  if (!opt.includeDeletedPage) {
    andClauses.push({ $or: visiblePageStatusOr(viewerId) });
  }
  const match: Record<string, unknown> = {
    redirectTo: null,
    $or: visiblePageGrantOr(viewerId),
    $and: andClauses,
  };
  if (opt.excludeIds && opt.excludeIds.length > 0) {
    match._id = { $nin: opt.excludeIds };
  }
  return match;
}

/** Builds the `Crowi:Page:NotFound` error that callers map onto a 404. */
function pageNotFoundError(): Error {
  const error = new Error('Page not found');
  error.name = 'Crowi:Page:NotFound';
  return error;
}

/** Max simultaneous per-page operations during a subtree rename (renameTree). */
const RENAME_TREE_CONCURRENCY = 8;

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * result order. Rejects on the first error (like `Promise.all`); in-flight
 * siblings are not cancelled but no new work is started after a rejection.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const TYPE_PORTAL = 'portal';
export const TYPE_USER = 'user';
export const TYPE_PUBLIC = 'public';
export const TYPES = [TYPE_PORTAL, TYPE_USER, TYPE_PUBLIC] as const;

export interface PageDocument extends Document {
  _id: Types.ObjectId;
  path: string;
  revision: Types.ObjectId;
  // A "real" page stores `null`; a redirect stub left behind by a rename
  // stores the destination path. Nullable throughout (see `isRedirectOriginPage`
  // and the many `{ redirectTo: null }` real-page filters / creates).
  redirectTo: string | null;
  status: string;
  grant: number;
  grantedUsers: Types.ObjectId[];
  creator: Types.ObjectId;
  lastUpdateUser: Types.ObjectId;
  liker: Types.ObjectId[];
  seenUsers: Types.ObjectId[];
  commentCount: number;
  extended: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  /**
   * RFC-0003: pointer to the most recent `Revision` produced by the
   * collaborative save flow. Semantically identical to the legacy
   * `revision` field; introduced as a separate name to make the new
   * code path explicit. Phase 5 will populate it alongside `revision`
   * inside the save transaction; older pages and pages saved before
   * Phase 5 lands return `null` here and read code should fall back to
   * `revision`. The duplication is intentional during the v2.0
   * transition — see `openQuestions[0]` in the Phase 1 task file.
   */
  currentRevision?: Types.ObjectId | null;
  /**
   * RFC-0003: binary snapshot of the page's Y.Doc (output of
   * `Y.encodeStateAsUpdate`). Phase 3 reads this in `onLoadDocument`
   * to restore the doc; Phase 4's compaction writes it. `null` means
   * "no live Yjs state yet — build a fresh doc from the latest
   * revision's body". External writers that bypass Yjs MUST also
   * set this to `null` so connected clients are force-reloaded
   * (Phase 6).
   *
   * Subject to MongoDB's 16 MB BSON document cap. Phase 4's
   * compaction step keeps the snapshot bounded; Phase 1 ships
   * without a runtime size guard.
   */
  yjsState?: Buffer | null;
  /** RFC-0003: timestamp of the most recent `yjsState` checkpoint. */
  yjsCheckpointAt?: Date | null;
  /**
   * RFC-0017 Phase 1: monotonic collab lifecycle epoch. Advanced (atomically,
   * in the SAME `updateOne` as the mutation) whenever a lifecycle transition
   * durably changes what a live collab editor is attached to — rename
   * (`path`), soft delete / revert (`status`), or an external body replace
   * (`currentRevision`). A wsToken mints the page's epoch at the time it was
   * issued; `onAuthenticate` / `executeSave`'s atomic CAS / `onLoadDocument`'s
   * replay filter all compare against the CURRENT row value, so a token or a
   * materialised Y.Doc that predates a transition is refused even when the
   * legacy path/status/currentRevision-based checks would otherwise pass
   * (self-invalidation hole — see `docs/rfcs/0017-collab-invalidate-on-rename-delete.md`).
   * `default: 0` so every pre-existing row hydrates to a defined value
   * without a backfill migration being load-bearing for correctness (the
   * migration in `migration/migrations/collab-lifecycle-version.ts` is
   * additive housekeeping, not a prerequisite).
   */
  collabLifecycleVersion: number;

  /**
   * RFC-0021 §5.4 (Phase 1) — monotonic, page-local ordering counter for
   * `PageHistoryEvent`/`Revision.historySequence`. Phase 1 initializes it to
   * 0 on every new Page; the (Phase 2) history-producing Page CAS is the
   * sole allocator that ever increments it.
   */
  historySequence: number;
  /** RFC-0021 §5.5a (Phase 1) — see `HistoryTracking`'s doc comment above. */
  historyTracking: HistoryTracking;
  /** RFC-0021 §5.5 (Phase 1) — see `PendingHistoryEntry`'s doc comment above. */
  pendingHistoryEntry?: PendingHistoryEntry | null;

  // dynamic fields
  latestRevision?: Types.ObjectId;
  likerCount?: number;
  seenUsersCount?: number;

  isPublished(): boolean;
  isDeleted(): boolean;
  isDeprecated(): boolean;
  isDraft(): boolean;
  isPublic(): boolean;
  isPortal(): boolean;
  isCreator(user: any): boolean;
  isGrantedFor(user: any): boolean;
  isLatestRevision(): boolean;
  isUpdatable(previousRevision): boolean;
  isLiked(user: any): boolean;
  isRedirectOriginPage(): boolean;
  isUnlinkable(user: any): boolean;
  isWIP(): boolean;
  like(user: any): any;
  unlike(user: any): any;
  unlink(user: any): any;
  isSeenUser(user: any): any;
  seen(user: any): any;
  getSlackChannel(): any;
  updateSlackChannel(slackChannel: string): any;
  updateExtended(extended: Record<string, any>): any;
  getNotificationTargetUsers(): any;
}

/** Options for `Page.pushRevision`. */
export interface PushRevisionOptions {
  /**
   * When true, leave `lastUpdateUser` / `updatedAt` at their current values
   * instead of bumping them to the acting user / now. Used by body-rewrite
   * migrations so an `apply` doesn't reorder recently-updated lists or
   * overwrite a page's "last updated by" with the migration bot. legacy pages
   * whose values are null/undefined are left untouched (never set to
   * `undefined`). See `migration/runner.ts` `rewritePageBody`.
   */
  preserveTimestamps?: boolean;
}

/** Options for `Page.updatePage` (4th arg). */
export interface UpdatePageOptions extends PushRevisionOptions {
  grant?: number;
  editVia?: string;
}

export interface PageModel extends Model<PageDocument> {
  GRANT_PUBLIC: number;
  GRANT_RESTRICTED: number;
  GRANT_SPECIFIED: number;
  GRANT_OWNER: number;
  PAGE_GRANT_ERROR: number;
  TYPE_PORTAL: string;
  TYPE_PUBLIC: string;
  TYPE_USER: string;

  populatePageData(pageData, revisionId?: Types.ObjectId | null): Promise<PageDocument>;
  populatePagesRevision(pages, revisions): any;
  populatePageListToAnyObjects(pageIdObjectArray): any;
  updateCommentCount(page, num): any;
  hasPortalPage(path, user, revisionId?): Promise<boolean>;
  findPortalPage(path, user, revisionId?): Promise<PageDocument | null>;
  findExistingTwin(path: string, options?: { excludeId?: unknown }): Promise<PageDocument | null>;
  getGrantLabels(): any;
  normalizePath(path): any;
  getUserPagePath(user): any;
  getDeletedPageName(path): any;
  getRevertDeletedPageName(path): any;
  isDeletableName(path): any;
  isRenamableName(path): any;
  isCreatableName(name): any;
  fixToCreatableName(path): any;
  updateRevision(pageId, revisionId, cb): any;
  exists(query): any;
  findUpdatedList(offset, limit, cb): any;
  findPageById(id): Promise<PageDocument>;
  findPageByIdAndGrantedUser(id, userData): Promise<PageDocument>;
  /**
   * feature-restricted-grant-share-banner Phase 1 — grant-on-first-access
   * (invite-link) resolution for the `IdRedirector`-only share URL. See
   * the implementation below (right after `findPageByIdAndGrantedUser`)
   * for the eligibility rule and the TOCTOU-safe atomic write.
   */
  findPageByIdForSharedLinkAccess(id, userData): Promise<{ page: PageDocument; granted: boolean }>;
  findPage(path, userData, revisionId?, ignoreNotFound?): Promise<PageDocument | null>;
  findPageByPath(path): Promise<PageDocument>;
  isExistByPath(path): any;
  isExistById(id): any;
  isNonExistentUserPage(path: string): Promise<boolean>;
  isNonExistentUserTrashPage(path: string): Promise<boolean>;
  findListByPageIds(ids, options, viewerId?: Types.ObjectId | string): any;
  findPagesByIds(ids): any;
  findListByCreator(user, option, currentUser): any;
  getStreamOfFindAll(options?): any;
  findListByStartWith(path, userData, option): Promise<PageDocument[]>;
  findChildrenByPath(path, userData, option): any;
  /**
   * `GET /user/{username}/subpages` — path-rooted, fully recursive listing
   * under `prefix` (e.g. `/user/alice/`), self excluded. See the
   * implementation below (right after `findChildrenByPath`) for the
   * self-exclusion rationale and the count/items query-sharing contract.
   */
  findSubpagesByUserNamespace(
    prefix: string,
    viewerId: Types.ObjectId,
    options: { limit: number; offset: number },
  ): Promise<{ rawPages: PageDocument[]; total: number }>;
  findChildSegments(
    path,
    userData,
  ): Promise<
    Array<{
      segment: string;
      path: string;
      isPage: boolean;
      hasPortal: boolean;
      count: number;
      lastUpdatedAt: string | null;
      updater: PageUser | null;
    }>
  >;
  findUnfurlablePages(type, array, grants?: number[]): any;
  findUnfurlablePagesByIds(ids): any;
  findUnfurlablePagesByPaths(paths): any;
  updatePageProperty(page, updateData, options?: { advanceEpoch?: boolean }): any;
  updateGrant(page, grant, userData, options?: { source?: string }): any;
  pushToGrantedUsers(page, userData): any;
  pushRevision(pageData, newRevision, user, options?: PushRevisionOptions): any;
  createPage(path, body, user, options): any;
  updatePage(pageData: PageDocument, body, user, options: UpdatePageOptions): any;
  deletePage(pageData: PageDocument, user): any;
  revertDeletedPage(pageData: PageDocument, user): Promise<PageDocument>;
  completelyDeletePage(pageData: PageDocument, user?: UserDocument | null, options?: PageRemovalInvalidationOption): Promise<PageDocument>;
  removePage(pageData: PageDocument, options?: PageRemovalInvalidationOption): any;
  removePageById(pageId, options?: PageRemovalInvalidationOption): any;
  removePageByPath(pagePath, options?: PageRemovalInvalidationOption): any;
  removeRedirectOriginPageByPath(pagePath): any;
  rename(pageData, newPagePath, user, options: RenameOptions): any;
  getPathMap(paths, search, replace): any;
  checkPagesRenamable(paths, user): any;
  renameTree(pathMap, user, options): Promise<RenameTreeResult>;
  allPageCount(): any;
}

/**
 * RFC-0017 Phase 1 §D7/§D9 — typed lifecycle invalidation contracts.
 *
 * `mode` controls ONLY the best-effort `crowi:force-reload` prompt
 * (`invalidateLiveCollabDoc`); the `collabLifecycleVersion` epoch advance is
 * unconditional on every call that durably changes `path` / `status` /
 * removes the row — `skip` exists so internal repair steps (soft-delete's
 * `/trash/` rename, `revertDeletedPage`'s internal restoration rename /
 * redirect-origin cleanup, user-page activation) don't spam a prompt for a
 * transition the acting user didn't request, while the epoch still moves so
 * a stale live editor is still write-guarded.
 */
export type PageLifecycleInvalidation =
  | { mode: 'emit'; reason: 'page-renamed' }
  | { mode: 'skip'; reason: 'internal-repair' | 'user-activation' | 'revert-deleted' };

export type PageRemovalInvalidation =
  | { mode: 'emit'; reason: 'page-deleted'; target: 'live-page' }
  | { mode: 'skip'; reason: 'revert-deleted' | 'internal-cleanup' };

/** `Page.rename` 4th-arg options, extended with the optional invalidation override. */
export interface RenameOptions {
  createRedirectPage?: boolean;
  preserveUpdatedAt?: boolean;
  invalidation?: PageLifecycleInvalidation;
}

/**
 * `Page.completelyDeletePage` / `removePage*` optional invalidation override.
 * Defaults documented at each call site below — `completelyDeletePage`
 * defaults to `emit` (the typed user-facing hard-delete call); `removePage`
 * family defaults to `skip` (internal cleanup is the common case; the one
 * user-facing caller — draft cancel — opts into `emit` explicitly).
 */
export interface PageRemovalInvalidationOption {
  invalidation?: PageRemovalInvalidation;
}

/**
 * RFC-0021 §5.1/§5.6, DC-5 — `Page.deleteOne` inside `removePage`
 * is the point of no return: once it commits, the failure mode changes from
 * "the Page is intact, retry the whole call" (thrown immediately, uncaught)
 * to "the Page row is gone, but N sibling cleanup steps still need to run,
 * and any of them can independently fail". A single step failing must
 * never skip its siblings, so every remaining step is tried and failures
 * are collected into ONE instance of this error, thrown after all steps
 * have been attempted (never per-step).
 *
 * `message` carries only `pageId` and the closed vocabulary of step names
 * (`revisions` / `history-events` / `redirect-origin` / `activity`) — never
 * the underlying driver / Mongoose failure text, which `hono/handlers/page.ts`
 * serializes verbatim into the `PAGE_DELETE_FAILED` response body. The
 * original failure(s) are attached as `cause` (a single error, or an array
 * when more than one step failed) for local debugging only.
 */
export class PageCleanupIncompleteError extends Error {
  readonly pageId: string;
  readonly steps: string[];

  constructor(pageId: Types.ObjectId, steps: string[], options?: { cause?: unknown }) {
    super(`page cleanup incomplete for page ${pageId}: ${steps.join(', ')}`);
    this.name = 'PageCleanupIncompleteError';
    this.pageId = String(pageId);
    this.steps = steps;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Accumulator shared by `removePage` / `completelyDeletePage`'s sibling-step aggregation (see `PageCleanupIncompleteError`'s doc comment). */
type CleanupFailures = { steps: string[]; causes: unknown[] };

/** Runs one sibling cleanup step, recording `step` + the error into `failures` on failure instead of throwing — the caller keeps going to the next step either way. */
async function attemptCleanupStep(failures: CleanupFailures, step: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    failures.steps.push(step);
    failures.causes.push(err);
  }
}

/** Throws the aggregated `PageCleanupIncompleteError` if any step recorded into `failures`; no-op otherwise. */
function throwIfCleanupIncomplete(pageId: Types.ObjectId, failures: CleanupFailures): void {
  if (failures.steps.length > 0) {
    throw new PageCleanupIncompleteError(pageId, failures.steps, { cause: failures.causes.length === 1 ? failures.causes[0] : failures.causes });
  }
}

/** RFC-0017 Phase 1 §D8 — `renameTree` allSettled-style outcome. */
export interface RenameTreeResult {
  /** The pre-rename `PageDocument`s that renamed successfully. */
  successes: PageDocument[];
  /** Per-path failures — a subtree rename never rolls back a partial success. */
  failures: { oldPath: string; error: string }[];
}

/**
 * RFC-0021 §5.5a — durable per-Page history tracking state. New Pages are
 * created `untracked`; no writer promotes one until content is first saved
 * on it. `allocateContentSequence` (`service/page-history/content-
 * sequence.ts`), called from every content writer after its pointer write
 * commits, promotes a Page to `ready` (with an atomically-written
 * `trackingStartedAt`) the first time content is saved on it — new or
 * pre-existing alike. Only that allocator, or the (not-yet-implemented)
 * migration CAS, may move a Page through `migrating` to `ready`. Every
 * history-producing writer requires `state: 'ready'` — see
 * `service/page-history/tracking-gate.ts`.
 */
export type HistoryTrackingState = 'untracked' | 'migrating' | 'ready';

export interface HistoryTracking {
  state: HistoryTrackingState;
  trackingStartedAt?: Date | null;
  migrationOwner?: string | null;
  migrationLeaseUntil?: Date | null;
}

/**
 * RFC-0021 §5.5 (Phase 1) — the bounded, single-slot Page outbox. Absent or
 * exactly one entry; never an array (RFC: "It is not an embedded history
 * array" — this is what gives the Page document a hard size bound and a
 * per-Page serialization point). Every history-producing command must drain
 * an existing entry (`service/page-history/materialize.ts`) before
 * attempting another Page CAS.
 *
 * `entryId` (RFC §5.5, revised — "設計の主な判断": "outbox の drain は entryId 1
 * フィールドだけで一致を見る") is generated when an entry is placed into the slot
 * — BEFORE the Page CAS that writes it, mirroring the same "the id must exist
 * before the write it identifies" timing principle `PageHistoryOperation`'s
 * `Idempotency-Key` follows — and is the ONLY field `drainPendingHistoryEntry`
 * matches on to clear the slot. It is deliberately a SEPARATE field from
 * `page_event`'s own `event._id` (that one is the materialization idempotency
 * key for `PageHistoryEvent` — RFC §5.3 — a different concern): every variant
 * carries `entryId`, including the two Revision-pointer variants that have no
 * `event` at all. Content-based matching (comparing the entry's OTHER fields)
 * was deliberately rejected — a native driver can inject fields outside this
 * schema's declared vocabulary, so any content-based identity check can only
 * ever cover a fixed, incomplete set of "known" fields; an opaque id sidesteps
 * the question entirely.
 *
 * Phase 1 ships no writer that ever populates this field — it exists so
 * `service/page-history/materialize.ts` and `repair.ts` have a real shape
 * to drain/repair ahead of Phase 2's command cutover, and so their
 * failure-injection tests (RFC §16.1's "failure injection before enabling
 * writers") have something to fail-inject against.
 */
export type PendingHistoryEntry =
  | {
      entryId: Types.ObjectId;
      type: 'page_event';
      event: {
        _id: Types.ObjectId;
        page: Types.ObjectId;
        sequence: number;
        kind: PageHistoryEventKind;
        actor: Types.ObjectId | null;
        occurredAt: Date;
        operationId: string;
        source: PageHistoryEventSource;
        payload: PageHistoryPayloadByKind[PageHistoryEventKind];
      };
    }
  | {
      entryId: Types.ObjectId;
      type: 'content_revision';
      revisionId: Types.ObjectId;
      sequence: number;
      occurredAt: Date;
      operationId: string;
    }
  | {
      entryId: Types.ObjectId;
      type: 'migration_revision';
      revisionId: Types.ObjectId;
      sequence: number;
      migrationOwner: string;
    };

/**
 * RFC-0021 §5.5a — nested `historyTracking` schema. Legacy Pages that
 * predate this field hydrate `state: 'untracked'` from this default (a
 * single-nested-subdocument default DOES apply on hydration even when the
 * whole `historyTracking` path is absent on the raw document — verified
 * against this project's mongoose version). Every Page starts here; Phase
 * 2a's `allocateContentSequence` is what moves a Page to `state: 'ready'`,
 * via a plain conditional `updateOne`/`findOneAndUpdate` — not a `pre('save')`
 * hook on this schema.
 */
const historyTrackingSchema = new Schema<HistoryTracking>(
  {
    state: { type: String, enum: ['untracked', 'migrating', 'ready'], required: true, default: 'untracked' },
    trackingStartedAt: { type: Date, default: null },
    migrationOwner: { type: String, default: null },
    migrationLeaseUntil: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * RFC-0021 §5.5 — the `page_event` outbox variant mirrors the full
 * `PageHistoryEvent` envelope ahead of materialization. `_id` is
 * deliberately left enabled (Mongoose's subdocument default) rather than
 * declared as a separate field: per RFC §5.3, "`_id` is generated before
 * the Page CAS and copied into the outbox" — this subdocument's own `_id`
 * IS that pre-generated id, explicitly assigned by the caller instead of
 * auto-generated, and `service/page-history/materialize.ts` reuses it
 * verbatim as the materialized `PageHistoryEvent._id` (the idempotency key).
 */
const pendingHistoryEventMirrorSchema = new Schema({
  page: { type: Schema.Types.ObjectId, ref: 'Page', required: true },
  sequence: { type: Number, required: true },
  kind: { type: String, enum: PAGE_HISTORY_EVENT_KINDS, required: true },
  actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  occurredAt: { type: Date, required: true },
  operationId: { type: String, required: true },
  source: { type: String, enum: PAGE_HISTORY_EVENT_SOURCES, required: true },
  payload: { type: pageHistoryEventPayloadSchema, required: true },
});

/**
 * RFC-0021 §5.5 — the bounded, single-slot outbox. See `PendingHistoryEntry`
 * above for the 3-variant union this mirrors. No Page write ever stores more
 * than one of these (it is a single embedded subdocument path, not an
 * array) — `service/page-history/materialize.ts`'s `drainPendingHistoryEntry`
 * clears it with a CAS matched ONLY on `entryId` (see `PendingHistoryEntry`'s
 * doc comment above) after materialization.
 */
const pendingHistoryEntrySchema = new Schema(
  {
    entryId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: ['page_event', 'content_revision', 'migration_revision'], required: true },
    event: { type: pendingHistoryEventMirrorSchema },
    revisionId: { type: Schema.Types.ObjectId, ref: 'Revision' },
    sequence: { type: Number },
    occurredAt: { type: Date },
    operationId: { type: String },
    migrationOwner: { type: String },
  },
  { _id: false },
);

/**
 * The field set each `PendingHistoryEntry` variant owns, `entryId` aside
 * (every variant owns it) — used only by this schema's own `pre('validate')`
 * hook below to require/forbid the variant-specific fields. NOT exported:
 * earlier revisions of this feature also fed this table into
 * `service/page-history/materialize.ts`'s drain filter (a content-based
 * "does the entry still look the same" check); the spec later replaced that
 * with matching on `entryId` alone (see `PendingHistoryEntry`'s doc comment),
 * so this table's only remaining job is variant shape validation.
 */
const PENDING_HISTORY_ENTRY_FIELDS_BY_TYPE: Record<PendingHistoryEntry['type'], readonly string[]> = {
  page_event: ['entryId', 'event'],
  content_revision: ['entryId', 'revisionId', 'sequence', 'occurredAt', 'operationId'],
  migration_revision: ['entryId', 'revisionId', 'sequence', 'migrationOwner'],
};
const ALL_PENDING_HISTORY_ENTRY_FIELDS = Array.from(new Set(Object.values(PENDING_HISTORY_ENTRY_FIELDS_BY_TYPE).flat()));

/**
 * Per-variant shape validation (RFC §5.5 / codex review attempt 2 — "a
 * single subdocument without per-variant required/forbidden field
 * constraints [...] can pass schema validation, leading to materializer
 * crashes"). Mirrors `pageHistoryEventSchema`'s own `pre('validate')` hook.
 *
 * IMPORTANT scope note: this only fires on the `Page.prototype.save()` /
 * `.validate()` path. Every real outbox claim in this codebase (this
 * schema's own consumers in `service/page-history/repair.ts`, and every
 * `claimOutbox`-style test helper) writes `pendingHistoryEntry` via a raw
 * `Page.updateOne(...{ $set: ... })`, which mongoose does not run document
 * middleware against — so this hook is defense-in-depth for a future
 * `.save()`-based writer, NOT the enforcement `materializePendingEntry`
 * depends on. The load-bearing guard for the `updateOne` path is
 * `assertWellFormedPendingEntry` in `service/page-history/materialize.ts`.
 */
pendingHistoryEntrySchema.pre('validate', function () {
  const allowed = PENDING_HISTORY_ENTRY_FIELDS_BY_TYPE[this.type as keyof typeof PENDING_HISTORY_ENTRY_FIELDS_BY_TYPE];
  if (allowed == null) {
    // `type`'s own `enum` validator already rejects an unknown type.
    return;
  }
  const self = this as unknown as Record<string, unknown>;
  for (const field of ALL_PENDING_HISTORY_ENTRY_FIELDS) {
    const hasValue = self[field] !== undefined && self[field] !== null;
    if (!allowed.includes(field) && hasValue) {
      this.invalidate(field, `${field} is not valid for pendingHistoryEntry type "${this.type}"`);
    }
  }
  for (const field of allowed) {
    if (self[field] === undefined || self[field] === null) {
      this.invalidate(field, `${field} is required for pendingHistoryEntry type "${this.type}"`);
    }
  }
});

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:page');
  const pageEvent = crowi.event('Page');

  /**
   * feature-editor-preview-reliability G1, generalised by RFC-0017 Phase 1 —
   * drive the in-process collab external-edit invalidator after a lifecycle
   * write commits. Fire-and-forget: the invalidator is itself best-effort
   * and never throws, but we still guard the call so an absent attachment
   * (CLI / tests / boot not yet finished) or a synchronous throw can never
   * bubble into the write. `reason` defaults to `'page-body-replaced'` (the
   * original G1 external-body-edit caller); rename/delete pass
   * `'page-renamed'` / `'page-deleted'` so the client's force-reload dialog
   * can eventually show a reason-specific copy (Phase 3, out of scope here).
   *
   * Multi-instance / out-of-process is out of scope (RFC-0003 §5b): the
   * handle only reaches docs live in THIS api process. A live doc on another
   * replica needs future Redis pub/sub — documented in the realtime-collab
   * operations doc. This is prompt-transport ONLY: correctness against a
   * stale editor is the `collabLifecycleVersion` epoch (RFC-0017 §4),
   * enforced independently of whether this call ever reaches a live doc.
   */
  function invalidateLiveCollabDoc(pageId: Types.ObjectId | string, reason: InvalidateReason = 'page-body-replaced'): void {
    const attachment = crowi.collabAttachment;
    if (!attachment) return;
    void attachment.invalidatePages([String(pageId)], reason).catch((err: unknown) => {
      debug('collab invalidatePages failed for page %s: %s', String(pageId), (err as Error)?.message ?? err);
    });
  }

  /**
   * RFC-0017 Phase 1 §D9/§D10 — defense-in-depth cleanup of the collab
   * lineage at a delete boundary (soft delete / hard delete / draft cancel)
   * and re-run (idempotently) after a revert. NOT load-bearing for
   * correctness: the `collabLifecycleVersion` epoch advance already makes a
   * pre-transition `yjsState` / `PageYjsUpdate` row non-replayable (stale
   * epoch), so a purge failure can never resurrect deleted content — this
   * only reclaims storage / limits how long deleted content is readable from
   * the append log (privacy). Best-effort: swallow + warn, never throw.
   */
  async function purgeCollabLineage(pageId: Types.ObjectId | string): Promise<void> {
    const PageYjsUpdate = crowi.model('PageYjsUpdate');
    try {
      await Promise.all([
        Page.updateOne({ _id: pageId }, { $set: { yjsState: null, yjsCheckpointAt: null } }).exec(),
        PageYjsUpdate.deleteMany({ pageId }).exec(),
      ]);
    } catch (err) {
      debug('purgeCollabLineage failed for page %s: %s', String(pageId), (err as Error)?.message ?? err);
    }
  }

  /**
   * RFC-0017 Phase 1 §D7/§D9 — the shared `mode === 'emit'` guard used by
   * `rename` / `completelyDeletePage` / `removePage`: fire the reload prompt
   * only when the caller's typed invalidation opted in, `skip` is a no-op.
   */
  function emitInvalidationIfRequested(pageId: Types.ObjectId | string, invalidation: PageLifecycleInvalidation | PageRemovalInvalidation): void {
    if (invalidation.mode === 'emit') {
      invalidateLiveCollabDoc(pageId, invalidation.reason);
    }
  }

  function isPortalPath(path) {
    return path.endsWith('/');
  }

  function addTrailingSlash(path) {
    return path.endsWith('/') ? path : `${path}/`;
  }

  function removeTrailingSlash(string) {
    return string.endsWith('/') ? string.substring(0, string.length - 1) : string;
  }

  const pageSchema = new Schema<PageDocument, PageModel>(
    {
      path: { type: String, required: true, index: true, unique: true },
      revision: { type: Schema.Types.ObjectId, ref: 'Revision' },
      redirectTo: { type: String, index: true },
      status: { type: String, default: STATUS_PUBLISHED, index: true },
      grant: { type: Number, default: GRANT_PUBLIC, index: true },
      grantedUsers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      creator: { type: Schema.Types.ObjectId, ref: 'User', index: true },
      // lastUpdateUser: this schema is from 1.5.x (by deletion feature), and null is default.
      // the last update user on the screen is by revesion.author for B.C.
      lastUpdateUser: { type: Schema.Types.ObjectId, ref: 'User', index: true },
      liker: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
      seenUsers: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
      commentCount: { type: Number, default: 0 },
      extended: {
        type: String,
        default: {},
        get: function (data): Record<string, any> {
          try {
            const parsed = JSON.parse(data);

            // for fixing data wile bugging.
            // the data could be '"{}"' (parsed as '{}' so the data should be converted to empty object
            if (typeof parsed === 'string' && parsed === '{}') {
              return {};
            }
            return parsed;
          } catch (e) {
            return data;
          }
        },
        set: function (data: Record<string, any>) {
          return JSON.stringify(data);
        },
      },
      createdAt: { type: Date, default: Date.now },
      updatedAt: Date,
      // RFC-0003: pointer to the latest collaborative-save `Revision`.
      // Co-exists with `revision` during the v2.0 transition; the
      // legacy field stays the source of truth until Phase 5 lands
      // the dual-write inside the save transaction.
      currentRevision: { type: Schema.Types.ObjectId, ref: 'Revision', default: null },
      // RFC-0003: binary Y.Doc snapshot. Hocuspocus checkpoints into
      // this field (Phase 4); `onLoadDocument` (Phase 3) reads it.
      // `null` means "no live Yjs state — rebuild from `body`".
      yjsState: { type: Buffer, default: null },
      // RFC-0003: timestamp anchor for the most recent `yjsState`
      // checkpoint. Driven by the compaction loop (Phase 4).
      yjsCheckpointAt: { type: Date, default: null },
      // RFC-0017 Phase 1: monotonic collab lifecycle epoch. See the
      // `PageDocument` interface field doc above for the full contract.
      // No index — advanced on every lifecycle write but never queried by
      // value (only compared against a per-request expected value), so an
      // index would only add write overhead.
      collabLifecycleVersion: { type: Number, default: 0, required: false },
      // RFC-0021 §5.4 (Phase 1) — page-local history ordering counter. See
      // the `PageDocument` interface field doc above. No index — Phase 1
      // never queries by value, only ever compares/increments in a Page CAS
      // (Phase 2).
      historySequence: { type: Number, default: 0, required: false },
      // RFC-0021 §5.5a (Phase 1). See `historyTrackingSchema`'s doc comment.
      historyTracking: { type: historyTrackingSchema, default: () => ({ state: 'untracked' }) },
      // RFC-0021 §5.5 (Phase 1) — no default: absent means "empty outbox",
      // and Mongo's `{ pendingHistoryEntry: null }` filter matches both
      // "absent" and "explicitly null" for the CAS-based claim/drain queries.
      pendingHistoryEntry: { type: pendingHistoryEntrySchema },
    },
    {
      toJSON: { getters: true },
      toObject: { getters: true },
    },
  );

  // RFC-0004: backs `GET /api/pages/drafts` — `find({ creator, status })`
  // sorted by `createdAt` desc. Without it the listing scans a single-field
  // index then sorts in memory.
  pageSchema.index({ creator: 1, status: 1, createdAt: -1 });

  // RFC-0021 §5.5a says new Pages are created `ready`. That belongs to the
  // phase where creation goes through a command service that allocates the
  // page-local sequence — Phase 2. Phase 1 allocates nothing: `createPage`
  // saves the Page and then `Revision.prepareRevision` writes the first
  // Revision with no `historySequence` at all.
  //
  // Marking such a Page `ready` would assert something untrue. `ready` means
  // the page-local timeline is authoritative, and a page whose very first
  // Revision carries no sequence has no timeline yet. It also creates a
  // cohort that the Phase 2 backfill cannot see: the migration selects Pages
  // that are NOT ready, and `requireHistoryReady` lets `ready` through, so a
  // Phase 2 writer would hand sequence 1 to a NEW Revision while the initial
  // one stays unsequenced — the ordering §5.4 exists to guarantee.
  //
  // So Phase 1 leaves every Page at the schema default (`untracked`), which
  // is exactly what it is: a Page whose history is not yet tracked. Phase 2's
  // create command sets `ready` in the same write that allocates the initial
  // sequence, and the backfill promotes existing Pages the same way.

  pageEvent.on('create', pageEvent.onCreate);
  pageEvent.on('update', pageEvent.onUpdate);
  pageEvent.on('delete', pageEvent.onDelete);

  pageSchema.methods.isWIP = function () {
    return this.status === STATUS_WIP;
  };

  pageSchema.methods.isPublished = function () {
    // null: this is for B.C.
    return this.status === null || this.status === STATUS_PUBLISHED;
  };

  pageSchema.methods.isDeleted = function () {
    return this.status === STATUS_DELETED;
  };

  pageSchema.methods.isDeprecated = function () {
    return this.status === STATUS_DEPRECATED;
  };

  pageSchema.methods.isDraft = function () {
    return this.status === STATUS_DRAFT;
  };

  pageSchema.methods.isPublic = function () {
    if (!this.grant || this.grant == GRANT_PUBLIC) {
      return true;
    }

    return false;
  };

  pageSchema.methods.isPortal = function () {
    return isPortalPath(this.path);
  };

  pageSchema.methods.isCreator = function (userData) {
    if (this.populated('creator') && (this.creator as any as UserDocument)._id.toString() === userData._id.toString()) {
      return true;
    } else if (this.creator.toString() === userData._id.toString()) {
      return true;
    }

    return false;
  };

  pageSchema.methods.isGrantedFor = function (userData) {
    if (this.isPublic() || this.isCreator(userData)) {
      return true;
    }

    // Value-compare via `.equals()` (same pattern as `isSeenUser` below)
    // instead of `indexOf`, which is a reference/primitive comparison and
    // can misjudge populated arrays or non-identical ObjectId instances.
    // Unlike `isSeenUser`, no cast is needed here: `grantedUsers` is typed
    // as `Types.ObjectId[]`, and `Types.ObjectId` already exposes
    // `.equals()` — it also works correctly if the array happens to hold
    // populated `UserDocument`s, since Mongoose's `Document.prototype.equals`
    // delegates to the same `_id.equals()` comparison.
    return this.grantedUsers.some((granted) => granted.equals(userData._id));
  };

  pageSchema.methods.isLatestRevision = function () {
    // populate されていなくて判断できない
    if (!this.latestRevision || !this.revision) {
      return true;
    }

    return this.latestRevision == ((this.revision as any as RevisionDocument)._id.toString() as any);
  };

  pageSchema.methods.isUpdatable = function (previousRevision) {
    const revision = this.latestRevision || this.revision;
    if (revision != previousRevision) {
      return false;
    }
    return true;
  };

  pageSchema.methods.isLiked = function (userData) {
    return this.liker.some(function (likedUser) {
      return likedUser == userData._id.toString();
    });
  };

  pageSchema.methods.isRedirectOriginPage = function () {
    return this.redirectTo !== null;
  };

  pageSchema.methods.isUnlinkable = function (userData) {
    return this.isRedirectOriginPage() && this.isGrantedFor(userData);
  };

  pageSchema.methods.like = async function (userData) {
    const Activity = crowi.model('Activity');

    const added = (this.liker as any as Types.Array<UserDocument>).addToSet(userData._id);
    if (added.length > 0) {
      const data = await this.save();

      debug('liker updated!', added);

      try {
        const activityLog = await Activity.createByPageLike(data, userData);
        debug('Activity created', activityLog);
      } catch (err) {
        debug('Activity err', err);
      }

      return data;
    } else {
      debug('liker not updated');
    }
  };

  pageSchema.methods.unlike = async function (userData) {
    const Activity = crowi.model('Activity');

    const liker = this.liker as any as Types.Array<UserDocument>;
    const beforeCount = liker.length;
    liker.pull(userData._id);
    if (liker.length != beforeCount) {
      const data = await this.save();

      try {
        await Activity.removeByPageUnlike(data, userData);
        debug('Activity removed');
      } catch (err) {
        debug('Activity remove err', err);
      }

      return data;
    } else {
      debug('liker not updated');
    }
  };

  // Unlink: Remove redirect origin page
  pageSchema.methods.unlink = async function (userData) {
    const Page = crowi.model('Page');
    if (this.isUnlinkable(userData)) {
      debug('Unlink page', this._id, this.path);
      try {
        const redirectPage = await Page.removePageById(this._id);
        debug('Redirect Page deleted', redirectPage.path);
      } catch (err: any) {
        debug('Error occured while get setting', err, err.stack);
        throw new Error(`Failed to delete redirect page (${this.path}).`);
      }
    } else {
      throw new Error('Page is not unlinkable');
    }
  };

  pageSchema.methods.isSeenUser = function (userData) {
    const seenUsers = this.seenUsers as any as UserDocument[];

    return seenUsers.some(function (seenUser) {
      return seenUser.equals(userData._id);
    });
  };

  pageSchema.methods.seen = async function (userData) {
    const seenUsers = this.seenUsers as any as Types.Array<UserDocument>;

    if (this.isSeenUser(userData)) {
      debug('seenUsers not updated');
      return this;
    }

    if (!userData || !userData._id) {
      throw new Error('User data is not valid');
    }

    const added = seenUsers.addToSet(userData);

    await this.save();

    debug('seenUsers updated!', added);

    return this;
  };

  pageSchema.methods.getSlackChannel = function () {
    const extended = this.get('extended');
    if (!extended) {
      return '';
    }

    return extended.slack || '';
  };

  pageSchema.methods.updateSlackChannel = function (slackChannel) {
    const extended: Record<string, any> = this.extended;
    extended.slack = slackChannel;

    return this.updateExtended(extended);
  };

  pageSchema.methods.updateExtended = function (extended) {
    this.extended = extended;
    return this.save();
  };

  pageSchema.statics.populatePageData = function (pageData: PageDocument, revisionId) {
    // `pageData.revision` can already be a live/populated Revision
    // *Document* here — e.g. right after Page.pushRevision() assigns the
    // just-created instance, or when `pageData` itself is the result of a
    // prior populatePageData() call — rather than a bare `ObjectId`.
    // Capture only its `_id` into `latestRevision`; aliasing the object
    // itself made `latestRevision` and `revision` share one reference, so
    // the `.populate('revision', ...)` below mutated it in place and
    // `toStringId()` (page-response.ts) fell through to
    // `Document#toString()` — Mongoose's debug inspect override — instead
    // of returning the id string.
    const currentRevision = pageData.revision as unknown as RevisionDocument | Types.ObjectId | undefined;
    pageData.latestRevision = currentRevision instanceof Types.ObjectId ? currentRevision : currentRevision?._id;
    if (revisionId) {
      pageData.revision = revisionId;
    }
    pageData.likerCount = pageData.liker.length || 0;
    pageData.seenUsersCount = pageData.seenUsers.length || 0;

    return pageData.populate([
      { path: 'lastUpdateUser', model: 'User' },
      { path: 'creator', model: 'User' },
      { path: 'revision', model: 'Revision', populate: { path: 'author', model: 'User' } },
    ]);
  };

  pageSchema.statics.populatePagesRevision = async function (pages, revisions) {
    if (pages.length !== revisions.length) {
      throw new TypeError('page.length must be equal revisions.length');
    }
    pages = pages.map((page, i) => {
      const revision = revisions[i];
      if (revision) {
        page.revision = revision;
      }
      return page;
    });
    return Page.populate(pages, { path: 'revision', model: 'Revision' });
  };

  pageSchema.statics.populatePageListToAnyObjects = async function (pageIdObjectArray) {
    const pageIdMappings = {};
    const pageIds = pageIdObjectArray.map(function (page, idx) {
      if (!page._id) {
        throw new Error('Pass the arg of populatePageListToAnyObjects() must have _id on each element.');
      }

      pageIdMappings[String(page._id)] = idx;
      return page._id;
    });

    const pages = await Page.findListByPageIds(pageIds, { limit: 100 }); // limit => if the pagIds is greater than 100, ignore

    for (const p of pages) {
      Object.assign(pageIdObjectArray[pageIdMappings[String(p._id)]], p._doc);
    }

    return pageIdObjectArray;
  };

  pageSchema.statics.updateCommentCount = function (page, num) {
    return Page.updateOne({ _id: page }, { commentCount: num }, {});
  };

  pageSchema.statics.hasPortalPage = async function (path, user, revisionId) {
    try {
      const page = await Page.findPage(path, user, revisionId);
      return !!page;
    } catch (err) {
      return false;
    }
  };

  pageSchema.statics.findPortalPage = async function (path, user, revisionId) {
    try {
      const page = await Page.findPage(path, user, revisionId);
      return page;
    } catch (err) {
      return null;
    }
  };

  /**
   * Find the "twin" of `path` — the same path with the trailing slash
   * toggled (`/x` ↔ `/x/`). Used by the create / draft / rename guards to
   * block the `/x` ↔ `/x/` double-state (feature-update-pages-list-ux §6):
   * if `/x` exists you can't create `/x/` and vice versa.
   *
   * Only a REAL page counts (`redirectTo: null`) — a redirect stub left by
   * a previous move is not a real twin and must not block. `excludeId` lets
   * a self-targeting move (portalizing `/x` → `/x/`, where the twin `/x` is
   * the page being moved) skip its own document. Returns `null` when no
   * twin exists, the root `/` (which has no meaningful twin), or the only
   * match is the excluded id.
   *
   * Note: this is a raw existence check independent of grant — the guard is
   * about path uniqueness, not visibility, so a twin the caller cannot see
   * still blocks (and we never leak it; the guard returns a generic 400).
   */
  pageSchema.statics.findExistingTwin = async function (path, options = {}) {
    // The root portal `/` strips to '' — there is no `/x` ↔ `/x/` pairing
    // to enforce there, so never treat it as having a twin.
    if (path === '/' || path === '') {
      return null;
    }
    const twinPath = isPortalPath(path) ? removeTrailingSlash(path) : addTrailingSlash(path);
    const query: Record<string, unknown> = { path: twinPath, redirectTo: null };
    const excludeId = options.excludeId;
    if (excludeId != null) {
      query._id = { $ne: excludeId };
    }
    return Page.findOne(query) as Promise<PageDocument | null>;
  };

  pageSchema.statics.getGrantLabels = function () {
    const grantLabels = {};
    grantLabels[GRANT_PUBLIC] = 'Public'; // 公開
    grantLabels[GRANT_RESTRICTED] = 'Anyone with the link'; // リンクを知っている人のみ
    // grantLabels[GRANT_SPECIFIED]  = 'Specified users only'; // 特定ユーザーのみ
    grantLabels[GRANT_OWNER] = 'Just me'; // 自分のみ

    return grantLabels;
  };

  pageSchema.statics.normalizePath = function (path) {
    if (!path.match(/^\//)) {
      path = '/' + path;
    }

    path = path.replace(/\/\s+?/g, '/').replace(/\s+\//g, '/');

    return path;
  };

  pageSchema.statics.getUserPagePath = function (user) {
    return '/user/' + user.username;
  };

  pageSchema.statics.getDeletedPageName = function (path) {
    if (path.match('/')) {
      path = path.substr(1);
    }
    return '/trash/' + path;
  };

  pageSchema.statics.getRevertDeletedPageName = function (path) {
    return path.replace('/trash', '');
  };

  // The user home page is the only non-deletable / non-renamable name;
  // both guards share `USER_HOME_PAGE_PATH` so they can never drift.
  pageSchema.statics.isDeletableName = function (path) {
    return !USER_HOME_PAGE_PATH.test(path);
  };

  pageSchema.statics.isRenamableName = function (path) {
    return !USER_HOME_PAGE_PATH.test(path);
  };

  pageSchema.statics.isCreatableName = function (name) {
    const forbiddenPages = [
      /\^|\$|\*|\+|\?|#/,
      /^\/_.*/, // /_api/* and so on
      /^\/-\/.*/,
      /^\/_r\/.*/,
      /^\/user\/?$/, // `/user` and `/user/` are the member directory — no portal/page here
      /^\/user\/[^/]+\/(bookmarks|comments|activities|pages|recent-create|recent-edit)/, // reserved
      /^\/?https?:\/\/.+$/, // avoid miss in renaming
      /\/{2,}/, // avoid miss in renaming
      /\s+\/\s+/, // avoid miss in renaming
      /.+\/edit$/,
      /.+\.md$/,
      /^\/(installer|register|login|logout|admin|me|files|trash|paste|comments|api)(\/.*|$)/, // `api` is the reverse-proxied backend namespace
    ];

    let isCreatable = true;
    forbiddenPages.forEach(function (page) {
      const pageNameReg = new RegExp(page);
      if (name.match(pageNameReg)) {
        isCreatable = false;
      }
    });

    return isCreatable;
  };

  pageSchema.statics.fixToCreatableName = function (path) {
    return path.replace(/\/\//g, '/');
  };

  pageSchema.statics.updateRevision = function (pageId, revisionId, cb) {
    // mongoose 7 dropped the callback form of updateOne(); bridge the promise
    // to the existing callback signature.
    Page.updateOne({ _id: pageId }, { revision: revisionId }).then(
      (data) => cb(null, data),
      (err) => cb(err, undefined),
    );
  };

  pageSchema.statics.exists = async function (query) {
    const count = await Page.countDocuments(query);
    return count > 0;
  };

  pageSchema.statics.findUpdatedList = function (offset, limit, cb) {
    Page.find({}).sort({ updatedAt: -1 }).skip(offset).limit(limit).exec();
  };

  pageSchema.statics.findPageById = async function (id) {
    const pageData = await Page.findOne({ _id: id });

    if (pageData === null) {
      throw new Error('Page not found');
    }

    return Page.populatePageData(pageData, null);
  };

  pageSchema.statics.findPageByIdAndGrantedUser = async function (id, userData) {
    const pageData = await Page.findPageById(id);

    // RFC-0004: a draft page is visible only to its author. Collapse a
    // non-author's by-id access into a not-found error (not a grant
    // error) so draft existence is never leaked.
    if (pageData.isDraft() && (!userData || !pageData.isCreator(userData))) {
      throw pageNotFoundError();
    }

    if (userData && !pageData.isGrantedFor(userData)) {
      throw new Error('Page is not granted for the user'); // PAGE_GRANT_ERROR, null);
    }

    return pageData;
  };

  /**
   * feature-restricted-grant-share-banner Phase 1 — grant-on-first-access
   * (invite-link) resolution for the share ID URL. Called ONLY by the
   * `POST /pages/link-access` handler (which `IdRedirector` alone uses) —
   * every other by-id path keeps using `findPageByIdAndGrantedUser` above,
   * unchanged.
   *
   * This is a pure ACL read/mutation: it never touches the search index or
   * emits a page event (that's the handler's job, via
   * `util/page-search-index.ts`'s `indexPageInSearchById` — importing it
   * here would be circular, since that module already imports
   * `STATUS_DELETED` / `STATUS_DRAFT` from this one).
   *
   * The invite write is attempted only when ALL of the following hold —
   * otherwise the first read is handed straight to the same `isGrantedFor`
   * gate every by-id read uses, so pages the caller could already open
   * (public / their own / already-granted) pass through with zero writes:
   *   - `grant === GRANT_RESTRICTED`, the caller isn't the creator, and
   *     isn't already in `grantedUsers`.
   *   - the page is an actually-published real page: `status` is `null` or
   *     `STATUS_PUBLISHED` (never invite into a trashed/wip/deprecated/
   *     draft page) and `redirectTo` is nullish (`== null`, not `===` — a
   *     rename-redirect stub is a different document with its own `_id`;
   *     legacy real pages may have `redirectTo` missing rather than
   *     explicitly `null`).
   *
   * When eligible, the write is one atomic `findOneAndUpdate` that pins the
   * exact same "still a published, still-restricted, not-yet-granted real
   * page" predicate used above, so a concurrent grant change / soft-delete
   * between this function's read and its write can never be invited
   * against stale state (TOCTOU-safe). A `null` result (filter didn't
   * match — grant changed, page got trashed, or another tab's own claim
   * beat us to it) re-reads fresh and falls through to the same
   * `isGrantedFor` gate as the pass-through case.
   */
  pageSchema.statics.findPageByIdForSharedLinkAccess = async function (id, userData) {
    const pageData = await Page.findPageById(id);

    // RFC-0004: a draft page is visible only to its author — same
    // existence-hiding rule as `findPageByIdAndGrantedUser` above.
    if (pageData.isDraft() && (!userData || !pageData.isCreator(userData))) {
      throw pageNotFoundError();
    }

    const isEligibleForLinkGrant =
      !!userData &&
      pageData.grant === GRANT_RESTRICTED &&
      !pageData.isCreator(userData) &&
      !pageData.grantedUsers.some((granted) => granted.equals(userData._id)) &&
      pageData.isPublished() &&
      pageData.redirectTo == null;

    let currentPageData = pageData;
    let granted = false; // did THIS call add the caller to grantedUsers?

    if (isEligibleForLinkGrant) {
      const updated = await Page.findOneAndUpdate(
        {
          _id: pageData._id,
          grant: GRANT_RESTRICTED,
          status: { $in: [null, STATUS_PUBLISHED] },
          redirectTo: null,
          grantedUsers: { $ne: userData._id },
        },
        { $addToSet: { grantedUsers: userData._id } },
        { returnDocument: 'after' },
      );

      if (updated) {
        // Matched: the write committed atomically against a still-eligible
        // document, and `returnDocument: 'after'` handed back that exact
        // post-write state — no separate re-read window for a concurrent
        // delete to land in between write and response.
        currentPageData = updated;
        granted = true;
      } else {
        // Filter didn't match: a concurrent grant change / soft-delete, or
        // another tab's own claim, raced ahead of us. Re-read fresh and let
        // the shared `isGrantedFor` gate below decide (403 if we lost
        // access, 200 pass-through if the other tab already granted us).
        currentPageData = await Page.findPageById(id);
      }
    }

    if (userData && !currentPageData.isGrantedFor(userData)) {
      throw new Error('Page is not granted for the user'); // PAGE_GRANT_ERROR, null);
    }

    return { page: currentPageData, granted };
  };

  // find page and check if granted user
  pageSchema.statics.findPage = async function (path, userData, revisionId, ignoreNotFound) {
    const pageData = await Page.findOne({ path });

    if (pageData === null) {
      if (ignoreNotFound) {
        return null;
      }

      throw pageNotFoundError();
    }

    // RFC-0004: a draft page is visible only to its author. By-path
    // access by anyone else collapses into the same not-found error a
    // missing page raises, so a draft's existence at a path is never
    // leaked to non-authors.
    if (pageData.isDraft() && (!userData || !pageData.isCreator(userData))) {
      throw pageNotFoundError();
    }

    if (!pageData.isGrantedFor(userData)) {
      throw new Error('Page is not granted for the user'); // PAGE_GRANT_ERROR, null);
    }

    // DC-5 (`feature-revision-page-ref`): `revisionId` is caller-supplied
    // (`GET /pages?path=...&revision_id=...`) and `populatePageData` below
    // blindly assigns + populates whatever id it is given, with no
    // ownership check of its own. `path` is a mutable, reused string — if a
    // private page is hard-deleted and its path is later reused by an
    // unrelated public page, a caller who still holds a since-deleted
    // revision id could otherwise read that private page's body through
    // the new page's (granted) response. Verify the revision actually
    // belongs to THIS page via the immutable `page` id ref before trusting
    // it. Skip the check (preserve legacy behaviour) for values that don't
    // even look like an ObjectId — some internal callers pass a truthy
    // non-id sentinel here (see `events/user.ts`'s `onActivated`) and this
    // fix is scoped to the actual grant-leak, not those pre-existing shapes.
    if (revisionId && Types.ObjectId.isValid(revisionId)) {
      const Revision = crowi.model('Revision');
      const requestedRevision = await Revision.findById(revisionId).select('page').exec();
      if (!requestedRevision?.page || !requestedRevision.page.equals(pageData._id)) {
        throw pageNotFoundError();
      }
    }

    return Page.populatePageData(pageData, revisionId || null);
  };

  // find page by path
  pageSchema.statics.findPageByPath = async function (path) {
    const pageData = await Page.findOne({ path });
    if (pageData === null) {
      throw new Error('Page not found');
    }

    return pageData;
  };

  pageSchema.statics.isExistByPath = async function (path) {
    const pageData = await Page.findOne({ path });
    if (pageData === null) {
      return false;
    }

    return pageData._id;
  };

  pageSchema.statics.isExistById = async function (id) {
    const pageData = await Page.findOne({ _id: id });
    if (pageData === null) {
      return false;
    }

    return pageData._id;
  };

  pageSchema.statics.isNonExistentUserPage = async (path: string) => {
    if (!path.startsWith('/user')) {
      return false;
    }

    const username = path.match(/^\/user\/(?<username>[^/]+)/)?.groups?.username;
    if (username === undefined) {
      return false;
    }

    const User = crowi.model('User');
    const userData = await User.findUserByUsername(username);

    return userData === null;
  };

  pageSchema.statics.isNonExistentUserTrashPage = async (path: string) => {
    if (!path.startsWith('/trash/user')) {
      return false;
    }

    const username = path.match(/^\/trash\/user\/(?<username>[^/]+)/)?.groups?.username;
    if (username === undefined) {
      return false;
    }

    const User = crowi.model('User');
    const userData = await User.findUserByUsername(username);

    return userData === null;
  };

  pageSchema.statics.findListByPageIds = function (ids, options, viewerId?: Types.ObjectId | string) {
    options = options || {};
    const limit = options.limit || 50;
    const offset = options.skip || 0;

    const query: Record<string, unknown> = { _id: { $in: ids } };
    // Defense-in-depth (SEC-SEARCH-DELEGATED): when a viewer is given,
    // re-apply the grant filter here rather than trusting the caller's
    // `ids` to already be authorization-checked (e.g. a pluggable search
    // driver's hits).
    if (viewerId !== undefined) {
      query.$or = visiblePageGrantOr(viewerId);
    }

    return (
      Page.find(query)
        // .sort({createdAt: -1}) // TODO optionize
        .skip(offset)
        .limit(limit)
        .populate([
          { path: 'creator', model: 'User' },
          { path: 'revision', model: 'Revision', populate: { path: 'author' } },
        ])
        .exec()
    );
  };

  pageSchema.statics.findPagesByIds = function (ids) {
    const query: any = {
      _id: { $in: ids },
      redirectTo: null,
    };

    return Page.find(query)
      .populate([
        { path: 'creator', model: 'User' },
        {
          path: 'revision',
          model: 'Revision',
          populate: {
            path: 'author',
            model: 'User',
          },
        },
      ])
      .exec();
  };

  pageSchema.statics.findListByCreator = function (user, option, currentUser) {
    const limit = option.limit || 50;
    const offset = option.offset || 0;
    const conditions = creatorPageListMatch(user._id, currentUser._id);

    return Page.find(conditions)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate({ path: 'revision', populate: { path: 'author' } })
      .exec();
  };

  /**
   * Bulk get (for internal only)
   */
  pageSchema.statics.getStreamOfFindAll = function (options = {}) {
    const publicOnly = options.publicOnly !== false;
    const criteria: any = { redirectTo: null };

    if (publicOnly) {
      criteria.grant = GRANT_PUBLIC;
    }

    return Page.find(criteria)
      .populate([
        { path: 'creator', model: 'User' },
        { path: 'revision', model: 'Revision' },
      ])
      .lean()
      .cursor();
  };

  /**
   * findListByStartWith
   *
   * If `path` has `/` at the end, returns '{path}/*' and '{path}' self.
   * If `path` doesn't have `/` at the end, returns '{path}*'
   * e.g.
   */
  pageSchema.statics.findListByStartWith = function (path, userData, option) {
    const includeDeletedPage = option.includeDeletedPage || false;
    // feature-profile-stats-and-page-total — ids to fold into this call's
    // match via `_id: $nin` (the `portalPage` / `contentPage` the caller
    // already resolved and will surface/count separately). Threaded through
    // to `startWithPageListMatch` so `find` stays behind the exact same
    // match the caller's `Page.countDocuments(startWithPageListMatch(...))`
    // uses for `total`.
    const excludeIds: Types.ObjectId[] | undefined = option.excludeIds;

    if (!option) {
      option = { sort: 'updatedAt', desc: -1, offset: 0, limit: 50 };
    }
    const opt = {
      sort: option.sort || 'updatedAt',
      desc: option.desc || -1,
      offset: option.offset || 0,
      limit: option.limit === 0 ? 0 : option.limit || 50,
    };
    const sortOpt = {};
    sortOpt[opt.sort] = opt.desc;

    // FIXME: might be heavy
    const query = startWithPageListMatch(path, userData._id, { includeDeletedPage, excludeIds });
    debug('findListByStartWith query:', JSON.stringify({ path, opt, userData: userData._id }));

    return Page.find(query)
      .populate({ path: 'revision', populate: { path: 'author', model: 'User' } })
      .sort(sortOpt)
      .skip(opt.offset)
      .limit(opt.limit)
      .exec()
      .then((results) => {
        debug('findListByStartWith results count:', results.length);
        return results;
      });
  };

  pageSchema.statics.findChildrenByPath = async function (path, userData, option) {
    path = addTrailingSlash(path);
    return Page.findListByStartWith(path, userData, { limit: 0, ...option });
  };

  /**
   * `GET /user/{username}/subpages` only. Lists every page under `prefix`
   * (e.g. `/user/alice/`, caller-supplied and unescaped — escaping happens
   * here) recursively across all depths, visible to `viewerId`.
   *
   * Deliberately independent of `findListByStartWith`: that function is a
   * shared contract (portal listing + trash) with its own external
   * behaviour (trailing-slash-includes-parent, default `updatedAt desc`
   * sort, `includeDeletedPage` branch, unescaped regex) that this feature
   * must not perturb. The logic this endpoint needs is small enough (a path
   * prefix condition + an explicit self-exclusion) that duplicating it here
   * is cheaper than risking a shared-helper refactor of `findListByStartWith`.
   *
   * Self-exclusion: the regex `^${escapeRegExp(prefix)}` also matches
   * `prefix` itself (a string is always a prefix of itself). `prefix` (e.g.
   * `/user/alice/`, trailing slash) can exist as a real, separate document
   * from the home page (`/user/alice`, no trailing slash) whenever the home
   * page itself doesn't exist — `isCreatableName`'s reserved-word list
   * doesn't block it, and `findExistingTwin` only guards the draft-create
   * path. `$ne: prefix` drops that row explicitly, mirroring
   * `findChildSegments`'s `doc.path === prefix` skip.
   *
   * `find` and `countDocuments` share the same `match` object and run as two
   * independent queries (not a single aggregation) — same best-effort
   * count/items consistency trade-off `getUserPages`/`getUserBookmarks`
   * already accept (a concurrent write between the two calls can make
   * `total` momentarily drift from the returned rows; resolved by the next
   * `refetchOnMount: 'always'` refetch on the web side).
   *
   * `.select(...)` excludes `revision`/`currentRevision`/`yjsState`/
   * `extended` — none render in this list, and `yjsState` alone can approach
   * 16MB, so leaving it selected would be needless egress + memory.
   */
  pageSchema.statics.findSubpagesByUserNamespace = async function (
    prefix: string,
    viewerId: Types.ObjectId,
    { limit, offset }: { limit: number; offset: number },
  ): Promise<{ rawPages: PageDocument[]; total: number }> {
    const pathRegex = new RegExp(`^${escapeRegExp(prefix)}`);
    const match = {
      redirectTo: null,
      path: { $regex: pathRegex, $ne: prefix },
      $and: [{ $or: visiblePageGrantOr(viewerId) }, { $or: visiblePageStatusOr(viewerId) }],
    };

    const [rawPages, total] = await Promise.all([
      Page.find(match)
        .select('path redirectTo status grant grantedUsers creator lastUpdateUser liker commentCount createdAt updatedAt')
        .sort({ path: 1, _id: 1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      Page.countDocuments(match),
    ]);

    return { rawPages, total };
  };

  /**
   * Aggregate the immediate child "directories" (next path segment)
   * directly under a portal `path`, for the sidebar tree. Returns one
   * entry per distinct first segment beneath `path`, with whether a
   * real portal page is saved there (`hasPortal` → compass icon), a
   * descendant count, and the segment's representative update metadata
   * (feature-child-segments-metadata).
   *
   * Implemented as a lean `path`-only scan + in-process grouping rather
   * than a `$group` aggregation: extracting "the segment after the
   * prefix" is awkward in MongoDB's expression language, and a portal's
   * subtree is bounded. Visibility (grant + draft status) is enforced
   * with the same `$or` predicates as the listing endpoints so the
   * sidebar never leaks a page the viewer can't open — the
   * representative-page / updater derivation below only ever looks at
   * `docs`, i.e. pages already filtered through that same visibility
   * predicate, so a non-visible page can never win representative-page
   * selection (existence concealment).
   *
   * `lastUpdatedAt` / `updater` definitions (two representative-page
   * flavours, asymmetric on purpose):
   * - `isPage: true` segments (a real page at the segment path itself):
   *   that page's own `updatedAt` / `lastUpdateUser` — the *only* doc
   *   with `slashIdx === -1` for the segment — even if a descendant is
   *   newer.
   * - `isPage: false` segments: the most-recently-updated doc among the
   *   segment's portal doc (`rest === segment+'/'`) and every deeper
   *   descendant. A hasPortal-only segment with zero descendants
   *   collapses to the portal doc's own metadata (openQuestions #1).
   *
   * `lastUpdateUser` is resolved with one extra batched
   * `User.find({ _id: { $in: [...] } })` over only the *representative*
   * ids (one per returned segment, deduped), run once after representative
   * selection — so the N+1 budget stays flat regardless of scan size
   * (spec §実現可能性: bounded by segment count, not subtree size, and
   * skipped entirely when no representative has an updater to resolve).
   * `lastUpdateUser` can be legitimately null (pre-existing rows from
   * before the field existed, or a hard-deleted user id the lookup can't
   * resolve), which surfaces as `updater: null` rather than throwing.
   */
  pageSchema.statics.findChildSegments = async function (path, userData) {
    const prefix = addTrailingSlash(path);
    // Escape regex metacharacters so a path like `/foo(bar)/` is matched
    // literally, not as a pattern.
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = {
      redirectTo: null,
      path: new RegExp(`^${escaped}`),
      $and: [{ $or: visiblePageGrantOr(userData._id) }, { $or: visiblePageStatusOr(userData._id) }],
    };
    // Raw `lastUpdateUser` id only — resolving it to a `PageUser` happens
    // once, below, over just the representative ids (see doc comment).
    const docs: Array<{
      path: string;
      status?: string | null;
      updatedAt?: Date;
      lastUpdateUser?: Types.ObjectId | null;
    }> = await Page.find(query, { path: 1, status: 1, updatedAt: 1, lastUpdateUser: 1 }).lean().exec();

    type SegmentMeta = { updatedAt?: Date; lastUpdateUser?: Types.ObjectId | null };
    type SegmentEntry = {
      segment: string;
      path: string;
      isPage: boolean;
      hasPortal: boolean;
      count: number;
      // The segment's own leaf page metadata (set at most once — there is
      // exactly one doc with `slashIdx === -1` per segment).
      selfMeta: SegmentMeta | null;
      // The most-recently-updated metadata among the portal doc and
      // descendants seen so far.
      maxOtherMeta: SegmentMeta | null;
    };

    // Keeps `entry.maxOtherMeta` as the doc with the greatest `updatedAt`
    // among the portal doc and every deeper descendant. Ties (or missing
    // timestamps) keep the latest-seen doc, which is an arbitrary but
    // deterministic tie-break — the acceptance criteria only fix the
    // *definition* (max updatedAt), not tie-break order.
    const considerOtherMeta = (entry: SegmentEntry, meta: SegmentMeta): void => {
      const currentTime = entry.maxOtherMeta?.updatedAt?.getTime() ?? -Infinity;
      const nextTime = meta.updatedAt?.getTime() ?? -Infinity;
      if (nextTime >= currentTime) {
        entry.maxOtherMeta = meta;
      }
    };

    const map = new Map<string, SegmentEntry>();
    for (const doc of docs) {
      // Skip the portal page for `path` itself (e.g. `/crowi/` when
      // querying `/crowi/`) — it is the parent, not a child.
      if (doc.path === prefix) continue;
      const rest = doc.path.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      const segment = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
      if (!segment) continue;
      let entry = map.get(segment);
      if (!entry) {
        entry = { segment, path: `${prefix}${segment}/`, isPage: false, hasPortal: false, count: 0, selfMeta: null, maxOtherMeta: null };
        map.set(segment, entry);
      }
      const meta: SegmentMeta = { updatedAt: doc.updatedAt, lastUpdateUser: doc.lastUpdateUser ?? null };
      if (slashIdx === -1) {
        // doc.path === `${prefix}${segment}` — the segment is a real page.
        entry.isPage = true;
        entry.selfMeta = meta;
      } else if (rest === `${segment}/`) {
        // doc.path === `${prefix}${segment}/` — a portal page. Only a
        // *published* portal earns the sidebar portal marker; a draft
        // portal (creator-visible via the status filter above) is not yet
        // a real portal, so it must not flag the node.
        entry.hasPortal = doc.status !== STATUS_DRAFT;
        considerOtherMeta(entry, meta);
      } else {
        // A deeper descendant (`${prefix}${segment}/...`).
        entry.count += 1;
        considerOtherMeta(entry, meta);
      }
    }

    const representatives = Array.from(map.values())
      // Drop phantom nodes that exist only because of a draft portal
      // (no real page, no published portal, no descendants) so a draft
      // portal never surfaces in the sidebar.
      .filter((e) => e.isPage || e.hasPortal || e.count > 0)
      .sort((a, b) => a.segment.localeCompare(b.segment))
      .map((e) => ({ entry: e, meta: e.isPage ? e.selfMeta : e.maxOtherMeta }));

    // Resolve `updater` with the single batched lookup described in the
    // doc comment above, over the distinct representative ids only.
    const updaterIds = new Set<string>();
    for (const { meta } of representatives) {
      if (meta?.lastUpdateUser) updaterIds.add(toStringId(meta.lastUpdateUser));
    }
    const userMap = new Map<string, PopulatedUser>();
    if (updaterIds.size > 0) {
      const User = crowi.model('User');
      const users: PopulatedUser[] = await User.find({ _id: { $in: Array.from(updaterIds).map((id) => new Types.ObjectId(id)) } })
        .select('username name email image createdAt')
        .lean()
        .exec();
      for (const u of users) {
        userMap.set(toStringId(u._id), u);
      }
    }

    return representatives.map(({ entry: e, meta }) => {
      const updaterDoc = meta?.lastUpdateUser ? userMap.get(toStringId(meta.lastUpdateUser)) : undefined;
      return {
        segment: e.segment,
        path: e.path,
        isPage: e.isPage,
        hasPortal: e.hasPortal,
        count: e.count,
        lastUpdatedAt: toISOStringOrNull(meta?.updatedAt),
        updater: updaterDoc ? toPageUser(updaterDoc) : null,
      };
    });
  };

  pageSchema.statics.findUnfurlablePages = async function (type, array, grants = [GRANT_PUBLIC, GRANT_RESTRICTED]) {
    const page = await Page.find({
      [type]: { $in: array },
      $or: grants.map((grant) => ({ grant })),
    });
    return page;
  };

  pageSchema.statics.findUnfurlablePagesByIds = async function (ids) {
    return Page.findUnfurlablePages('_id', ids);
  };

  pageSchema.statics.findUnfurlablePagesByPaths = async function (paths) {
    // `GRANT_RESTRICTED` pages can not be accessed using path
    return Page.findUnfurlablePages('path', paths, [GRANT_PUBLIC]);
  };

  pageSchema.statics.updatePageProperty = function (page, updateData, options?: { advanceEpoch?: boolean }) {
    // RFC-0017 Phase 1 §D1/§D10 — a lifecycle caller (rename / soft delete /
    // revert) folds the `collabLifecycleVersion` epoch `$inc` into THIS SAME
    // `updateOne` so the field write and the epoch advance land atomically:
    // there is no window where `path`/`status` is durable but the epoch
    // hasn't moved yet (or vice versa). Callers that don't pass
    // `advanceEpoch` (grant changes, metadata edits, …) are unaffected.
    const update = options?.advanceEpoch ? { $set: updateData, $inc: { collabLifecycleVersion: 1 } } : { $set: updateData };
    return Page.updateOne({ _id: page._id }, update);
  };

  /**
   * RFC-0021 §6.2 DC-10/DC-12 (Phase 2c-1) — delegates to `changePageVisibility`
   * so `PUT /pages/grant` and `updatePage`'s body+grant branch both go
   * through the same CAS-and-event command. `page` is left untouched until
   * the CAS commits (DC-12: `updatePage`'s failure path fires body-driven
   * side effects off the ORIGINAL `pageData`, which must still reflect the
   * DB's grant when that happens — there is no early mutation to undo).
   *
   * Populates `revision`/`creator` on the committed after-document before
   * returning it — `registerBacklinks` (`events/page.ts`, unconditional on
   * every 'update') needs `data.revision`/`data.creator` populated to
   * re-register backlinks, and a bare `findOneAndUpdate` result has
   * neither field populated. A populate failure here must not fail an
   * already-durable grant change (same "state change already committed,
   * don't fail the command over it" posture as DC-1's materialize-failure
   * handling) — it degrades to the unpopulated document, the same shape
   * `Page.rename`'s own 'update' emit already tolerates.
   *
   * Throws on every non-`committed` outcome so both existing callers
   * (which only ever used the resolved value, never a status) keep their
   * try/catch contract: `not-found` maps to the exact string
   * `hono/handlers/page.ts` already matches for its 404 branch;
   * `contended`/`rejected` map to a distinct, retry-hinting message so
   * that failure falls through to the handlers' generic 400.
   * `changePageVisibility`'s plan always rebuilds `grantedUsers`, even for
   * a same-grant call, so it never returns `noop`; that branch is
   * unreachable defense-in-depth.
   */
  pageSchema.statics.updateGrant = async function (page, grant, userData, options) {
    const outcome = await changePageVisibility(crowi, {
      pageId: page._id,
      toGrant: grant,
      actor: userData._id,
      source: options?.source,
    });

    if (outcome.status === 'not-found') {
      throw new Error('Page not found');
    }
    if (outcome.status !== 'committed') {
      throw new Error('Page grant update was not committed — retry');
    }

    let responsePage = outcome.page;
    try {
      responsePage = await responsePage.populate([
        { path: 'revision', model: 'Revision' },
        { path: 'creator', model: 'User' },
      ]);
    } catch (err) {
      debug('Page.updateGrant: failed to populate the committed document for page %s: %s', String(page._id), (err as Error)?.message ?? err);
    }

    page.grant = responsePage.grant;
    page.grantedUsers = responsePage.grantedUsers;

    debug('Page.updateGrant, saved grantedUsers.', responsePage.path);

    return responsePage;
  };

  // Instance method でいいのでは
  pageSchema.statics.pushToGrantedUsers = function (page, userData) {
    if (!page.grantedUsers || !Array.isArray(page.grantedUsers)) {
      page.grantedUsers = [];
    }
    page.grantedUsers.addToSet(userData);
    return page.save();
  };

  pageSchema.statics.pushRevision = async function (pageData, newRevision, user, options = {}) {
    const isCreate = pageData.revision === undefined;
    if (isCreate) {
      debug('pushRevision on Create');
    }

    await newRevision.save();

    debug('Successfully saved new revision', newRevision);

    pageData.revision = newRevision;
    // preserveTimestamps (body-rewrite migrations): keep the page's existing
    // lastUpdateUser / updatedAt so an `apply` neither bumps the page to the
    // top of recently-updated lists nor rewrites "last updated by" to the
    // migration bot. Skip the assignment entirely — a legacy page whose values
    // are null/undefined is therefore never overwritten with `undefined`.
    if (!options.preserveTimestamps) {
      pageData.lastUpdateUser = user;
      pageData.updatedAt = Date.now();
    }

    const data = await pageData.save();

    if (!isCreate) {
      debug('pushRevision on Update');
    }

    // RFC-0021 §D-1/§D-9 (Phase 2a) — the ONE call site for both routes
    // 1/2/3 of the spec's 5 content writers (create and update alike;
    // `isCreate` never gates this, see §D-9). Runs strictly AFTER the
    // pointer write above commits — sequence assignment is a separate,
    // resumable step, never folded into this save (§D-1). Never allowed to
    // turn a successful content save into a failed one (§D-6): the outcome
    // is logged at `debug` (pageId/revisionId/reason only, per the spec's
    // operator-output contract) and recovery is left to
    // `service/page-history/repair.ts` either way. No try/catch here on
    // purpose: `allocateContentSequence` collapses every internal failure
    // to `{ allocated: false, reason: 'contended' }` and never rejects, so
    // a catch around it would be unreachable.
    const outcome = await allocateContentSequence(crowi, pageData._id, newRevision._id);
    if (!outcome.allocated) {
      debug('pushRevision: allocateContentSequence did not allocate for page %s revision %s: %s', pageData._id, newRevision._id, outcome.reason);
    }

    return data;
  };

  pageSchema.statics.createPage = async function (path: string, body, user, options) {
    const Revision = crowi.model('Revision');
    const format = options.format || 'markdown';
    let grant = options.grant || GRANT_PUBLIC;
    const redirectTo = options.redirectTo || null;
    const allowNonExistentUserPage = options.allowNonExistentUserPage || false;

    if (!allowNonExistentUserPage) {
      const isNonExistentUserPage = await Page.isNonExistentUserPage(path);
      if (isNonExistentUserPage) {
        throw new Error('Cannot create non existent user page.');
      }
    }

    // force public
    if (isPortalPath(path)) {
      grant = GRANT_PUBLIC;
    }

    const pageData = await Page.findOne({ path });
    if (pageData) {
      throw new Error('Cannot create new page to existed path');
    }

    const newPage = await Page.create({
      path,
      creator: user,
      lastUpdateUser: user,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      redirectTo: redirectTo,
      grant: grant,
      status: STATUS_PUBLISHED,
      grantedUsers: user ? [user] : [],
    });

    const newRevision = await Revision.prepareRevision(newPage, body, user, { format, editVia: options.editVia });
    try {
      const revisionData = await Page.pushRevision(newPage, newRevision, user);
      pageEvent.emit('create', revisionData, user);
      return revisionData;
    } catch (err) {
      debug('Push Revision Error on create page', err);
      throw err;
    }
  };

  pageSchema.statics.updatePage = async function (pageData, body, user, options = {}) {
    const Revision = crowi.model('Revision');
    const Bookmark = crowi.model('Bookmark');
    const PageYjsUpdate = crowi.model('PageYjsUpdate');
    // Default to the page's CURRENT grant when the caller doesn't pass one, so a
    // body-only update leaves visibility untouched. A previous `options.grant ||
    // null` turned every grant-less call (e.g. `updatePage(page, body, user, {})`
    // from `rewritePageBody` / migrations) into `null != pageData.grant` → true,
    // which re-granted the page to `null` + `grantedUsers=[user]` — silently
    // dropping a public page out of `grant: GRANT_PUBLIC` listings. `??` keeps an
    // explicit grant change working while making "no grant option" mean "keep".
    const grant = options.grant ?? pageData.grant;
    // update existing page
    const newRevision = await Revision.prepareRevision(pageData, body, user, { editVia: options.editVia });

    // This is the external (REST / API) edit path — it bypasses the
    // collaborative editor. Per RFC-0003 §"Server-side direct Markdown
    // edits", a direct body write MUST drop the persisted Y.Doc snapshot so
    // the next `onLoadDocument` rebuilds a fresh doc from this revision
    // instead of restoring the pre-edit `yjsState` (which would show stale
    // content in the editor and, on its next autosave, silently revert this
    // edit). Re-point `currentRevision` to the new revision so that rebuild
    // (`currentRevision ?? revision`) seeds from the new body. The collab
    // save flow manages these fields itself and never routes through
    // `updatePage`, so this only affects external writes.
    pageData.currentRevision = newRevision;
    pageData.yjsState = null;
    pageData.yjsCheckpointAt = null;
    // RFC-0017 Phase 1 §D1 — `pushRevision` persists via `pageData.save()`
    // (not an atomic `updateOne`), so the epoch advance is folded into the
    // SAME read-modify-write instead of a separate `$inc`. This has a
    // theoretical lost-update window (a concurrent save() on the same
    // in-memory `pageData` could race), but the independent `{ _id,
    // currentRevision }` CAS in `executeSave` backstops it — this write
    // already moves `currentRevision`, so a stale collab doc is rejected by
    // that CAS regardless of whether this particular epoch increment lands.
    pageData.collabLifecycleVersion = (pageData.collabLifecycleVersion ?? 0) + 1;

    await Page.pushRevision(pageData, newRevision, user, { preserveTimestamps: options.preserveTimestamps });

    // feature-editor-preview-reliability (High, G1) — an external body write
    // abandons the persisted collab lineage (yjsState nulled above). The
    // pending `PageYjsUpdate` append rows descend from that OLD lineage, so a
    // fresh `onLoadDocument` materialisation would replay them on top of the
    // new revision body and auto-merge stale content back in (contradicting
    // the "external edit canonical, manual merge" design). Drop them here so
    // the next materialisation replays nothing. Best-effort + fire-and-forget:
    // a delete failure must never fail / delay the HTTP write, and the collab
    // load path has its own time-gated purge as a backstop. `onLoadDocument`
    // only re-applies rows that POSTDATE this new revision (genuine
    // not-yet-folded edits), so clearing the pre-edit rows is safe.
    void PageYjsUpdate.deleteMany({ pageId: pageData._id })
      .exec()
      .catch((err: unknown) => {
        debug('updatePage: PageYjsUpdate.deleteMany failed for page %s: %s', String(pageData._id), (err as Error)?.message ?? err);
      });
    const bookmarkCount = await Bookmark.countByPageId(pageData._id);

    // The 4th arg flags "a new revision was created" so events/page.ts can
    // fan out an UPDATE notification only for body updates (not rename /
    // metadata-only 'update' emits). updatePage always goes through
    // pushRevision above, so this path is always a new revision.
    if (grant != pageData.grant) {
      try {
        const data = await Page.updateGrant(pageData, grant, user, { source: options.editVia });
        pageEvent.emit('update', data, user, bookmarkCount, true);
        invalidateLiveCollabDoc(pageData._id);
        return data;
      } catch (err) {
        // RFC-0021 §6.2 DC-12 — the body write above (`pushRevision`) is
        // already durable by this point, so a grant-command failure
        // (`contended`/`rejected`, surfaced by `Page.updateGrant` as a
        // thrown `Error`) must not skip the body-driven side effects every
        // OTHER updatePage path fires unconditionally (search reindex,
        // backlinks, auto-watch, UPDATE notification, mention dispatch,
        // live-collab invalidation). `pageData` still reflects the DB's
        // grant here — `Page.updateGrant` never mutates it before its own
        // CAS commits — so emitting off it, then rethrowing, keeps
        // "the body saved" and "the grant didn't change" both true at
        // once: the response is 400, but everything the durable body
        // write is supposed to drive still ran.
        pageEvent.emit('update', pageData, user, bookmarkCount, true);
        invalidateLiveCollabDoc(pageData._id);
        throw err;
      }
    }
    pageEvent.emit('update', pageData, user, bookmarkCount, true);
    // feature-editor-preview-reliability G1 — this external edit just nulled
    // `yjsState` + bumped `currentRevision` (above). If a collab session is
    // live on this page in THIS process, the live Y.Doc is now stale: a
    // force-reload broadcast alone is a no-op under `unloadImmediately`
    // (the doc survives while ≥1 client stays connected), so we drive the
    // in-process invalidator (broadcast + tombstone + drain) AFTER the write
    // committed. Best-effort + fire-and-forget: it must never fail / delay
    // the HTTP write, and out-of-process / multi-instance live docs are out
    // of scope (RFC-0003 §5b — documented limitation).
    invalidateLiveCollabDoc(pageData._id);
    return pageData;
  };

  pageSchema.statics.deletePage = async function (pageData, user) {
    const Share = crowi.model('Share');
    const newPath = Page.getDeletedPageName(pageData.path);
    const isNonExistentUserPage = await Page.isNonExistentUserPage(pageData.path);
    if (Page.isDeletableName(pageData.path) || isNonExistentUserPage) {
      // RFC-0017 Phase 1 §D1/§D9/AC-21 — the epoch `$inc` rides the SAME
      // `updateOne` as the STATUS_DELETED write. The `throw` above (non-
      // deletable) never reaches this line, so a validation failure never
      // advances the epoch.
      await Page.updatePageProperty(pageData, { status: STATUS_DELETED, lastUpdateUser: user }, { advanceEpoch: true });
      pageData.status = STATUS_DELETED;

      // AC-23/AC-24 — emit + collab-lineage purge run IMMEDIATELY after the
      // status write is durable, so a throw in a later step (Share cleanup,
      // the `/trash/` rename below) can never suppress the reload prompt or
      // leave stale yjsState/PageYjsUpdate rows behind. The epoch already
      // advanced above regardless of either outcome.
      invalidateLiveCollabDoc(pageData._id, 'page-deleted');
      await purgeCollabLineage(pageData._id);

      await Share.deleteByPageId(pageData._id);

      // ページ名が /trash/ 以下に存在する場合、おかしなことになる
      // が、 /trash 以下にページが有るのは、個別に作っていたケースのみ。
      // 一応しばらく前から uncreatable pages になっているのでこれでいいことにする
      debug('Deleted the page, and rename it', pageData.path, newPath);
      // §D7/AC-25 — internal `/trash/` rename: the user-facing event is
      // `page-deleted` (already emitted above), so this rename's OWN prompt
      // is suppressed (`mode: 'skip'`) to avoid a spurious second
      // `page-renamed` broadcast. The epoch still advances (monotonic,
      // harmless) because `Page.rename`'s epoch `$inc` is unconditional.
      return Page.rename(pageData, newPath, user, { createRedirectPage: true, invalidation: { mode: 'skip', reason: 'internal-repair' } });
    }
    throw new Error('Page is not deletable.');
  };

  pageSchema.statics.revertDeletedPage = async function (pageData, user) {
    const newPath = Page.getRevertDeletedPageName(pageData.path);

    const isNonExistentUserPage = await Page.isNonExistentUserPage(newPath);
    if (isNonExistentUserPage) {
      throw new Error('Cannot revert non existent user page.');
    }

    // 削除時、元ページの path には必ず redirectTo 付きで、ページが作成される。
    // そのため、そいつは削除してOK
    // が、redirectTo ではないページが存在している場合それは何かがおかしい。(データ補正が必要)
    const originPageData = await Page.findPageByPath(newPath);
    if (originPageData.redirectTo !== pageData.path) {
      throw new Error('The new page of to revert is exists and the redirect path of the page is not the deleted page.');
    }

    // §D9/AC-28 — the redirect-origin stub cleanup is internal repair, not a
    // user-facing hard delete: skip its own `page-deleted` prompt.
    await Page.completelyDeletePage(originPageData, user, { invalidation: { mode: 'skip', reason: 'revert-deleted' } });
    // §D1 — status flip epoch-advances (same `updateOne`). This is the
    // correctness-load-bearing advance: once it lands, the pre-delete
    // yjsState/PageYjsUpdate lineage is stamped with a stale epoch and can
    // never be replayed by a future onLoadDocument (AC-29).
    await Page.updatePageProperty(pageData, { status: STATUS_PUBLISHED, lastUpdateUser: user }, { advanceEpoch: true });
    pageData.status = STATUS_PUBLISHED;

    debug('Revert deleted the page, and rename again it', pageData, newPath);
    // Internal restoration rename — skip its own prompt (§D7); epoch still
    // advances unconditionally.
    await Page.rename(pageData, newPath, user, { invalidation: { mode: 'skip', reason: 'revert-deleted' } });
    pageData.path = newPath;

    // §D9 — idempotent re-purge AFTER both epoch-advancing writes landed.
    // NOT load-bearing for correctness (the epoch advance above already
    // makes the pre-delete lineage non-replayable) — this only reclaims
    // storage / bounds how long deleted-era content is readable from the
    // append log, including any row appended mid-drain before the
    // `deletePage`-time purge ran (AC-29).
    await purgeCollabLineage(pageData._id);
    return pageData;
  };

  /**
   * This is danger.
   */
  pageSchema.statics.completelyDeletePage = async function (pageData, user, options) {
    // Delete Bookmarks, Attachments, Revisions, Pages and emit delete
    const Bookmark = crowi.model('Bookmark');
    const Attachment = crowi.model('Attachment');
    const Comment = crowi.model('Comment');
    const Activity = crowi.model('Activity');
    const pageId = pageData._id;
    // §D9/AC-26 — default `emit`: this is the typed USER-FACING hard-delete
    // call. `revertDeletedPage`'s internal redirect-origin cleanup passes
    // `mode: 'skip'` explicitly (see above) so a revert never double-fires
    // the user-facing prompt.
    const invalidation: PageRemovalInvalidation = options?.invalidation ?? { mode: 'emit', reason: 'page-deleted', target: 'live-page' };

    debug('Completely delete', pageData.path);

    await Bookmark.removeBookmarksByPageId(pageId);
    await Attachment.removeAttachmentsByPageId(pageId);
    await Comment.removeCommentsByPageId(pageId);

    // RFC-0021 §5.1/§5.6, DC-5 — same aggregation discipline as
    // `removePage` (see `attemptCleanupStep`/`throwIfCleanupIncomplete`),
    // applied to this method's own outer steps. `removePageById` (below) can
    // throw a `PageCleanupIncompleteError` even though the Page row IS
    // gone (its own inner cleanup partially failed) — that must not skip
    // THIS method's redirect-origin / Activity cleanup or the `delete`
    // event, so it is folded in below rather than left to propagate. Any
    // OTHER exception here means the Page row itself is not gone (the
    // failure happened before `removePage`'s own `Page.deleteOne`) — that
    // still propagates immediately, and none of the steps below run.
    const failures: CleanupFailures = { steps: [], causes: [] };

    try {
      // This method is the coalescing boundary (§D9: "completelyDeletePage は
      // removePageById(pageId, { mode: 'skip' }) を呼び自分の境界で1回
      // coalesced emit") — the inner `removePageById` never emits on its own,
      // avoiding a double-fire.
      await Page.removePageById(pageId, { invalidation: { mode: 'skip', reason: 'internal-cleanup' } });
    } catch (err) {
      if (!(err instanceof PageCleanupIncompleteError)) {
        throw err;
      }
      failures.steps.push(...err.steps);
      failures.causes.push(err);
    }

    // AC-26 — emit right after the target row is gone, BEFORE the
    // redirect-origin / activity cleanup below (which may throw without
    // suppressing the already-fired prompt; the row is physically deleted
    // either way, so there is nothing left for an epoch predicate to guard).
    emitInvalidationIfRequested(pageId, invalidation);

    await attemptCleanupStep(failures, 'redirect-origin', () => Page.removeRedirectOriginPageByPath(pageData.path));
    await attemptCleanupStep(failures, 'activity', () => Activity.removeByPage(pageId));

    pageEvent.emit('delete', pageData, user); // update as renamed page

    throwIfCleanupIncomplete(pageId, failures);

    return pageData;
  };

  pageSchema.statics.removePage = async function (pageData, options) {
    const Revision = crowi.model('Revision');
    const PageYjsUpdate = crowi.model('PageYjsUpdate');
    const { _id } = pageData;
    // §D9/AC-27 — default `skip`: most callers are internal cleanup
    // (`completelyDeletePage`'s own coalesced boundary,
    // `removeRedirectOriginPageByPath`'s recursion). The one user-facing
    // caller (draft cancel, `hono/handlers/draft.ts`) opts into `emit`
    // explicitly.
    const invalidation: PageRemovalInvalidation = options?.invalidation ?? { mode: 'skip', reason: 'internal-cleanup' };

    debug('Remove phisically, the page', _id);
    try {
      await Page.deleteOne({ _id });
    } catch (err) {
      debug(' --> error', _id);
      throw err;
    }
    emitInvalidationIfRequested(_id, invalidation);
    // §D9/AC-27 — privacy: the page row is gone, so any residual append-log
    // rows are now orphaned and would otherwise stay readable (raw
    // collection scan) until the 1h TTL sweeps them. Deleted unconditionally
    // (independent of emit/skip — this is hygiene, not a prompt). Best-
    // effort: the row is already physically removed, so a failure here can
    // never re-expose it (every collab load path rejects a missing page
    // before it would read `PageYjsUpdate`). Kept OUTSIDE the aggregated
    // cleanup below (RFC-0021 §5.6, DC-5) on purpose — this specific step
    // already has its own "already gone, can't re-expose it" contract, and
    // folding it in would change a best-effort swallow into a hard failure
    // the caller has to handle.
    try {
      await PageYjsUpdate.deleteMany({ pageId: _id }).exec();
    } catch (err) {
      debug('removePage: PageYjsUpdate.deleteMany failed for page %s: %s', String(_id), (err as Error)?.message ?? err);
    }

    // RFC-0021 §5.1/§5.6 (DC-5) — `Page.deleteOne` above is the point of no
    // return (caught and rethrown immediately, above): from here every
    // remaining step runs to completion regardless of an earlier one failing
    // (see `attemptCleanupStep`/`throwIfCleanupIncomplete`). id-based, so a
    // path later reused by a different page can never cause the revision
    // cleanup to delete the wrong page's revisions (see
    // `Revision.removeRevisionsByPageId`'s doc comment).
    const failures: CleanupFailures = { steps: [], causes: [] };

    await attemptCleanupStep(failures, 'revisions', () => Revision.removeRevisionsByPageId(_id));
    await attemptCleanupStep(failures, 'history-events', () => purgePageHistoryEvents(crowi, _id));

    throwIfCleanupIncomplete(_id, failures);

    return pageData;
  };

  pageSchema.statics.removePageById = async function (pageId, options) {
    const pageData = await Page.findPageById(pageId);
    await Page.removePage(pageData, options);
    return pageData;
  };

  pageSchema.statics.removePageByPath = async function (pagePath, options) {
    const pageData = await Page.findPageByPath(pagePath);
    await Page.removePage(pageData, options);
    return pageData;
  };

  /**
   * remove the page that is redirecting to specified `pagePath` recursively
   *  ex: when
   *    '/page1' redirects to '/page2' and
   *    '/page2' redirects to '/page3'
   *    and given '/page3',
   *    '/page1' and '/page2' will be removed
   *
   * @param {string} pagePath
   */
  // RFC-0021 §5.1/§5.6 (DC-5) — only "nothing redirects to this path" is a
  // terminal, swallowable case of the recursion; a failure from removing an
  // origin page (including `PageCleanupIncompleteError`, e.g. when that
  // origin page's own history-event purge fails) must propagate to the
  // caller's cleanup aggregation, not be folded into the same catch as
  // "doesn't exist".
  pageSchema.statics.removeRedirectOriginPageByPath = async function (pagePath) {
    const redirectOriginPageData = await Page.findOne({ redirectTo: pagePath });
    if (redirectOriginPageData === null) {
      return;
    }

    await Page.removePageById(redirectOriginPageData.id);
    await Page.removeRedirectOriginPageByPath(redirectOriginPageData.path);
  };

  pageSchema.statics.rename = async function (pageData, newPagePath, user, options: RenameOptions) {
    const Revision = crowi.model('Revision');
    const path = pageData.path;
    const createRedirectPage = options.createRedirectPage || false;
    const preserveUpdatedAt = options.preserveUpdatedAt || false;
    // §D7 — default `emit`: the typed user-facing / per-descendant rename
    // contract. Internal repair callers (soft-delete's `/trash/` rename,
    // `revertDeletedPage`'s restoration rename, user-page activation) pass
    // `mode: 'skip'` explicitly at their call sites.
    const invalidation: PageLifecycleInvalidation = options.invalidation ?? { mode: 'emit', reason: 'page-renamed' };

    const updatedAt = preserveUpdatedAt ? {} : { updatedAt: Date.now() };
    const updateData = { path: newPagePath, lastUpdateUser: user, ...updatedAt };

    // pageData の path を変更 — §D1: the epoch `$inc` rides this SAME
    // `updateOne`, unconditionally (independent of `invalidation.mode`).
    await Page.updatePageProperty(pageData, updateData, { advanceEpoch: true });

    // §D7/§6.1/AC-30 — emit immediately after the durable path write (and
    // BEFORE the `createRedirectPage` early return below), NOT after the
    // revision-path rewrite. `Revision.updateRevisionListByPath` and the
    // redirect-page creation are both best-effort follow-ups relative to
    // the path write that already made the rename durable and advanced the
    // epoch; if either throws, the reload prompt must still have fired —
    // wiring the emit any later would silently swallow it on that throw.
    emitInvalidationIfRequested(pageData._id, invalidation);

    // reivisions の path を変更 — DC-5: this is now a best-effort, DISPLAY-ONLY
    // sync of the denormalized `revision.path` string, not a
    // correctness-critical relationship update. History retrieval
    // (`hono/handlers/revision.ts` list/get routes, `Revision.removeRevisionsByPageId`,
    // `Revision.findAuthorsByPage`) resolves the owning page via the
    // immutable `revision.page` id set once in `prepareRevision`, so if this
    // step throws (as tested in `page-lifecycle-epoch.test.ts`), the
    // revisions are merely left showing a stale `path` in the wire response
    // — they are never lost from history.
    const data = await Revision.updateRevisionListByPath(path, { path: newPagePath });
    pageData.path = newPagePath;

    if (createRedirectPage) {
      const body = 'redirect ' + newPagePath;
      return Page.createPage(path, body, user, {
        redirectTo: newPagePath,
        allowNonExistentUserPage: true,
      });
    }
    pageEvent.emit('update', pageData, user); // update as renamed page
    return data;
  };

  pageSchema.statics.getPathMap = function (paths, search, replace) {
    search = removeTrailingSlash(search);
    replace = this.normalizePath(replace);
    const renamePath = (path) => path.replace(search, replace);
    // { [oldPath]: newPath }
    return paths.map(({ path }) => [path, renamePath(path)]).reduce((l, [k, v]) => Object.assign(l, { [k]: v }), {});
  };

  pageSchema.statics.checkPagesRenamable = async function (paths, user) {
    // A4-1 — this is the subtree-rename *preflight* validation, called with
    // every destination path of a `renameTree` (the whole subtree — no
    // upper bound, see `handlers/page.ts`'s `findListByStartWith(..., {
    // limit: 0 })`). Batch the per-path `Page.exists` + `findPageByPath`
    // lookups into `$in` queries, chunked so a very large subtree can't
    // build a single `$in` array large enough to hit MongoDB's 16MB BSON
    // command-size cap (which would throw here, before `renameTree` even
    // runs). `CHUNK_SIZE` is a conservative bound for typical page-path
    // lengths while keeping the round-trip count small.
    const CHUNK_SIZE = 500;
    const byPath = new Map<string, PageDocument>();
    for (let i = 0; i < paths.length; i += CHUNK_SIZE) {
      const chunk = paths.slice(i, i + CHUNK_SIZE);
      // No status/redirect/grant filter — mirrors `findPageByPath`
      // (`Page.findOne({ path })`), a plain path match. Visibility is
      // judged afterwards by the hydrated doc's `isUnlinkable(user)`
      // instance method, so `.lean()` is not used. Projection covers only
      // `isUnlinkable`'s dependencies (`isRedirectOriginPage` /
      // `isGrantedFor`) plus `path` (the Map key).
      const found = await Page.find({ path: { $in: chunk } }).select('path redirectTo grant creator grantedUsers');
      for (const p of found) {
        byPath.set(p.path, p);
      }
    }

    let error = false;
    let errors = {};
    for (const path of paths) {
      const e: string[] = [];
      if (!Page.isCreatableName(path)) {
        e.push('rename_tree.error.can_not_use_this_name');
      }
      const existing = byPath.get(path); // Page.exists({ path }) equivalent
      if (existing && !existing.isUnlinkable(user)) {
        // Page.findPageByPath(path) + isUnlinkable(user) equivalent
        e.push('rename_tree.error.already_exists');
      }
      if (!error && e.length > 0) {
        error = true;
      }
      errors = Object.assign(errors, { [path]: e });
    }
    return [error, errors];
  };

  pageSchema.statics.renameTree = async function (pathMap, user, options) {
    const { createRedirectPage = false, preserveUpdatedAt = true } = options;
    // Bound the fan-out: each rename emits a page `update` event that triggers
    // re-indexing / backlink / notification recomputation, so an unbounded
    // `Promise.all` over a large subtree would fire a reindex storm at the
    // search backend and Mongo. A small pool keeps the load steady while still
    // being far faster than fully sequential.
    await mapWithConcurrency(Object.values(pathMap), RENAME_TREE_CONCURRENCY, async (newPath) => {
      if (await Page.exists({ path: newPath })) {
        const newPage = await Page.findPageByPath(newPath);
        if (newPage.isUnlinkable(user)) {
          await newPage.unlink(user);
        } else {
          throw new Error(`Failed to create this page (${newPage.path}). It already exists.`);
        }
      }
    });
    // RFC-0017 Phase 1 §D8/AC-31 — allSettled-style reporting. `mapWithConcurrency`'s
    // worker loop has no cancellation (see its doc comment above): when one
    // item's `fn` throws, ONLY that worker's `Promise.all` leg rejects — the
    // OTHER in-flight workers keep pulling and completing later items
    // regardless, mutating the shared `results` array. Letting a per-item
    // failure propagate as a throw would therefore reject the overall call
    // while orphaning whatever those other workers finish afterward: real
    // renames that already landed (epoch advanced + `page-renamed` emitted
    // by `Page.rename`, §D7/AC-32) but would never be reported to the
    // caller. Catching per-item instead means every item always resolves
    // (nothing reaches `Promise.all` as a rejection), so nothing started
    // before OR after a sibling's failure is lost from the report.
    const outcomes = await mapWithConcurrency(
      Object.entries(pathMap),
      RENAME_TREE_CONCURRENCY,
      async ([oldPath, newPath]): Promise<{ ok: true; page: PageDocument } | { ok: false; oldPath: string; error: string }> => {
        try {
          const renameOptions: RenameOptions = {
            createRedirectPage: !isPortalPath(newPath) && createRedirectPage,
            preserveUpdatedAt,
          };
          const oldPage = await Page.findPageByPath(oldPath);
          // Per-page `Page.rename` epoch-advances + emits `page-renamed` for
          // ITS OWN documentName (default `mode: 'emit'`, §D7/AC-32) — a
          // subtree rename therefore invalidates every moved descendant's
          // live editor individually, not just the root.
          await Page.rename(oldPage, newPath, user, renameOptions);
          return { ok: true, page: oldPage };
        } catch (err) {
          return { ok: false, oldPath, error: `Failed to update page (${oldPath}).` };
        }
      },
    );

    const successes: PageDocument[] = [];
    const failures: { oldPath: string; error: string }[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        successes.push(outcome.page);
      } else {
        failures.push({ oldPath: outcome.oldPath, error: outcome.error });
      }
    }
    return { successes, failures };
  };

  pageSchema.statics.allPageCount = function () {
    const query: any = { redirectTo: null, grant: GRANT_PUBLIC };
    return Page.countDocuments(query); // TODO: option にする
  };

  pageSchema.methods.getNotificationTargetUsers = async function () {
    const Comment = crowi.model('Comment');
    const Revision = crowi.model('Revision');

    const [commentCreators, revisionAuthors] = await Promise.all([Comment.findCreatorsByPage(this), Revision.findAuthorsByPage(this)]);
    debug('commentCreators', commentCreators);
    debug('revisionAuthors', revisionAuthors);

    const targetUsers = [this.creator].concat(commentCreators, revisionAuthors);
    debug('targetUsers', targetUsers);

    const uniqueChecker = {};
    const uniqueUsers: Types.ObjectId[] = [];
    targetUsers.forEach(function (user) {
      const userId = user.toString();
      if (uniqueChecker[userId] !== 1) {
        uniqueUsers.push(user);
        uniqueChecker[userId] = 1;
      }
    });
    debug('uniqueUsers', uniqueUsers);

    return uniqueUsers;
  };

  // Backlink registration moved to events/page.ts (pageEvent.on('create'/'update'))
  // to avoid double-registration on every save and to fire only when content
  // actually changes via createPage / updatePage. See migrate-backlink task.

  const Page = model<PageDocument, PageModel>('Page', pageSchema);

  // 静的プロパティをスキーマではなくモデルに直接割り当て
  Page.GRANT_PUBLIC = GRANT_PUBLIC;
  Page.GRANT_RESTRICTED = GRANT_RESTRICTED;
  Page.GRANT_SPECIFIED = GRANT_SPECIFIED;
  Page.GRANT_OWNER = GRANT_OWNER;
  Page.PAGE_GRANT_ERROR = PAGE_GRANT_ERROR;
  Page.TYPE_PORTAL = TYPE_PORTAL;
  Page.TYPE_PUBLIC = TYPE_PUBLIC;
  Page.TYPE_USER = TYPE_USER;

  return Page;
};
