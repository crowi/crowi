import type { Revision, RevisionMetaShape } from '@crowi/api-contract';
import type { RenderActor, RenderContext } from '@crowi/plugin-api';
import type { Root } from 'mdast';
import { Types } from 'mongoose';
import type Crowi from 'src/crowi';
import type { PageDocument } from 'src/models/page';
import { metadataToRevisionMeta, type RevisionMetaContent } from 'src/models/revision';
import { coreLogger } from 'src/renderer';
import { hasPendingRenderMarker, redispatchPendingCodeBlocks } from 'src/renderer/core';
import { RENDERER_PIPELINE_VERSION } from 'src/renderer/version';
import { isPopulatedUser, type PopulatedUser, toISOStringOrNull, toPageUser, toStringId } from './ts-rest-helpers';

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
  /** RFC-0010 — edit channel ('web' | 'oauth' | 'pat'); absent = web. */
  editVia?: 'web' | 'oauth' | 'pat';
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
  ...(revision.editVia !== undefined ? { editVia: revision.editVia } : {}),
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
  // feature-backlink-raw-space-metadata: additive field, picked the same
  // way as the other 3 — but deliberately NOT part of `metaIsComplete`
  // below (see that constant's comment).
  if (stored.rawSpaceLinks !== undefined) out.rawSpaceLinks = stored.rawSpaceLinks;
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
  actor: RenderActor,
  storedRendererVersion?: string,
  pageId?: string,
): Promise<{ meta?: RevisionMetaShape; renderedAst?: unknown }> => {
  const fromStored = storedMeta ? pickStoredMeta(storedMeta) : {};
  // Phase 2-written revisions persist every meta sub-field (even empty
  // arrays); the presence of these 3 is the marker that no fallback is
  // needed for meta. `rawSpaceLinks` (feature-backlink-raw-space-metadata,
  // additive) is deliberately NOT part of this gate: including it would
  // mark every revision written before that field existed as incomplete.
  // Two cohorts are spared by the omission — those with NO `rendererVersion`
  // at all (which `astIsFresh` below also treats as trustworthy), and
  // marker-era revisions that already carry the CURRENT `rendererVersion`
  // and so are not caught by the staleness gate either. Revisions whose
  // `rendererVersion` is merely older recompute regardless of this line.
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

  // feature-plugin-renderer-mermaid spec §5 — every return site below
  // that would otherwise serve `storedAst` verbatim (both branches that
  // guard on `astIsFresh`) instead serves this: a cheap no-op for the
  // overwhelming majority of pages (no `renderPending` marker
  // anywhere), or a narrowly-scoped retry of just the marked nodes.
  // Computed once, up front, and reused by every `astIsFresh` branch —
  // never computed when `!astIsFresh` (that path recomputes the AST
  // fully via `runRender` below instead).
  const freshStoredAst = astIsFresh ? await resolvePendingRenderNodes(crowi, storedAst, actor, pageId) : storedAst;

  if (metaIsComplete && astIsFresh) {
    return {
      meta: Object.keys(fromStored).length > 0 ? fromStored : undefined,
      renderedAst: freshStoredAst,
    };
  }
  if (!body) {
    return {
      meta: metaIsComplete && Object.keys(fromStored).length > 0 ? fromStored : undefined,
      renderedAst: astIsFresh ? freshStoredAst : undefined,
    };
  }

  // `pageId` threads through so the Phase 4+ plugin-dispatch transforms
  // (embed-tag / url-inline-expand / code-block) can fire on the
  // fallback path the same way they do at save time. Callers that
  // genuinely don't know the page (unit tests, orphan revision bodies)
  // can omit it — dispatch then degrades to no-op and the `code` /
  // `@[tag](url)` nodes survive as plain text.
  const { metadata, renderedAst } = await crowi.getRenderer().runRender(body, { mode: 'read', pageId, actor });
  const fresh = pickStoredMeta(metadataToRevisionMeta(metadata));
  // Tie the toc source to the AST source. When the stored AST is fresh
  // (`astIsFresh`), we serve `storedAst` and keep the stored-wins merge
  // byte-identical to today, so the toc's anchorIds stay aligned with the
  // stored heading ids. When the AST is stale (version mismatch / absent), we
  // serve the freshly RECOMPUTED `renderedAst`, whose heading ids are slugged
  // from the STRIPPED heading text — so the served toc must ALSO be the
  // recomputed one, or a pre-0.7.0 HTML-heading revision would ship a stale
  // raw-derived `anchorId` that no longer matches any rendered heading `id`
  // (broken TOC click / scroll-spy on exactly the `<font>` legacy content this
  // feature targets). Other meta fields stay stored-wins either way.
  const mergedMeta: RevisionMetaShape = astIsFresh ? { ...fresh, ...fromStored } : { ...fresh, ...fromStored, toc: fresh.toc };
  return {
    meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined,
    renderedAst: astIsFresh ? freshStoredAst : renderedAst,
  };
};

/**
 * feature-plugin-renderer-mermaid spec §5 — scan a stored `renderedAst`
 * for `data.renderPending` markers (left by a save-time admission-
 * control / child-process infra failure, `code-block-dispatch.ts`'s
 * `makeCodeBlockDispatch`) and, if any are found, retry ONLY those nodes
 * via `redispatchPendingCodeBlocks` (`priority: 'high'`).
 *
 * No-op (returns `storedAst` unchanged, no clone) for the overwhelming
 * majority of reads — pages with no pending marker anywhere, or a
 * `storedAst` shape too far from a mdast `Root` to scan (defensive; the
 * marker never being present there is the expected case for those too).
 * The tree is deep-cloned before any mutation so this NEVER writes back
 * into the Mongoose-owned `Revision.renderedAst` object the caller
 * passed in — only the returned value (this request's response) reflects
 * a successful retry; the next read repeats this same scan against the
 * still-unmodified stored document.
 */
async function resolvePendingRenderNodes(crowi: Crowi, storedAst: unknown, actor: RenderActor, pageId: string | undefined): Promise<unknown> {
  if (!pageId) return storedAst; // no page identity to key a cache entry on — degrade to no-op, same as the rest of this file
  if (!isMdastRootLike(storedAst)) return storedAst;
  if (!hasPendingRenderMarker(storedAst)) return storedAst;

  const renderer = crowi.getRenderer();
  const workingTree = structuredClone(storedAst);
  const ctx: RenderContext = { mode: 'read', log: coreLogger, actor };
  const { changed } = await redispatchPendingCodeBlocks(workingTree, renderer.registry, ctx, { cache: renderer.cache, pageId });
  return changed ? workingTree : storedAst;
}

function isMdastRootLike(value: unknown): value is Root {
  return (
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'root' && Array.isArray((value as { children?: unknown }).children)
  );
}

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
    status: (pageObj.status as 'wip' | 'published' | 'deleted' | 'deprecated' | 'draft') || undefined,
    grant: pageObj.grant,
    grantedUsers: pageObj.grantedUsers?.map(toStringId) || [],
    creator: pageObj.creator && isPopulatedUser(pageObj.creator) ? toPageUser(pageObj.creator) : null,
    lastUpdateUser: pageObj.lastUpdateUser && isPopulatedUser(pageObj.lastUpdateUser) ? toPageUser(pageObj.lastUpdateUser) : null,
    liker: pageObj.liker?.map(toStringId) || [],
    commentCount: pageObj.commentCount || 0,
    extended: pageObj.extended,
    createdAt: toISOStringOrNull(pageObj.createdAt) || EPOCH_ISO,
    updatedAt: toISOStringOrNull(pageObj.updatedAt) || undefined,
    // latestRevision is a dynamic, non-schema property assigned by
    // populatePageData (like likerCount / seenUsersCount below), so it must be
    // read off `dynamic` — `toObject()` strips it. Reading it off `pageObj`
    // (the toObject result) always yielded `undefined`, which made the web
    // stale-revision banner (`latestRevision !== revision._id`) never fire when
    // viewing a page at `?revision_id=` a past version.
    latestRevision: dynamic.latestRevision ? toStringId(dynamic.latestRevision) : undefined,
    likerCount: dynamic.likerCount,
    seenUsersCount: dynamic.seenUsersCount,
  };
};
