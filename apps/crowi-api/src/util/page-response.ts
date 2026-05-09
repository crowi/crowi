import { Types } from 'mongoose';
import type { Revision } from '@crowi/api-contract';
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

// Epoch fallback (not "now") so a document missing timestamps doesn't
// look like it was just created — schema only requires the field be set.
const EPOCH_ISO = new Date(0).toISOString();

export const toRevisionResponse = (revision: PopulatedRevision): Revision => ({
  _id: revision._id.toString(),
  path: revision.path,
  body: revision.body,
  format: revision.format || 'markdown',
  author: revision.author ? toPageUser(revision.author) : null,
  createdAt: toISOStringOrNull(revision.createdAt) || EPOCH_ISO,
});

/**
 * Project a populated Page document (or plain `PageLike`) into the contract
 * Page shape. Unpopulated refs collapse safely:
 *   - revision: ObjectId-ref → undefined
 *   - creator / lastUpdateUser: ObjectId-ref → null
 *
 * Returns `any` because the runtime shape satisfies either `Page` or
 * `PageWithRevision` depending on whether revision was populated; ts-rest
 * contracts pin one or the other and each handler narrows at its return.
 */
// biome-ignore lint/suspicious/noExplicitAny: see jsdoc
export const pageToResponse = (page: PageDocument | PageLike): any => {
  const pageObj: PageLike = typeof (page as PageDocument).toObject === 'function' ? (page as PageDocument).toObject() : (page as PageLike);
  // likerCount / seenUsersCount are dynamic properties set by populatePageData
  // on the Mongoose document; toObject() drops them, so read off the original.
  const dynamic = page as PageLike;

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
    createdAt: toISOStringOrNull(pageObj.createdAt) || EPOCH_ISO,
    updatedAt: toISOStringOrNull(pageObj.updatedAt) || undefined,
    latestRevision: pageObj.latestRevision ? toStringId(pageObj.latestRevision) : undefined,
    likerCount: dynamic.likerCount,
    seenUsersCount: dynamic.seenUsersCount,
  };
};
