import { Types } from 'mongoose';
import type { Revision, RevisionMetaShape } from '@crowi/api-contract';
import type Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';
import { metadataToRevisionMeta, type RevisionMetaContent } from 'src/models/revision';
import { RENDERER_PIPELINE_VERSION } from 'src/renderer/version';
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
  /** RFC-0002 Phase 3 — transformed mdast persisted verbatim. */
  renderedAst?: unknown;
  /** RFC-0002 round 3.1 — semver of the pipeline that produced `renderedAst`. */
  rendererVersion?: string;
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
  /**
   * RFC-0002 Phase 3: emit `revision.renderedAst` (transformed mdast
   * the web client renders directly). Off by default — list endpoints
   * skip it because the AST is 5-10x the body size in JSON form.
   * Only single-page detail (getPage) and single-revision detail
   * (getRevision) opt in. Legacy revisions without a stored
   * `renderedAst` are filled in by `computeRevisionRenderedAstAsync`.
   */
  withRenderedAst?: boolean;
}

export const toRevisionResponse = (revision: PopulatedRevision, options: RevisionResponseOptions = {}): Revision => ({
  _id: revision._id.toString(),
  path: revision.path,
  body: revision.body,
  format: revision.format || 'markdown',
  author: revision.author ? toPageUser(revision.author) : null,
  createdAt: toISOStringOrNull(revision.createdAt) || EPOCH_ISO,
  // Sync path: only emits stored meta + renderedAst. Detail endpoints
  // (getPage, getRevision) compose with `computeRevisionRenderArtifactsAsync`
  // afterwards to fold in the on-the-fly fallback for legacy revisions.
  meta: resolveRevisionMeta(revision.meta, options.withMeta),
  ...(options.withRenderedAst ? { renderedAst: revision.renderedAst, rendererVersion: revision.rendererVersion } : {}),
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
 * Async fallback compute for revision render artifacts (meta +
 * renderedAst). Detail endpoints (getPage, getRevision) call this AFTER
 * `pageToResponse` so the projection path stays sync; meta + AST get
 * attached to the populated revision response in one go.
 *
 * Why one call instead of two: legacy revisions (Phase 1: only `toc`
 * stored / Phase 2: meta but no `renderedAst`) would otherwise trigger
 * back-to-back `runMetadata` + `runRender` invocations, each running a
 * full parse+transform+shiki pipeline on the same body. `runRender`
 * already produces both, so fold the calls into one and pull the
 * needed pieces out.
 *
 * Stored values stay authoritative on merge: Phase 1's `toc` (the
 * anchor ids the heading stamper aligns against) wins over recomputed
 * ones, and a stored `renderedAst` is returned verbatim without
 * re-rendering.
 */
export const computeRevisionRenderArtifactsAsync = async (
  crowi: Crowi,
  storedMeta: RevisionMetaContent | undefined,
  storedAst: unknown,
  body: string,
  storedRendererVersion?: string,
  pageId?: string,
): Promise<{ meta?: RevisionMetaShape; renderedAst?: unknown }> => {
  const fromStored = storedMeta ? pickStoredMeta(storedMeta) : {};
  // Phase 2-written revisions persist all 4 meta fields (even empty
  // arrays); the presence of these 3 is the marker that no fallback
  // is needed for meta.
  const metaIsComplete = fromStored.wikiLinks !== undefined && fromStored.mentions !== undefined && fromStored.codeBlockLanguages !== undefined;
  const astIsStored = storedAst !== undefined;
  // RFC-0002 round 3.1: a stored `rendererVersion` that does NOT match
  // the running pipeline marks the AST as stale. A missing
  // `rendererVersion` (revisions saved before this field landed) is
  // treated as "trust the stored AST" — re-rendering every pre-existing
  // revision on every read would be unaffordable, and the user-facing
  // workaround (re-save the page) is already documented. Once
  // `renderer:rebuild` lands (RFC-0008), operators can backfill.
  const astIsFresh = astIsStored && (storedRendererVersion === undefined || storedRendererVersion === RENDERER_PIPELINE_VERSION);

  if (metaIsComplete && astIsFresh) {
    return {
      meta: Object.keys(fromStored).length > 0 ? fromStored : undefined,
      renderedAst: storedAst,
    };
  }
  if (!body) {
    return {
      meta: metaIsComplete && Object.keys(fromStored).length > 0 ? fromStored : undefined,
      renderedAst: astIsFresh ? storedAst : undefined,
    };
  }

  // `pageId` threads through so the Phase 4+ plugin-dispatch transforms
  // (embed-tag / url-inline-expand / code-block) can fire on the
  // fallback path the same way they do at save time. Callers that
  // genuinely don't know the page (unit tests, orphan revision bodies)
  // can omit it — dispatch then degrades to no-op and the `code` /
  // `@[tag](url)` nodes survive as plain text.
  const { metadata, renderedAst } = await crowi.getRenderer().runRender(body, { mode: 'read', pageId });
  const mergedMeta: RevisionMetaShape = { ...pickStoredMeta(metadataToRevisionMeta(metadata)), ...fromStored };
  return {
    meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined,
    renderedAst: astIsFresh ? storedAst : renderedAst,
  };
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
    revision:
      pageObj.revision && isPopulatedRevision(pageObj.revision)
        ? toRevisionResponse(pageObj.revision, { withMeta: options.withMeta, withRenderedAst: options.withRenderedAst })
        : undefined,
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
