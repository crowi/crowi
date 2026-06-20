import { STATUS_PUBLISHED } from 'src/models/page';
import { metadataToRevisionMeta } from 'src/models/revision';
import type { RevisionTocEntry } from 'src/models/revision';
import type { MigrationContext } from '../types';
import { defineMigration } from '../types';

/**
 * `toc-html-strip` (preflight layer) — regenerate stale `meta.toc` entries
 * that captured inline HTML markup from heading text.
 *
 * Before the headings transform passed `{ includeHtml: false }` to
 * `mdast-util-to-string` (§B1), a heading such as
 * `### <font color="1a73e8">Workspace</font>` produced a TOC label that
 * included the raw `<font …>` / `</font>` markup. That label is persisted in
 * `Revision.meta.toc[].text` (RFC-0002) and does NOT self-heal:
 *
 *   - the read path merges `{ ...computed, ...stored }` with stored winning
 *     (`util/page-response.ts`), so parse-on-read never overrides it; and
 *   - the renderer-version freshness check only rebuilds `renderedAst`, never
 *     `meta.toc` (the two are independent).
 *
 * So a dedicated migration is required. It re-extracts the TOC from each
 * affected page's current revision body (via the renderer's `runRender`, which
 * now strips HTML) and `$set`s **only** `meta.toc` — `renderedAst` and the
 * rest of `meta` are left as-is to keep the blast radius minimal.
 *
 * Scope: current revision of published pages only. Historical revisions are
 * immutable and never read by the TOC UI, so rewriting them would be churn for
 * no user-visible gain (mirrors `wikilink-format`'s published-only scope).
 *
 * Idempotent: once a label has no `<`, it no longer matches `tocHasHtml`, so a
 * re-run skips it.
 */

/**
 * Cheap per-entry staleness test: a TOC label still carrying a `<` is a
 * leftover from the pre-strip pipeline. Plain page titles never contain a raw
 * `<` (markdown escapes / encodes it), so this has no false positives in
 * practice.
 */
function tocHasHtml(toc: RevisionTocEntry[] | undefined): boolean {
  if (!toc) return false;
  return toc.some((entry) => entry.text.includes('<'));
}

interface RevisionWork {
  revisionId: unknown;
  body: string;
  pageId: string | null;
}

/**
 * Walk published pages' current revisions and collect those whose stored
 * `meta.toc` still carries HTML in a label. Stream-walk so memory stays flat
 * on large installs.
 */
async function collectStaleRevisions(ctx: MigrationContext): Promise<RevisionWork[]> {
  const Page = ctx.crowi.model('Page');
  const Revision = ctx.crowi.model('Revision');

  const out: RevisionWork[] = [];
  const cursor = Page.find({ $or: [{ status: STATUS_PUBLISHED }, { status: null }] })
    .select('_id revision')
    .lean()
    .cursor();

  for await (const page of cursor) {
    const pageDoc = page as { _id: unknown; revision?: unknown };
    if (!pageDoc.revision) continue;
    const revision = await Revision.findById(pageDoc.revision).select('body meta').lean().exec();
    const rev = revision as { _id?: unknown; body?: unknown; meta?: { toc?: RevisionTocEntry[] } } | null;
    if (!rev) continue;
    if (typeof rev.body !== 'string') continue;
    if (!tocHasHtml(rev.meta?.toc)) continue;
    out.push({ revisionId: rev._id, body: rev.body, pageId: pageDoc._id ? String(pageDoc._id) : null });
  }
  return out;
}

export const tocHtmlStrip = defineMigration({
  id: 'toc-html-strip',
  fromVersion: '2.1',
  toVersion: '2.1',
  layer: 'preflight',
  // Independent of the wikilink work; keep a stable order after it.
  order: 110,
  description: 'Regenerate stale meta.toc entries that captured inline HTML from heading text',

  /**
   * Pending iff any current revision of a published page still has a TOC label
   * containing `<`. There is no index on `meta.toc.text`, so this short-
   * circuits at the first stale revision (it stops early rather than reading
   * every page). Once apply has stripped every label, this reports false and
   * boot clears — and because the save path now strips HTML, no fresh revision
   * re-introduces a `<` label.
   */
  isPending: async (ctx) => {
    const Page = ctx.crowi.model('Page');
    const Revision = ctx.crowi.model('Revision');
    const cursor = Page.find({ $or: [{ status: STATUS_PUBLISHED }, { status: null }] })
      .select('_id revision')
      .lean()
      .cursor();
    for await (const page of cursor) {
      const revisionId = (page as { revision?: unknown }).revision;
      if (!revisionId) continue;
      const revision = await Revision.findById(revisionId).select('meta.toc').lean().exec();
      const toc = (revision as { meta?: { toc?: RevisionTocEntry[] } } | null)?.meta?.toc;
      if (tocHasHtml(toc)) {
        await cursor.close();
        return true;
      }
    }
    return false;
  },

  /** Full scan for `plan`: count the revisions that would be regenerated. */
  detect: async (ctx) => {
    const stale = await collectStaleRevisions(ctx);
    return {
      summary: `${stale.length} revision(s) have a stale meta.toc carrying inline HTML`,
      counts: { revisions: stale.length },
    };
  },

  stages: [
    {
      name: 'regenerate-toc',
      fn: async (ctx) => {
        const stale = await collectStaleRevisions(ctx);
        if (ctx.dryRun) {
          return { name: 'regenerate-toc', transformed: 0, stats: { wouldRegenerate: stale.length } };
        }

        const Revision = ctx.crowi.model('Revision');
        const renderer = ctx.crowi.getRenderer();
        ctx.progress.setTotal(stale.length);

        let regenerated = 0;
        for (const rev of stale) {
          // Re-run the (now HTML-stripping) pipeline to get a fresh toc.
          // `mode: 'save'` matches how the body was rendered originally so the
          // extracted toc is byte-identical to what a re-save would produce.
          // Only `meta.toc` is written back — `renderedAst` and the other
          // `meta` sub-fields are untouched (minimal blast radius).
          const { metadata } = await renderer.runRender(rev.body, {
            mode: 'save',
            pageId: rev.pageId ?? undefined,
          });
          const freshToc = metadataToRevisionMeta(metadata).toc;
          await Revision.updateOne({ _id: rev.revisionId }, { $set: { 'meta.toc': freshToc } }).exec();
          regenerated += 1;
          ctx.progress.increment();
        }

        if (regenerated > 0) {
          ctx.logger.info(`toc-html-strip: regenerated meta.toc on ${regenerated} revision(s)`);
        }
        return { name: 'regenerate-toc', transformed: regenerated };
      },
    },
  ],
});
