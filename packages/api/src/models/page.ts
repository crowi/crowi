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
 * pages only when the user is in `grantedUsers`.
 */
export function visiblePageGrantOr(userId: Types.ObjectId | string): Array<Record<string, unknown>> {
  return [
    { grant: null },
    { grant: GRANT_PUBLIC },
    { grant: GRANT_RESTRICTED, grantedUsers: userId },
    { grant: GRANT_SPECIFIED, grantedUsers: userId },
    { grant: GRANT_OWNER, grantedUsers: userId },
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
  findPage(path, userData, revisionId?, ignoreNotFound?): Promise<PageDocument | null>;
  findPageByPath(path): Promise<PageDocument>;
  isExistByPath(path): any;
  isExistById(id): any;
  isNonExistentUserPage(path: string): Promise<boolean>;
  isNonExistentUserTrashPage(path: string): Promise<boolean>;
  findListByPageIds(ids, options): any;
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
  updatePageProperty(page, updateData): any;
  updateGrant(page, grant, userData): any;
  pushToGrantedUsers(page, userData): any;
  pushRevision(pageData, newRevision, user, options?: PushRevisionOptions): any;
  createPage(path, body, user, options): any;
  updatePage(pageData: PageDocument, body, user, options: UpdatePageOptions): any;
  deletePage(pageData: PageDocument, user): any;
  revertDeletedPage(pageData: PageDocument, user): Promise<PageDocument>;
  completelyDeletePage(pageData: PageDocument, user?): Promise<PageDocument>;
  removePage(pageData: PageDocument): any;
  removePageById(pageId): any;
  removePageByPath(pagePath): any;
  removeRedirectOriginPageByPath(pagePath): any;
  rename(pageData, newPagePath, user, options): any;
  getPathMap(paths, search, replace): any;
  checkPagesRenamable(paths, user): any;
  renameTree(pathMap, user, options): any;
  allPageCount(): any;
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:page');
  const pageEvent = crowi.event('Page');

  /**
   * feature-editor-preview-reliability G1 — drive the in-process collab
   * external-edit invalidator after an external write (`updatePage`) commits.
   * Fire-and-forget: the invalidator is itself best-effort and never throws,
   * but we still guard the call so an absent attachment (CLI / tests / boot
   * not yet finished) or a synchronous throw can never bubble into the write.
   *
   * Multi-instance / out-of-process is out of scope (RFC-0003 §5b): the
   * handle only reaches docs live in THIS api process. A live doc on another
   * replica needs future Redis pub/sub — documented in the realtime-collab
   * operations doc.
   */
  function invalidateLiveCollabDoc(pageId: Types.ObjectId | string): void {
    const attachment = crowi.collabAttachment;
    if (!attachment) return;
    void attachment.invalidatePages([String(pageId)], 'page-body-replaced').catch((err: unknown) => {
      debug('collab invalidatePages failed for page %s: %s', String(pageId), (err as Error)?.message ?? err);
    });
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

    if (this.grantedUsers.indexOf(userData._id) >= 0) {
      return true;
    }

    return false;
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
    pageData.latestRevision = pageData.revision;
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

  pageSchema.statics.findListByPageIds = function (ids, options) {
    options = options || {};
    const limit = options.limit || 50;
    const offset = options.skip || 0;

    return (
      Page.find({ _id: { $in: ids } })
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

  pageSchema.statics.updatePageProperty = function (page, updateData) {
    return Page.updateOne({ _id: page._id }, { $set: updateData });
  };

  pageSchema.statics.updateGrant = async function (page, grant, userData) {
    page.grant = grant;
    if (grant == GRANT_PUBLIC) {
      page.grantedUsers = [];
    } else {
      page.grantedUsers = [];
      page.grantedUsers.addToSet(userData._id);
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
      await Page.updatePageProperty(pageData, { status: STATUS_DELETED, lastUpdateUser: user });
      await Share.deleteByPageId(pageData._id);
      pageData.status = STATUS_DELETED;

      // ページ名が /trash/ 以下に存在する場合、おかしなことになる
      // が、 /trash 以下にページが有るのは、個別に作っていたケースのみ。
      // 一応しばらく前から uncreatable pages になっているのでこれでいいことにする
      debug('Deleted the page, and rename it', pageData.path, newPath);
      return Page.rename(pageData, newPath, user, { createRedirectPage: true });
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

    await Page.completelyDeletePage(originPageData);
    await Page.updatePageProperty(pageData, { status: STATUS_PUBLISHED, lastUpdateUser: user });
    pageData.status = STATUS_PUBLISHED;

    debug('Revert deleted the page, and rename again it', pageData, newPath);
    await Page.rename(pageData, newPath, user, {});
    pageData.path = newPath;
    return pageData;
  };

  /**
   * This is danger.
   */
  pageSchema.statics.completelyDeletePage = async function (pageData, user) {
    // Delete Bookmarks, Attachments, Revisions, Pages and emit delete
    const Bookmark = crowi.model('Bookmark');
    const Attachment = crowi.model('Attachment');
    const Comment = crowi.model('Comment');
    const Activity = crowi.model('Activity');
    const pageId = pageData._id;

    debug('Completely delete', pageData.path);

    await Bookmark.removeBookmarksByPageId(pageId);
    await Attachment.removeAttachmentsByPageId(pageId);
    await Comment.removeCommentsByPageId(pageId);
    await Page.removePageById(pageId);
    await Page.removeRedirectOriginPageByPath(pageData.path);
    await Activity.removeByPage(pageId);

    pageEvent.emit('delete', pageData, user); // update as renamed page

    return pageData;
  };

  pageSchema.statics.removePage = async function (pageData) {
    const Revision = crowi.model('Revision');
    const { _id } = pageData;

    debug('Remove phisically, the page', _id);
    try {
      await Page.deleteOne({ _id });
    } catch (err) {
      debug(' --> error', _id);
      throw err;
    }
    await Revision.removeRevisionsByPath(pageData.path);
    return pageData;
  };

  pageSchema.statics.removePageById = async function (pageId) {
    const pageData = await Page.findPageById(pageId);
    await Page.removePage(pageData);
    return pageData;
  };

  pageSchema.statics.removePageByPath = async function (pagePath) {
    const pageData = await Page.findPageByPath(pagePath);
    await Page.removePage(pageData);
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

  pageSchema.statics.rename = async function (pageData, newPagePath, user, options) {
    const Revision = crowi.model('Revision');
    const path = pageData.path;
    const createRedirectPage = options.createRedirectPage || false;
    const preserveUpdatedAt = options.preserveUpdatedAt || false;

    const updatedAt = preserveUpdatedAt ? {} : { updatedAt: Date.now() };
    const updateData = { path: newPagePath, lastUpdateUser: user, ...updatedAt };

    // pageData の path を変更
    await Page.updatePageProperty(pageData, updateData);
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
    let error = false;
    let errors = {};
    for (const path of paths) {
      const e: string[] = [];
      if (!Page.isCreatableName(path)) {
        e.push('rename_tree.error.can_not_use_this_name');
      }
      const isAlreadyExists = await Page.exists({ path });
      if (isAlreadyExists) {
        const newPage = await Page.findPageByPath(path);
        if (!newPage.isUnlinkable(user)) {
          e.push('rename_tree.error.already_exists');
        }
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
    return mapWithConcurrency(Object.entries(pathMap), RENAME_TREE_CONCURRENCY, async ([oldPath, newPath]) => {
      try {
        const options = {
          createRedirectPage: !isPortalPath(newPath) && createRedirectPage,
          preserveUpdatedAt,
        };
        const oldPage = await Page.findPageByPath(oldPath);
        await Page.rename(oldPage, newPath, user, options);
        return oldPage;
      } catch (err) {
        throw new Error(`Failed to update page (${oldPath}).`);
      }
    });
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
