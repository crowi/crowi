import type { InvalidateReason } from '@crowi/collab';
import Debug from 'debug';
import { Document, Model, model, Schema, Types } from 'mongoose';
import Crowi from 'src/crowi';
import { RevisionDocument } from './revision';
import { UserDocument } from './user';

export const GRANT_PUBLIC = 1;
export const GRANT_RESTRICTED = 2;
export const GRANT_SPECIFIED = 3;
export const GRANT_OWNER = 4;
export const GRANTS = [GRANT_PUBLIC, GRANT_RESTRICTED, GRANT_SPECIFIED, GRANT_OWNER] as const;
export const PAGE_GRANT_ERROR = 1;
export const STATUS_WIP = 'wip';
export const STATUS_PUBLISHED = 'published';
export const STATUS_DELETED = 'deleted';
export const STATUS_DEPRECATED = 'deprecated';
/**
 * RFC-0004: first-class draft state. A page created via `POST
 * /api/v2/pages/drafts` (Phase 3) starts as `draft` and transitions to
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
  findPageByRedirectTo(path): any;
  findPagesByIds(ids): any;
  findListByCreator(user, option, currentUser): any;
  getStreamOfFindAll(options?): any;
  findListByStartWith(path, userData, option): Promise<PageDocument[]>;
  findChildrenByPath(path, userData, option): any;
  findChildSegments(path, userData): Promise<Array<{ segment: string; path: string; isPage: boolean; hasPortal: boolean; count: number }>>;
  findUnfurlablePages(type, array, grants?: number[]): any;
  findUnfurlablePagesByIds(ids): any;
  findUnfurlablePagesByPaths(paths): any;
  updatePageProperty(page, updateData, options?: { advanceEpoch?: boolean }): any;
  updateGrant(page, grant, userData): any;
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

/** RFC-0017 Phase 1 §D8 — `renameTree` allSettled-style outcome. */
export interface RenameTreeResult {
  /** The pre-rename `PageDocument`s that renamed successfully. */
  successes: PageDocument[];
  /** Per-path failures — a subtree rename never rolls back a partial success. */
  failures: { oldPath: string; error: string }[];
}

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
    },
    {
      toJSON: { getters: true },
      toObject: { getters: true },
    },
  );

  // RFC-0004: backs `GET /api/v2/pages/drafts` — `find({ creator, status })`
  // sorted by `createdAt` desc. Without it the listing scans a single-field
  // index then sorts in memory.
  pageSchema.index({ creator: 1, status: 1, createdAt: -1 });

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
        { new: true },
      );

      if (updated) {
        // Matched: the write committed atomically against a still-eligible
        // document, and `{ new: true }` handed back that exact post-write
        // state — no separate re-read window for a concurrent delete to
        // land in between write and response.
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

  pageSchema.statics.findPageByRedirectTo = async function (path) {
    const pageData = await Page.findOne({ redirectTo: path });

    if (pageData === null) {
      throw new Error('Page not found');
    }

    return pageData;
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
    const conditions: any = {
      creator: user._id,
      redirectTo: null,
      $or: visiblePageStatusOr(currentUser._id, user._id),
    };

    if (!user.equals(currentUser._id)) {
      conditions.grant = GRANT_PUBLIC;
    }

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
    const pathCondition: Record<string, string | RegExp>[] = [];
    const includeDeletedPage = option.includeDeletedPage || false;

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
    const queryReg = new RegExp('^' + path);
    // var sliceOption = option.revisionSlice || { $slice: 1 }

    pathCondition.push({ path: queryReg });
    if (path.match(/\/$/) && path.length > 1) {
      debug('Page list by ending with /, so find also upper level page');
      pathCondition.push({ path: path.substr(0, path.length - 1) });
    }

    // FIXME: might be heavy
    const query: any = {
      redirectTo: null,
      $or: visiblePageGrantOr(userData._id),
    };
    debug('findListByStartWith query:', JSON.stringify({ path, opt, pathCondition, userData: userData._id }));
    const q = Page.find(query)
      .populate({ path: 'revision', populate: { path: 'author', model: 'User' } })
      .and({
        $or: pathCondition,
      } as any)
      .sort(sortOpt)
      .skip(opt.offset)
      .limit(opt.limit);

    if (!includeDeletedPage) {
      q.and({
        $or: visiblePageStatusOr(userData._id),
      } as any);
    }

    return q.exec().then((results) => {
      debug('findListByStartWith results count:', results.length);
      return results;
    });
  };

  pageSchema.statics.findChildrenByPath = async function (path, userData, option) {
    path = addTrailingSlash(path);
    return Page.findListByStartWith(path, userData, { limit: 0, ...option });
  };

  /**
   * Aggregate the immediate child "directories" (next path segment)
   * directly under a portal `path`, for the sidebar tree. Returns one
   * entry per distinct first segment beneath `path`, with whether a
   * real portal page is saved there (`hasPortal` → compass icon) and a
   * descendant count.
   *
   * Implemented as a lean `path`-only scan + in-process grouping rather
   * than a `$group` aggregation: extracting "the segment after the
   * prefix" is awkward in MongoDB's expression language, and a portal's
   * subtree is bounded. Visibility (grant + draft status) is enforced
   * with the same `$or` predicates as the listing endpoints so the
   * sidebar never leaks a page the viewer can't open.
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
    const docs: Array<{ path: string; status?: string | null }> = await Page.find(query, { path: 1, status: 1 }).lean().exec();

    const map = new Map<string, { segment: string; path: string; isPage: boolean; hasPortal: boolean; count: number }>();
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
        entry = { segment, path: `${prefix}${segment}/`, isPage: false, hasPortal: false, count: 0 };
        map.set(segment, entry);
      }
      if (slashIdx === -1) {
        // doc.path === `${prefix}${segment}` — the segment is a real page.
        entry.isPage = true;
      } else if (rest === `${segment}/`) {
        // doc.path === `${prefix}${segment}/` — a portal page. Only a
        // *published* portal earns the sidebar portal marker; a draft
        // portal (creator-visible via the status filter above) is not yet
        // a real portal, so it must not flag the node.
        entry.hasPortal = doc.status !== STATUS_DRAFT;
      } else {
        // A deeper descendant (`${prefix}${segment}/...`).
        entry.count += 1;
      }
    }
    return (
      Array.from(map.values())
        // Drop phantom nodes that exist only because of a draft portal
        // (no real page, no published portal, no descendants) so a draft
        // portal never surfaces in the sidebar.
        .filter((e) => e.isPage || e.hasPortal || e.count > 0)
        .sort((a, b) => a.segment.localeCompare(b.segment))
    );
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

  pageSchema.statics.updateGrant = async function (page, grant, userData) {
    page.grant = grant;
    page.grantedUsers = [];
    if (grant !== GRANT_PUBLIC) {
      page.grantedUsers.addToSet(userData._id);
      // Keep the creator granted even when someone else (e.g. an admin) is
      // the one changing the grant, so `grantedUsers` never drifts out of
      // sync with `visiblePageGrantOr`'s creator clause / `isGrantedFor`'s
      // `isCreator` shortcut.
      page.grantedUsers.addToSet(page.creator);
    }

    const data = await page.save();

    debug('Page.updateGrant, saved grantedUsers.', (data && data.path) || {});

    return data;
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

    const data = pageData.save();

    if (!isCreate) {
      debug('pushRevision on Update');
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
      const data = await Page.updateGrant(pageData, grant, user);
      pageEvent.emit('update', data, user, bookmarkCount, true);
      invalidateLiveCollabDoc(pageData._id);
      return data;
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
    // This method is the coalescing boundary (§D9: "completelyDeletePage は
    // removePageById(pageId, { mode: 'skip' }) を呼び自分の境界で1回
    // coalesced emit") — the inner `removePageById` never emits on its own,
    // avoiding a double-fire.
    await Page.removePageById(pageId, { invalidation: { mode: 'skip', reason: 'internal-cleanup' } });
    // AC-26 — emit right after the target row is gone, BEFORE the
    // redirect-origin / activity cleanup below (which may throw without
    // suppressing the already-fired prompt; the row is physically deleted
    // either way, so there is nothing left for an epoch predicate to guard).
    emitInvalidationIfRequested(pageId, invalidation);
    await Page.removeRedirectOriginPageByPath(pageData.path);
    await Activity.removeByPage(pageId);

    pageEvent.emit('delete', pageData, user); // update as renamed page

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
    // before it would read `PageYjsUpdate`).
    try {
      await PageYjsUpdate.deleteMany({ pageId: _id }).exec();
    } catch (err) {
      debug('removePage: PageYjsUpdate.deleteMany failed for page %s: %s', String(_id), (err as Error)?.message ?? err);
    }
    await Revision.removeRevisionsByPath(pageData.path);
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
  pageSchema.statics.removeRedirectOriginPageByPath = function (pagePath) {
    return Page.findPageByRedirectTo(pagePath)
      .then((redirectOriginPageData) => {
        // remove
        return (
          Page.removePageById(redirectOriginPageData.id)
            // remove recursive
            .then(() => {
              return Page.removeRedirectOriginPageByPath(redirectOriginPageData.path);
            })
        );
      })
      .catch((err) => {
        // do nothing if origin page doesn't exist
        return Promise.resolve();
      });
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

    // reivisions の path を変更
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
