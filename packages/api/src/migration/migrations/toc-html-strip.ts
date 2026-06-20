import type { RevisionTocEntry } from 'src/models/revision';
import { containsKnownHtmlTag, stripKnownHtmlTags } from 'src/util/html-elements';
import type { MigrationContext } from '../types';
import { defineMigration } from '../types';
import { STOP, forEachPublishedCurrentRevision } from './published-current-revision';

/**
 * `toc-html-strip` (preflight layer) — strip inline HTML markup out of stale
 * `meta.toc[].text` labels in place.
 *
 * Before the headings transform stripped known HTML tags from heading text
 * (§B1), a heading such as `### <font color="1a73e8">Workspace</font>` produced
 * a TOC label that included the raw `<font …>` / `</font>` markup. That label is
 * persisted in `Revision.meta.toc[].text` (RFC-0002) and does NOT self-heal:
 *
 *   - the read path merges `{ ...computed, ...stored }` with stored winning
 *     (`util/page-response.ts`), so parse-on-read never overrides it; and
 *   - the renderer-version freshness check only rebuilds `renderedAst`, never
 *     `meta.toc` (the two are independent).
 *
 * So a dedicated migration is required. It rewrites each stale entry's `.text`
 * to its HTML-stripped form and `$set`s **only** `meta.toc`.
 *
 * Why `.text` only, and why `anchorId` is deliberately PRESERVED: the stored
 * `renderedAst` heading id was slugged from the original (HTML-laden) text and
 * the stored `meta.toc[].anchorId` matches it exactly today — only `.text` is
 * ugly. Re-slugging `anchorId` from the cleaned text would point the TOC link
 * at an anchor the stored `renderedAst` heading does NOT carry, breaking
 * in-page navigation for precisely the pages this migration targets. The deep
 * "regenerate everything" alternative (bump `RENDERER_PIPELINE_VERSION` to
 * force a global re-render) is unaffordable: the read path does not write the
 * re-rendered AST back, so every revision would re-render on every read
 * forever. Stripping `.text` in place keeps the existing anchor link intact and
 * needs no body re-render at all.
 *
 * Scope: current revision of published pages only. Historical revisions are
 * immutable and never read by the TOC UI, so rewriting them would be churn for
 * no user-visible gain (mirrors `wikilink-format`'s published-only scope).
 *
 * Idempotent: once a label has no known HTML tag, `containsKnownHtmlTag` is
 * false for it, so a re-run skips it. And because the save path now strips HTML
 * too, no fresh revision re-introduces a tagged label.
 */

/**
 * Per-entry staleness test: a TOC label still carrying a *known HTML tag* is a
 * leftover from the pre-strip pipeline. Built on `containsKnownHtmlTag` (NOT a
 * bare `.includes('<')`) so a heading with a literal angle bracket in its text
 * (`## price < 100`, `## if x < 10`) is NOT flagged — a clean v2 install never
 * has a stale TOC and so never blocks boot under the preflight `block` policy.
 */
function tocHasHtml(toc: RevisionTocEntry[] | undefined): boolean {
  if (!toc) return false;
  return toc.some((entry) => containsKnownHtmlTag(entry.text));
}

/**
 * Strip known HTML tags from every label, dropping entries that collapse to an
 * empty label (matches the headings transform's empty-label guard — an
 * empty-text/anchorId entry is unaddressable and would fail the `meta.toc`
 * schema's `required` fields). `anchorId` / `level` are preserved verbatim.
 */
function stripTocHtml(toc: RevisionTocEntry[]): RevisionTocEntry[] {
  const out: RevisionTocEntry[] = [];
  for (const entry of toc) {
    const text = stripKnownHtmlTags(entry.text).trim();
    if (text.length === 0) continue;
    out.push({ ...entry, text });
  }
  return out;
}

interface StaleToc {
  revisionId: unknown;
  /** The cleaned `meta.toc` to `$set`. */
  freshToc: RevisionTocEntry[];
}

/**
 * Walk published pages' current revisions and collect those whose stored
 * `meta.toc` still carries a known HTML tag in a label, paired with the cleaned
 * toc to write back. Projects `meta.toc` only — body is never read.
 */
async function collectStaleRevisions(ctx: MigrationContext): Promise<StaleToc[]> {
  const out: StaleToc[] = [];
  await forEachPublishedCurrentRevision(ctx, { projection: 'meta.toc' }, ({ revisionId, revision }) => {
    const toc = (revision as { meta?: { toc?: RevisionTocEntry[] } }).meta?.toc;
    if (!tocHasHtml(toc)) return;
    out.push({ revisionId, freshToc: stripTocHtml(toc ?? []) });
  });
  return out;
}

export const tocHtmlStrip = defineMigration({
  id: 'toc-html-strip',
  fromVersion: '2.1',
  toVersion: '2.1',
  layer: 'preflight',
  // `fromVersion: '2.1'` already sequences both new migrations after
  // `wikilink-format` (`fromVersion: '1.x'`). `order` here only tie-breaks
  // against the sibling `wikilink-html-recover` (also `2.1`); the two are
  // mutually independent, so the value is cosmetic.
  order: 110,
  description: 'Strip inline HTML markup out of stale meta.toc labels (anchorId preserved)',

  /**
   * Pending iff any current revision of a published page still has a TOC label
   * carrying a known HTML tag. There is no index on `meta.toc.text`, so this
   * walks published pages (projecting `meta.toc` only) and short-circuits at
   * the first stale revision. Once apply has stripped every label, this reports
   * false and boot clears — and because the save path now strips HTML, no fresh
   * revision re-introduces a tagged label. A literal `<` in heading text
   * (`## price < 100`) is NOT a known tag, so a clean install never blocks.
   */
  isPending: async (ctx) => {
    let pending = false;
    await forEachPublishedCurrentRevision(ctx, { projection: 'meta.toc' }, ({ revision }) => {
      const toc = (revision as { meta?: { toc?: RevisionTocEntry[] } }).meta?.toc;
      if (tocHasHtml(toc)) {
        pending = true;
        return STOP;
      }
    });
    return pending;
  },

  /** Full scan for `plan`: count the revisions that would be stripped. */
  detect: async (ctx) => {
    const stale = await collectStaleRevisions(ctx);
    return {
      summary: `${stale.length} revision(s) have a stale meta.toc carrying inline HTML`,
      counts: { revisions: stale.length },
    };
  },

  stages: [
    {
      name: 'strip-toc-html',
      fn: async (ctx) => {
        const stale = await collectStaleRevisions(ctx);
        if (ctx.dryRun) {
          return { name: 'strip-toc-html', transformed: 0, stats: { wouldStrip: stale.length } };
        }

        const Revision = ctx.crowi.model('Revision');
        ctx.progress.setTotal(stale.length);

        let stripped = 0;
        for (const rev of stale) {
          // In-place text strip — `anchorId` / `level` / `renderedAst` are
          // untouched, so the existing stored-AST anchor link keeps working
          // (see the file-header rationale). No body load, no re-render.
          await Revision.updateOne({ _id: rev.revisionId }, { $set: { 'meta.toc': rev.freshToc } }).exec();
          stripped += 1;
          ctx.progress.increment();
        }

        if (stripped > 0) {
          ctx.logger.info(`toc-html-strip: stripped inline HTML from meta.toc on ${stripped} revision(s)`);
        }
        return { name: 'strip-toc-html', transformed: stripped };
      },
    },
  ],
});
