import type { MentionResponse, RevisionMetaShape, RevisionType, TocEntryResponse, WikiLinkResponse } from '@crowi/api-contract';
import { Document, Model, model, Schema, Types } from 'mongoose';
import Crowi from 'src/crowi';
import { RENDERER_PIPELINE_VERSION } from 'src/renderer/version';
import { PageDocument } from './page';
// import Debug from 'debug'

export type RevisionTocEntry = TocEntryResponse;
export type RevisionWikiLink = WikiLinkResponse;
export type RevisionMention = MentionResponse;
// `RevisionMetaContent` carries derived metadata (TOC etc.) stored on
// the revision document. Distinct from api-contract's `RevisionMeta`,
// which is a lightweight list-entry shape (id/path/author/createdAt).
export type RevisionMetaContent = RevisionMetaShape;

// Re-export the wire-format-anchored `RevisionType` union so callers
// that already import from this model file don't need to know about
// `api-contract`. The single source of truth is the Zod schema in
// `packages/api-contract/src/schemas/collab.ts` — Mongoose and the
// HTTP contract both narrow against the same literal set.
export type { RevisionType };

export interface RevisionDocument extends Document {
  _id: Types.ObjectId;
  path: string;
  /**
   * DC-5 (`feature-revision-page-ref`): the immutable `Page._id` this
   * revision was created against. `path` above is a mutable, reused string
   * (rename moves it, delete/recreate can hand it to an unrelated page) —
   * `page` is the id-based source of truth for "which page does this
   * revision actually belong to", set once in `prepareRevision` and never
   * rewritten afterwards (unlike `path`, which `Page.rename` still
   * best-effort syncs for display — see `Page.rename`).
   *
   * Optional/nullable, not `Types.ObjectId` — three real on-disk shapes
   * exist: (a) a genuine `ObjectId` for every revision `prepareRevision`
   * wrote, (b) the field entirely absent (`undefined`) on a revision
   * written before this field existed and not yet visited by the boot
   * migration, and (c) an explicit `null` on a row the migration visited
   * but could NOT confidently resolve to a current page (standard-lifecycle
   * deviation, or a stranded revision from a page that has since been
   * deleted and whose path was later reused by an unrelated page — see
   * `revision-page-ref-backfill`'s doc comment). (b) and (c) look the same
   * to callers (falsy — read paths must fail closed either way), but they
   * are deliberately distinct on disk: (c)'s explicit `null` is what lets
   * the migration's `isPending` probe (`{ page: { $exists: false } }`)
   * settle to `false` once a permanent orphan has been triaged, instead of
   * re-flagging pending (and re-running the stage) on every boot forever.
   */
  page?: Types.ObjectId | null;
  body: string;
  format: string;
  author: Types.ObjectId;
  createdAt: Date;
  meta?: RevisionMetaContent;
  /**
   * Phase 3 (RFC-0002): JSON-serialised mdast tree produced by the
   * full parse + transform pipeline (core plugins + shiki). Persisted
   * verbatim as a `Schema.Types.Mixed` blob; the contract type is
   * `z.unknown().optional()` because mdast is too deep / external-spec
   * to maintain a strict Zod schema for. Older revisions written
   * before Phase 3 fall through with `renderedAst === undefined` and
   * the read path uses `computeRevisionRenderedAstAsync` to compute on
   * the fly.
   */
  renderedAst?: unknown;
  /**
   * RFC-0002 round 3.1: semver of the renderer pipeline that produced
   * `renderedAst`. Read path uses this to detect stale entries; until
   * `renderer:rebuild` ships (deferred to RFC-0008), this is
   * informational only and the parse-on-read fallback handles
   * mismatches transparently.
   */
  rendererVersion?: string;
  /**
   * RFC-0003: parent revision pointer (self-ref). Lets the
   * incremental save flow chain deltas back to the most recent
   * snapshot. `null` (or undefined) for the very first revision and
   * for v1.x revisions written before this field existed.
   */
  parentRevisionId?: Types.ObjectId | null;
  /**
   * RFC-0003: snapshot vs incremental discriminator. Treat
   * `undefined` as `'snapshot'` for v1.x backward compat — old
   * revisions always carry the full body.
   */
  type?: RevisionType;
  /**
   * RFC-0003: Yjs update payload between this revision's parent and
   * itself. Only populated when `type === 'incremental'`. Stored as a
   * raw Buffer so the BSON driver round-trips a typed binary blob.
   *
   * Subject to MongoDB's 16 MB BSON document cap. The 9-incremental-
   * per-snapshot cadence (Phase 5) keeps individual deltas small in
   * practice; Phase 1 ships without a runtime size guard.
   */
  yjsUpdate?: Buffer;
  /**
   * RFC-0003: the user who triggered the save (clicked the Save
   * button). Distinct from `contributors` — collaborative edits can
   * have many contributors but exactly one `savedBy`. Falls back to
   * `author` when unset, for v1.x backward compat.
   */
  savedBy?: Types.ObjectId | null;
  /**
   * RFC-0003: all users seen via awareness on the page since the last
   * save. Phase 5 will write this from the in-memory awareness log at
   * save time. Empty array (or undefined) for v1.x revisions and for
   * single-user saves.
   */
  contributors?: Types.ObjectId[];
  /**
   * RFC-0003: optional user-supplied checkpoint message. The Phase 8
   * Save UI doesn't expose an input field yet (see spec open
   * question 1) — the field is reserved so we can light it up later
   * without a migration.
   */
  message?: string;
  /**
   * RFC-0010: how the revision was authored — `web` (browser session,
   * including the collaborative editor), `oauth` (OAuth access token) or
   * `pat` (personal access token). Undefined on pre-RFC-0010 revisions and
   * on collaborative saves (both treated as `web`). The history UI surfaces
   * an "app" chip for `oauth` / `pat` (API) edits.
   */
  editVia?: 'web' | 'oauth' | 'pat';
}

/**
 * Options accepted by `Revision.prepareRevision`. RFC-0003 Phase 5
 * additively expands the v1.x `{ format }`-only shape with the
 * collaborative-save fields (`savedBy` / `contributors` / `message` /
 * `type` / `parentRevisionId`). All existing callers (`Page.createPage`
 * / `Page.updatePage`) pass either nothing or `{ format }` and remain
 * unchanged — the new fields are written to the Revision only when
 * the collab save flow explicitly provides them, so v1.x revisions
 * keep their `undefined` semantics on disk.
 *
 * `parentRevisionId: null` is accepted (and persisted as `null`) for
 * an explicit "no parent" snapshot — useful for the first checkpoint
 * after a force-rebuild.
 */
export interface PrepareRevisionOptions {
  format?: string;
  savedBy?: Types.ObjectId;
  contributors?: Types.ObjectId[];
  message?: string;
  type?: RevisionType;
  parentRevisionId?: Types.ObjectId | null;
  editVia?: 'web' | 'oauth' | 'pat';
}

export interface RevisionModel extends Model<RevisionDocument> {
  findLatestRevision(path: string, cb: (err: Error | null, data: RevisionDocument | null) => void): void;
  findRevision(id: Types.ObjectId): Promise<RevisionDocument | null>;
  findRevisions(ids): Promise<RevisionDocument[]>;
  findRevisionIdList(path): Promise<RevisionDocument[]>;
  findRevisionList(path, options): Promise<RevisionDocument[]>;
  updateRevisionListByPath(path, updateData): Promise<RevisionDocument>;
  prepareRevision(pageData: PageDocument, body: string, user: { _id: Types.ObjectId }, options?: PrepareRevisionOptions): Promise<RevisionDocument>;
  removeRevisionsByPageId(pageId: Types.ObjectId): Promise<{ deletedCount: number }>;
  updatePath(pathName): void;
  findAuthorsByPage(page): Promise<RevisionDocument['author'][]>;
}

export default (crowi: Crowi) => {
  // const debug = Debug('crowi:models:revision')

  const revisionSchema = new Schema<RevisionDocument, RevisionModel>({
    path: { type: String, required: true, index: true },
    // DC-5 (`feature-revision-page-ref`): immutable id-based reference to the
    // owning Page, set once in `prepareRevision` and never rewritten. Not
    // `required: true`: pre-migration rows genuinely lack it on disk until
    // the boot migration backfills them (and a small class of orphans may
    // never get one — see `revision-page-ref-backfill`'s doc comment).
    // Indexed via the compound `{ page, createdAt }` declaration below.
    page: { type: Schema.Types.ObjectId, ref: 'Page' },
    body: { type: String, required: true },
    format: { type: String, default: 'markdown' },
    author: { type: Schema.Types.ObjectId, ref: 'User' },
    // RFC-0010: edit channel — 'web' | 'oauth' | 'pat'. Absent on
    // pre-RFC-0010 / collaborative-save revisions (treated as 'web').
    editVia: { type: String },
    createdAt: { type: Date, default: Date.now },
    // Older revisions without `meta` fall back to on-the-fly metadata
    // generation in pageToResponse / resolveRevisionMeta.
    meta: {
      type: new Schema<RevisionMetaContent>(
        {
          toc: {
            type: [
              new Schema<RevisionTocEntry>(
                {
                  level: { type: Number, required: true },
                  text: { type: String, required: true },
                  anchorId: { type: String, required: true },
                },
                { _id: false },
              ),
            ],
            default: undefined,
          },
          wikiLinks: {
            type: [
              new Schema<RevisionWikiLink>(
                {
                  raw: { type: String, required: true },
                  target: { type: String, required: true },
                  displayText: { type: String, required: false },
                },
                { _id: false },
              ),
            ],
            default: undefined,
          },
          mentions: {
            type: [
              new Schema<RevisionMention>(
                {
                  username: { type: String, required: true },
                },
                { _id: false },
              ),
            ],
            default: undefined,
          },
          codeBlockLanguages: {
            type: [String],
            default: undefined,
          },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // RFC-0002 Phase 3: transformed mdast persisted verbatim. Mixed
    // because Mongoose strict-schema for the deep mdast shape isn't
    // worth the maintenance — the AST is opaque JSON from the
    // contract's perspective. `default: undefined` is critical:
    // omitting it would have older revisions return `{}` for
    // renderedAst and bypass the on-the-fly fallback path.
    renderedAst: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    // RFC-0002 round 3.1: stamp the renderer pipeline version that
    // produced the persisted `renderedAst`. Older revisions written
    // before this field landed leave it `undefined`; the read path
    // treats undefined as "definitely stale, fall back to parse-on-read".
    rendererVersion: {
      type: String,
      default: undefined,
    },
    // RFC-0003 collaborative-save fields. All optional + `default:
    // undefined` so v1.x revisions read cleanly and the read path can
    // detect "not set" vs "explicitly empty" (the difference matters
    // for `contributors` — undefined means the revision predates
    // RFC-0003, [] means "single-user save, no other contributors").
    parentRevisionId: {
      type: Schema.Types.ObjectId,
      ref: 'Revision',
      default: undefined,
    },
    // RFC-0008 Phase 6 (revisions-schema-unify): `type` now carries
    // `default: 'snapshot'` so EVERY newly written revision — including
    // ones saved via the HTTP API path (Page.createPage / Page.updatePage),
    // which never pass an explicit `type` — lands with a concrete value.
    // This closes the write source so the `revisions-schema-unify` boot
    // migration can't be re-pended indefinitely (same lesson as the Phase 3
    // wikilink fix). The collab save flow (and RFC-0009's incremental saves)
    // still set `type` explicitly; `default` is only the fallback and does
    // not interfere. The read path keeps its `undefined → 'snapshot'`
    // back-compat for v1.x rows that predate the field.
    //
    // The plain (non-sparse) `index: true` makes the migration's
    // `findOne({ type: null })` probe index-backed and able to match both a
    // missing field and an explicit `null` — the same mechanism page.status
    // uses. A plain index (no partialFilterExpression) also ports cleanly to
    // PostgreSQL.
    type: {
      type: String,
      enum: ['snapshot', 'incremental'],
      default: 'snapshot',
      index: true,
    },
    yjsUpdate: {
      type: Buffer,
      default: undefined,
    },
    savedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: undefined,
    },
    contributors: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: undefined,
    },
    message: {
      type: String,
      default: undefined,
    },
  });

  // DC-5: every `page`-keyed read sorts or scans by recency — the history
  // list (`find({page}).sort({createdAt:-1})` + skip/limit), the attachment
  // usage scan, and mention-dispatch's previous-revision `findOne` (which
  // runs on every save). A compound index makes those pure index walks
  // instead of fetch-all + in-memory sort; the `page` prefix still serves
  // the equality-only queries (`removeRevisionsByPageId`,
  // `findAuthorsByPage`) and the backfill's `{ page: { $exists: false } }`
  // probe, and it ports directly to a Postgres `(page_id, created_at)`
  // index (plain, non-partial — same portability stance as `type`).
  revisionSchema.index({ page: 1, createdAt: -1 });

  revisionSchema.statics.findLatestRevision = function (path, cb) {
    // mongoose 7 dropped Query#exec(callback); bridge the promise to the
    // existing callback signature.
    this.findOne({ path })
      .sort({ createdAt: -1 })
      .exec()
      .then(
        (data) => cb(null, data),
        (err) => cb(err as Error, null),
      );
  };

  revisionSchema.statics.findRevision = function (id) {
    return Revision.findById(id).populate('author').exec();
  };

  revisionSchema.statics.findRevisions = async function (ids) {
    if (!Array.isArray(ids)) {
      throw new Error('The argument was not Array.');
    }

    return Revision.find({ _id: { $in: ids } })
      .sort({ createdAt: -1 })
      .populate('author')
      .exec();
  };

  revisionSchema.statics.findRevisionIdList = function (path) {
    return Revision.find({ path: path }).select('_id author createdAt').sort({ createdAt: -1 }).exec();
  };

  revisionSchema.statics.findRevisionList = function (path, options) {
    return Revision.find({ path: path }).sort({ createdAt: -1 }).populate('author').exec();
  };

  revisionSchema.statics.updateRevisionListByPath = function (path, updateData) {
    return Revision.updateMany({ path: path }, { $set: updateData }).exec();
  };

  revisionSchema.statics.prepareRevision = async function (pageData, body, user, options) {
    const opts = options ?? {};
    const format = opts.format || 'markdown';

    if (!user._id) {
      throw new Error('Error: user should have _id');
    }

    const newRevision = new Revision();
    newRevision.path = pageData.path;
    // DC-5: stamp the immutable page ref here — this is the single
    // chokepoint every revision-creation path (HTTP save / collab save /
    // draft / migration `rewritePageBody`) runs through, so one assignment
    // covers all of them. `pageData._id` is populated on construction even
    // for a not-yet-persisted page (see the `runRender` comment below).
    newRevision.page = pageData._id;
    newRevision.body = body;
    newRevision.format = format;
    newRevision.author = user._id;
    newRevision.createdAt = new Date();
    // Run the unified pipeline once at save time and persist BOTH
    // (a) the derived metadata (TOC + wikilinks + mentions + code-
    //     block langs) for backlinks / search / notify consumers, and
    // (b) the JSON-serialised transformed mdast (`renderedAst`) which
    //     the web client renders directly without re-parsing the body.
    // RFC-0002 Phase 3. Older revisions written under Phase 1/2 lack
    // `renderedAst` and fall through to the on-the-fly fallback path
    // in `computeRevisionRenderedAstAsync`.
    //
    // `pageId` is required for the Phase 4+ plugin-dispatch transforms
    // (embed-tag / url-inline-expand / code-block) to fire — without
    // it, `runPipeline` skips dispatch and `code` nodes for
    // PlantUML / Mermaid / etc. survive as plain code blocks. The
    // mongoose `_id` is populated on document construction, so even on
    // first-save (page not yet persisted) this is a real id.
    const { metadata, renderedAst } = await crowi.getRenderer().runRender(body || '', {
      mode: 'save',
      pageId: pageData._id?.toString(),
    });
    newRevision.meta = metadataToRevisionMeta(metadata);
    newRevision.renderedAst = renderedAst;
    newRevision.rendererVersion = RENDERER_PIPELINE_VERSION;

    // RFC-0003 Phase 5 collab-save options. Only assign when the caller
    // explicitly passed a value so v1.x callers (Page.createPage /
    // Page.updatePage with options `undefined` or `{ format }`) keep
    // writing `undefined` to disk — the read path distinguishes
    // "predates RFC-0003" from "explicit empty" on `contributors`.
    if (opts.savedBy !== undefined) {
      newRevision.savedBy = opts.savedBy;
    }
    if (opts.contributors !== undefined) {
      newRevision.contributors = opts.contributors;
    }
    if (opts.message !== undefined) {
      newRevision.message = opts.message;
    }
    if (opts.type !== undefined) {
      newRevision.type = opts.type;
    }
    if (opts.parentRevisionId !== undefined) {
      // `null` is a load-bearing value here (= "first snapshot, no
      // parent") so we forward it verbatim rather than collapsing to
      // undefined.
      newRevision.parentRevisionId = opts.parentRevisionId;
    }
    if (opts.editVia !== undefined) {
      newRevision.editVia = opts.editVia;
    }

    return newRevision;
  };

  // DC-5: id-keyed bulk delete, used by `Page.removePage` — robust against
  // path reuse (delete → recreate a different page at the same path would
  // make a path-scoped delete remove the wrong page's revisions; the old
  // `removeRevisionsByPath` static was removed for exactly that hazard).
  revisionSchema.statics.removeRevisionsByPageId = function (pageId) {
    return Revision.deleteMany({ page: pageId }).exec();
  };

  revisionSchema.statics.updatePath = function (pathName) {};

  revisionSchema.statics.findAuthorsByPage = function (page) {
    return Revision.distinct('author', { page: page._id }).exec() as Promise<RevisionDocument['author'][]>;
  };

  const Revision = model<RevisionDocument, RevisionModel>('Revision', revisionSchema);

  return Revision;
};

interface PipelineMetadataLike {
  toc?: RevisionTocEntry[];
  wikiLinks?: RevisionWikiLink[];
  mentions?: RevisionMention[];
  codeBlockLanguages?: string[];
}

/**
 * Persist the 4 sub-fields verbatim (including empty arrays). The
 * presence of `wikiLinks` / `mentions` / `codeBlockLanguages` is what
 * `computeRevisionMetaAsync` uses to skip the on-the-fly pipeline run
 * for revisions written under Phase 2 — collapsing empty arrays to
 * `undefined` would defeat that fast-path on every "no mentions, no
 * embeds" page.
 */
export function metadataToRevisionMeta(metadata: PipelineMetadataLike): RevisionMetaContent {
  return {
    toc: metadata.toc ?? [],
    wikiLinks: metadata.wikiLinks ?? [],
    mentions: metadata.mentions ?? [],
    codeBlockLanguages: metadata.codeBlockLanguages ?? [],
  };
}
