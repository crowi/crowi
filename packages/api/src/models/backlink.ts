import Crowi from 'src/crowi';
import { Types, Document, Model, Schema, model } from 'mongoose';
import Debug from 'debug';
import LinkDetector, { decodeLinkPath, stripFragmentAndQuery } from 'src/util/link-detector';
import { PageDocument } from './page';

export interface BacklinkDocument extends Document {
  _id: Types.ObjectId;
  page: Types.ObjectId | any;
  fromPage: Types.ObjectId | any;
  fromRevision: Types.ObjectId | any;
  updatedAt: Date;
}

export interface BacklinkModel extends Model<BacklinkDocument> {
  findByPageId(pageId: Types.ObjectId, limit: any, offset: any): Promise<BacklinkDocument[]>;
  removeByPageId(pageId: Types.ObjectId): any;
  removeBySavedPage(savedPage: any);
  createByParameters(parameters: any): Promise<BacklinkDocument>;
  createBySavedPage(savedPage: any): Promise<BacklinkDocument[]>;
  createByAllPages(): Promise<BacklinkDocument[][]>;
}

/**
 * feature-backlink-raw-space-metadata — decode the raw-space link
 * destinations `renderer/core/raw-space-links.ts` pushed onto
 * `revision.meta.rawSpaceLinks` at save time (see that transform's doc
 * comment). Replaces the earlier `extractRawSpaceRecoveredPaths` DFS
 * over the full `renderedAst`, which walked every page's whole AST on
 * every save looking for a `data.rawSpaceRecovered === true` marker —
 * almost always a wasted full-tree scan, since only pages that actually
 * contain a raw-space link have anything to find.
 *
 * `rawSpaceLinks` entries are NOT guaranteed to be real-space — the
 * recovery grammar keeps the destination verbatim, so an entry can
 * carry a literal `+` or `%XX` alongside the raw space (e.g. `/a+b c`).
 * Decode with the exact same semantics as the regex-based extraction
 * path (`stripFragmentAndQuery` → `decodeURIComponent` → `+` → space,
 * via `decodeLinkPath`), per-link try/catch (via `decodeLinkPath`'s
 * own null-on-throw contract) so one malformed recovered link doesn't
 * take down the rest — same hardening as the Phase 1 regex path.
 */
function decodeRawSpaceLinkPaths(rawSpaceLinks: string[] | undefined): string[] {
  if (!rawSpaceLinks) return [];
  const paths: string[] = [];
  for (const url of rawSpaceLinks) {
    const decoded = decodeLinkPath(stripFragmentAndQuery(url));
    if (decoded !== null) paths.push(decoded);
  }
  return paths;
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:backlink');
  const linkDetector = LinkDetector(crowi);

  const backlinkSchema = new Schema<BacklinkDocument, BacklinkModel>({
    page: { type: Schema.Types.ObjectId, ref: 'Page', index: true },
    fromPage: { type: Schema.Types.ObjectId, ref: 'Page' },
    fromRevision: { type: Schema.Types.ObjectId, ref: 'Revision' },
    updatedAt: { type: Date, default: Date.now, index: true },
  });

  backlinkSchema.statics.findByPageId = async function (pageId, limit, offset) {
    limit = limit || 10;
    offset = offset || 0;

    limit = parseInt(limit, 10);
    offset = parseInt(offset, 10);

    const conditions = { page: pageId };
    const projection = { fromPage: 1, fromRevision: 1, updatedAt: 1 };
    const options = { limit, skip: offset, sort: { updatedAt: -1 } };

    const backlinks = await Backlink.find(conditions, projection, options).populate('fromPage').populate('fromRevision');

    // populate author
    const populateOptions = {
      path: 'fromRevision.author',
      model: 'User',
      select: {
        username: 1,
        name: 1,
        image: 1,
      },
    };

    const populatedBacklinks = await Backlink.populate(backlinks, populateOptions);

    return populatedBacklinks;
  };

  backlinkSchema.statics.removeByPageId = function (pageId) {
    // FIXME: removeByPageId is a bit confusable name. Should it removeByFromPageId ?
    return Backlink.deleteMany({ fromPage: pageId });
  };

  backlinkSchema.statics.removeBySavedPage = async function (savedPage) {
    const conditions = {
      fromPage: savedPage._id,
    };

    await Backlink.deleteMany(conditions);
  };

  backlinkSchema.statics.createByParameters = async function (parameters) {
    const data = {
      page: parameters.page,
      fromPage: parameters.fromPage,
      fromRevision: parameters.fromRevision,
      updatedAt: Date.now(),
    };
    return Backlink.create(data);
  };

  /**
   * Resolve a batch of `{ paths, objectIds }` link references to the existing
   * Page IDs they point to, in **two** Mongo round-trips total (one $in per
   * field) regardless of how many links the page contains.
   *
   * The old per-link `Page.isExistByPath` / `Page.isExistById` loop did
   * 2K round-trips for K links — measurable latency on link-heavy pages.
   */
  const convertLinksToPageIds = async (page, { paths, objectIds }) => {
    const Page = crowi.model('Page');

    const [byPath, byId] = await Promise.all([
      paths.length > 0 ? Page.find({ path: { $in: paths } }).select('_id') : Promise.resolve([]),
      objectIds.length > 0 ? Page.find({ _id: { $in: objectIds } }).select('_id') : Promise.resolve([]),
    ]);

    const ownId = page._id.toString();
    const seen = new Set<string>();
    const ids: Types.ObjectId[] = [];

    for (const doc of [...byPath, ...byId]) {
      const idStr = doc._id.toString();
      if (idStr === ownId || seen.has(idStr)) continue;
      seen.add(idStr);
      ids.push(doc._id);
    }

    return ids;
  };

  backlinkSchema.statics.createBySavedPage = async function (savedPage) {
    if (!(savedPage.revision && savedPage.revision.body)) {
      throw new Error('no revision/body in savedPage');
    }

    const body = savedPage.revision.body;

    // Extract-before-delete: run `linkDetector.search` / `convertLinksToPageIds`
    // (which can throw on malformed input, e.g. a stray `/a%`) before
    // touching any existing Backlink docs. Previously `removeBySavedPage`
    // ran first, so a single malformed link would wipe out this page's
    // backlinks with nothing to replace them — the caller
    // (events/page.ts's registerBacklinks) only logs the exception, it
    // doesn't restore what was deleted. This guarantees exactly one thing:
    // a throw here leaves pre-existing Backlink docs untouched. It does
    // NOT make the delete+insert pair itself atomic — an `insertMany`
    // failure after a successful `removeBySavedPage`, or a concurrent save
    // racing this one, can still leave stale/missing backlinks (pre-existing,
    // out of scope — see spec's non-goals).
    const links = linkDetector.search(body);
    // Phase 2 (feature-page-link-space-paths), metadata channel added by
    // feature-backlink-raw-space-metadata: merge in raw-space recovered
    // links carried on `revision.meta.rawSpaceLinks` — a second
    // extraction step, not a new regex pattern (see
    // `decodeRawSpaceLinkPaths`'s doc comment above). Runs before
    // `removeBySavedPage` too, same extract-before-delete guarantee.
    const rawSpaceRecoveredPaths = decodeRawSpaceLinkPaths(savedPage.revision.meta?.rawSpaceLinks);
    const paths = rawSpaceRecoveredPaths.length === 0 ? links.paths : Array.from(new Set([...links.paths, ...rawSpaceRecoveredPaths]));
    const ids = await convertLinksToPageIds(savedPage, { paths, objectIds: links.objectIds });

    await Backlink.removeBySavedPage(savedPage);

    if (ids.length === 0) {
      debug('No backlinks to save');
      return [];
    }

    // Single batched write instead of N×Backlink.create()
    const now = new Date();
    const backlinks = await Backlink.insertMany(
      ids.map((id) => ({
        page: id,
        fromPage: savedPage._id,
        fromRevision: savedPage.revision._id,
        updatedAt: now,
      })),
    );

    debug('All backlinks saved (%d)', backlinks.length);
    return backlinks;
  };

  // feature-backlink-raw-space-metadata: this rebuild path queries
  // `Revision.find(...)` directly (a projection of `_id`/`body` only,
  // never `.meta`) and matches candidates with `linkDetector`'s regexps
  // — it never called the old `extractRawSpaceRecoveredPaths` DFS over
  // `renderedAst` either, before this change. So raw-space recovered
  // links have NEVER been included in a `createByAllPages()` rebuild,
  // and that stays true unchanged here: revisions this queries can
  // predate `meta.rawSpaceLinks` (or lack `meta` entirely — this path
  // doesn't even select the field), and this deliberately does not
  // special-case that (no DFS-over-renderedAst fallback re-added here —
  // see the spec's "移行の考え方"). A rebuild that also wants raw-space
  // backlinks would need to re-run pages through the renderer, which is
  // out of scope for this refactor (see spec's "やらないこと").
  backlinkSchema.statics.createByAllPages = async function () {
    const Page = crowi.model('Page');
    const Revision = crowi.model('Revision');

    const pages = await Page.find({}).select('_id revision');
    const latestRevisionIds = pages.map(({ revision }) => revision);

    const revisions = await Revision.find({ _id: { $in: latestRevisionIds } }).and({
      $or: [{ body: linkDetector.getLinkRegexp() }, { body: linkDetector.getPathRegexps()[0] }, { body: linkDetector.getPathRegexps()[1] }],
    } as any);

    await Backlink.deleteMany({});

    return Promise.all(
      revisions.map(async ({ _id: revisionId, body }) => {
        const page = pages.find(({ revision }) => revision.toString() === revisionId.toString()) as PageDocument;
        const pageId = page._id;

        const links = linkDetector.search(body);
        const ids = await convertLinksToPageIds(page, links);

        if (ids.length === 0) return [];

        const now = new Date();
        const backlinks = await Backlink.insertMany(
          ids.map((id) => ({
            page: id,
            fromPage: pageId,
            fromRevision: revisionId,
            updatedAt: now,
          })),
        );

        debug('All backlinks saved (%d)', backlinks.length);
        return backlinks;
      }),
    );
  };

  const Backlink = model<BacklinkDocument, BacklinkModel>('BackLink', backlinkSchema);

  return Backlink;
};
