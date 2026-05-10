import { Types } from 'mongoose';
import type { Revision, RevisionMetaShape } from '@crowi/api-contract';
import type Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';
import { metadataToRevisionMeta, type RevisionMetaContent } from 'src/models/revision';
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
  meta?: RevisionMetaContent;
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

export interface RevisionResponseOptions {
  /**
   * Emit `revision.meta` (currently just `meta.toc`). Off by default —
   * only single-revision read paths (getPage, getRevision) consume it.
   * List endpoints (listPages, search hits, recently-viewed, bookmarks,
   * me) skip it: the TOC adds payload weight without being rendered.
   */
  withMeta?: boolean;
}

export const toRevisionResponse = (revision: PopulatedRevision, options: RevisionResponseOptions = {}): Revision => ({
  _id: revision._id.toString(),
  path: revision.path,
  body: revision.body,
  format: revision.format || 'markdown',
  author: revision.author ? toPageUser(revision.author) : null,
  createdAt: toISOStringOrNull(revision.createdAt) || EPOCH_ISO,
  // Sync path: only emits stored meta. Single-page / single-revision
  // read paths that want the on-the-fly fallback for legacy revisions
  // use `computeRevisionMetaAsync` after the response is built.
  meta: resolveRevisionMeta(revision.meta, options.withMeta),
});

export const resolveRevisionMeta = (stored: RevisionMetaContent | undefined, emit: boolean | undefined): RevisionMetaShape | undefined => {
  if (!emit) return undefined;
  if (!stored) return undefined;
  const out = pickStoredMeta(stored);
  return Object.keys(out).length > 0 ? out : undefined;
};

// Avoids leaking Mongoose internals (the document carries `$__` etc.)
// into the response shape.
function pickStoredMeta(stored: RevisionMetaContent): RevisionMetaShape {
  const out: RevisionMetaShape = {};
  if (stored.toc !== undefined) out.toc = stored.toc;
  if (stored.wikiLinks !== undefined) out.wikiLinks = stored.wikiLinks;
  if (stored.mentions !== undefined) out.mentions = stored.mentions;
  if (stored.codeBlockLanguages !== undefined) out.codeBlockLanguages = stored.codeBlockLanguages;
  return out;
}

/**
 * Async fallback compute: runs the unified pipeline once to produce
 * the 4 meta fields when stored meta is missing on legacy revisions.
 * Single-page detail / single-revision endpoints call this AFTER
 * `pageToResponse` to attach meta to the response without making the
 * entire pageToResponse path async (which would cascade through 12+
 * call sites that don't need meta at all).
 *
 * Phase 2-written revisions persist all 4 fields (even as empty
 * arrays), so the presence of `wikiLinks` / `mentions` /
 * `codeBlockLanguages` is the marker that no fallback is needed. Phase
 * 1 revisions only have `toc`, so we re-run the pipeline to fill the
 * other 3 — but stored `toc` (the authoritative anchor ids that
 * page-content's heading stamper aligns against) wins on merge.
 */
export const computeRevisionMetaAsync = async (
  crowi: Crowi,
  stored: RevisionMetaContent | undefined,
  body: string,
  emit: boolean | undefined,
): Promise<RevisionMetaShape | undefined> => {
  if (!emit) return undefined;
  const fromStored = stored ? pickStoredMeta(stored) : {};
  if (fromStored.wikiLinks !== undefined && fromStored.mentions !== undefined && fromStored.codeBlockLanguages !== undefined) {
    return Object.keys(fromStored).length > 0 ? fromStored : undefined;
  }
  const computed = await crowi.getRenderer().runMetadata(body || '', { mode: 'read' });
  const merged: RevisionMetaShape = { ...pickStoredMeta(metadataToRevisionMeta(computed)), ...fromStored };
  return Object.keys(merged).length > 0 ? merged : undefined;
};

export type PageToResponseOptions = RevisionResponseOptions;

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
export const pageToResponse = (page: PageDocument | PageLike, options: PageToResponseOptions = {}): any => {
  const pageObj: PageLike = typeof (page as PageDocument).toObject === 'function' ? (page as PageDocument).toObject() : (page as PageLike);
  // likerCount / seenUsersCount are dynamic properties set by populatePageData
  // on the Mongoose document; toObject() drops them, so read off the original.
  const dynamic = page as PageLike;

  return {
    _id: toStringId(pageObj._id),
    path: pageObj.path,
    revision: pageObj.revision && isPopulatedRevision(pageObj.revision) ? toRevisionResponse(pageObj.revision, { withMeta: options.withMeta }) : undefined,
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
