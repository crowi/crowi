import { Types } from 'mongoose';
import type { Page, Revision } from '@crowi/api-contract';
import type { PageDocument } from 'src/models/page';
import { type PopulatedUser, isPopulatedUser, toISOStringOrNull, toPageUser, toStringId } from './ts-rest-helpers';

/**
 * Shape of a populated `revision` field as it appears on Mongoose documents
 * after `.populate('revision', ...)`. `path` mirrors `Page.path` and `body`
 * is the markdown source. `author` may itself be populated (full user) or
 * remain an `ObjectId` ref — we narrow with `isPopulatedUser` at the call
 * site.
 */
export interface PopulatedRevision {
  _id: Types.ObjectId;
  path: string;
  body: string;
  format?: string;
  author?: PopulatedUser | null;
  createdAt?: Date;
}

/**
 * Looser shape than `PageDocument`: covers both Mongoose documents and the
 * plain objects produced by `.toObject()` / `.lean()`. Every field is
 * optional except `_id` + `path` so populated and unpopulated views (e.g.
 * search hit pre-populate) both fit.
 */
export interface PageLike {
  _id: Types.ObjectId | string;
  path: string;
  revision?: PopulatedRevision | Types.ObjectId | null;
  redirectTo?: string | null;
  status?: string | null;
  grant?: number;
  grantedUsers?: (Types.ObjectId | string)[];
  creator?: PopulatedUser | Types.ObjectId | null;
  lastUpdateUser?: PopulatedUser | Types.ObjectId | null;
  liker?: (Types.ObjectId | string)[];
  commentCount?: number;
  extended?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
  latestRevision?: Types.ObjectId | string;
  likerCount?: number;
  seenUsersCount?: number;
  toObject?: () => PageLike;
}

/**
 * Heuristic: a `revision` field is populated when it has the `_id` + `path`
 * + `body` triplet. Plain `ObjectId` refs only carry `_id`.
 */
export const isPopulatedRevision = (value: unknown): value is PopulatedRevision => {
  return typeof value === 'object' && value !== null && '_id' in value && 'path' in value && 'body' in value;
};

/**
 * Project a populated revision subdocument into the contract `Revision`
 * shape. `format` falls back to `'markdown'` (the legacy default), and
 * `createdAt` to "now" when the document predates the timestamps option.
 */
export const toRevisionResponse = (revision: PopulatedRevision): Revision => ({
  _id: revision._id.toString(),
  path: revision.path,
  body: revision.body,
  format: revision.format || 'markdown',
  author: revision.author ? toPageUser(revision.author) : null,
  createdAt: toISOStringOrNull(revision.createdAt) || new Date().toISOString(),
});

/**
 * Project a populated Page document (or plain `PageLike`) into the contract
 * `Page` schema shape. Used by `bookmark` / `user` / `search` ts-rest
 * routes; `routes/ts-rest/page.ts` keeps a slightly different local helper
 * (epoch fallback for `createdAt`, eslint-any disable) so the two are not
 * unified in this pass.
 *
 * - `revision`: only populated revisions are emitted; an unpopulated
 *   `ObjectId` ref collapses to `undefined` so the schema does not see an
 *   id-shaped object where it expects a populated revision.
 * - `creator` / `lastUpdateUser`: populated users go through `toPageUser`;
 *   unpopulated refs collapse to `null`.
 */
export const pageToResponse = (page: PageDocument | PageLike): Page => {
  const pageObj: PageLike = typeof (page as PageDocument).toObject === 'function' ? (page as PageDocument).toObject() : (page as PageLike);

  return {
    _id: toStringId(pageObj._id),
    path: pageObj.path,
    revision: pageObj.revision && isPopulatedRevision(pageObj.revision) ? toRevisionResponse(pageObj.revision) : undefined,
    redirectTo: pageObj.redirectTo || null,
    status: (pageObj.status as 'wip' | 'published' | 'deleted' | 'deprecated') || undefined,
    grant: pageObj.grant,
    grantedUsers: pageObj.grantedUsers?.map(toStringId) || [],
    creator: pageObj.creator && isPopulatedUser(pageObj.creator) ? toPageUser(pageObj.creator) : null,
    lastUpdateUser: pageObj.lastUpdateUser && isPopulatedUser(pageObj.lastUpdateUser) ? toPageUser(pageObj.lastUpdateUser) : null,
    liker: pageObj.liker?.map(toStringId) || [],
    commentCount: pageObj.commentCount || 0,
    extended: pageObj.extended,
    createdAt: toISOStringOrNull(pageObj.createdAt) || new Date().toISOString(),
    updatedAt: toISOStringOrNull(pageObj.updatedAt) || undefined,
    latestRevision: pageObj.latestRevision ? toStringId(pageObj.latestRevision) : undefined,
    likerCount: pageObj.likerCount,
    seenUsersCount: pageObj.seenUsersCount,
  };
};
