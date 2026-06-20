import { STATUS_PUBLISHED } from 'src/models/page';
import type { MigrationContext } from '../types';
import { defineMigration } from '../types';
import { resolveActingUserId } from './resolve-acting-user';
import { KNOWN_HTML_ELEMENTS } from './wikilink-format';

/**
 * `wikilink-html-recover` (preflight layer) — undo the `wikilink-format`
 * close-tag misfire.
 *
 * Before `font` / `center` / `marquee` / `blink` / `applet` were added to
 * `KNOWN_HTML_ELEMENTS`, `wikilink-format` mistook the deprecated HTML close
 * tags `</font>` etc. for v1 angle-bracket wikilinks and rewrote them to
 * `[[/font]]` (§A). `wikilink-format` is recorded as applied and never
 * re-runs, and the corrupted `[[/font]]` form no longer matches its detection
 * regex, so it does not self-heal. This migration walks every published page
 * and reverts the corrupted form `[[/<x>]]` back to the close tag `</x>` when:
 *
 *   - `x` is a single path segment (no `/` inside), AND
 *   - `x` has no `|alias` segment, AND
 *   - `x` is a known HTML element name (lowercased ASCII).
 *
 * Genuine wikilinks are deliberately preserved: `[[/foo/bar]]` (multi-segment),
 * `[[/font|alias]]` (aliased), `[[/Section]]` (uppercase → case-sensitive page
 * name), and `[[/wiki-page]]` (non-HTML name) are all left untouched.
 *
 * ── Inherent ambiguity ───────────────────────────────────────────────
 * `[[/font]]` could be a corrupted `</font>` OR a genuine wikilink to a real
 * page literally at `/font`. They are indistinguishable from the text alone.
 * We resolve this conservatively: a `[[/<x>]]` whose `/<x>` matches an
 * **existing page path** is NOT reverted — it is reported by `detect` so an
 * operator can decide manually (mirrors `relocate-reserved-api-paths`'s
 * collision-avoidance posture). The revert therefore only touches occurrences
 * that have no same-named page to be mistaken for.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Like `wikilink-format`, every body rewrite routes through
 * `ctx.rewritePageBody` (the `updatePage`-equivalent path) so `yjsState` /
 * `yjsCheckpointAt` are nulled and an active editor's stale `Y.Doc` cannot
 * silently revert the recovery (RFC-0008 §4.3.1).
 *
 * Idempotent: once reverted, `</x>` no longer matches this migration's
 * detection regex (it scans for `[[/...]]`, not `</...>`), and a re-run of
 * `wikilink-format` leaves `</x>` alone because `x` is now in
 * `KNOWN_HTML_ELEMENTS`.
 */

/**
 * Matches a corrupted-wikilink candidate `[[/<segment>]]` with a single
 * path segment and no alias. The capture group grabs the bare segment
 * (`font` in `[[/font]]`). The `[^[\]|/]+` class excludes `[`, `]`, `|`, and
 * `/`, so multi-segment (`[[/foo/bar]]`) and aliased (`[[/font|x]]`) forms
 * never match here — only `shouldRecoverSegment` then filters by HTML name.
 */
export const WIKILINK_HTML_CANDIDATE_REGEX = /\[\[\/([^[\]|/]+)\]\]/g;

/**
 * True iff `[[/<segment>]]` should be reverted to `</segment>`: the segment
 * is a lowercase-ASCII identifier that is a known HTML element. Uppercase
 * (`/Font`) or non-HTML (`/wiki`) segments are genuine wikilinks. This is the
 * exact inverse gate of `wikilink-format`'s `shouldRewriteWikilink` for the
 * single-segment case.
 */
export function shouldRecoverSegment(segment: string): boolean {
  if (!/^[a-z][a-z0-9]*$/.test(segment)) return false;
  return KNOWN_HTML_ELEMENTS.has(segment);
}

/** A single corrupted occurrence located in a body. */
export interface RecoverableOccurrence {
  /** The full raw match, e.g. `[[/font]]`. */
  raw: string;
  /** The HTML element name, e.g. `font`. */
  element: string;
}

/**
 * Single-pass scan: locate every `[[/<html-element>]]` occurrence in `body`.
 * Pure — no rewrite is applied here (the rewrite happens in `rewriteBody`
 * after same-name page collisions have been resolved per-occurrence).
 */
export function detectRecoverable(body: string): RecoverableOccurrence[] {
  const occurrences: RecoverableOccurrence[] = [];
  WIKILINK_HTML_CANDIDATE_REGEX.lastIndex = 0;
  let match = WIKILINK_HTML_CANDIDATE_REGEX.exec(body);
  while (match !== null) {
    const segment = match[1];
    if (shouldRecoverSegment(segment)) {
      occurrences.push({ raw: match[0], element: segment });
    }
    match = WIKILINK_HTML_CANDIDATE_REGEX.exec(body);
  }
  return occurrences;
}

/**
 * Rewrite `body`, reverting `[[/<x>]]` → `</x>` for every element in
 * `recoverable`. Elements in `skip` (those that collide with a real page
 * path) are left untouched. Returns the input by reference when nothing
 * changed so callers can cheap-skip.
 */
export function rewriteBody(body: string, skip: ReadonlySet<string>): string {
  let changed = false;
  const rewritten = body.replace(WIKILINK_HTML_CANDIDATE_REGEX, (whole, segment: string) => {
    if (!shouldRecoverSegment(segment)) return whole;
    if (skip.has(segment)) return whole;
    changed = true;
    return `</${segment}>`;
  });
  return changed ? rewritten : body;
}

interface PageWork {
  pageId: string;
  newBody: string;
  reverted: number;
}

interface ScanResult {
  /** Pages with at least one revertible occurrence (after collision filtering). */
  work: PageWork[];
  /** Total revertible occurrences across all `work` pages. */
  revertibleOccurrences: number;
  /** Element names skipped because a same-named real page exists. */
  collidingElements: Set<string>;
}

/**
 * A memoised `/<element>` existence probe. `Page.exists` results are cached per
 * element so a widely-used corrupted tag costs one existence probe across the
 * whole walk, not one per page.
 */
function makePageExistsProbe(Page: ReturnType<MigrationContext['crowi']['model']>): (element: string) => Promise<boolean> {
  const cache = new Map<string, boolean>();
  return async (element) => {
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    const exists = Boolean(await Page.exists({ path: `/${element}` }));
    cache.set(element, exists);
    return exists;
  };
}

/**
 * Walk every published page's current revision body, detect corrupted
 * `[[/<html-element>]]` occurrences, and for each candidate element check
 * whether a same-named real page (`/<element>`) exists. Colliding elements
 * are reported (not reverted); the rest are staged for rewrite.
 */
async function scan(ctx: MigrationContext): Promise<ScanResult> {
  const Page = ctx.crowi.model('Page');
  const Revision = ctx.crowi.model('Revision');

  const pageExists = makePageExistsProbe(Page);

  const work: PageWork[] = [];
  const collidingElements = new Set<string>();
  let revertibleOccurrences = 0;

  const cursor = Page.find({ $or: [{ status: STATUS_PUBLISHED }, { status: null }] })
    .select('_id revision')
    .lean()
    .cursor();

  for await (const page of cursor) {
    const pageDoc = page as { _id: unknown; revision?: unknown };
    if (!pageDoc.revision) continue;
    const revision = await Revision.findById(pageDoc.revision).select('body').lean().exec();
    const body = (revision as { body?: unknown } | null)?.body;
    if (typeof body !== 'string') continue;
    if (!body.includes('[[/')) continue;

    const occurrences = detectRecoverable(body);
    if (occurrences.length === 0) continue;

    // Partition this page's elements into collide-skip vs revertible.
    const skip = new Set<string>();
    let pageReverted = 0;
    for (const occ of occurrences) {
      if (await pageExists(occ.element)) {
        skip.add(occ.element);
        collidingElements.add(occ.element);
      } else {
        pageReverted += 1;
      }
    }
    if (pageReverted === 0) continue;

    const newBody = rewriteBody(body, skip);
    work.push({ pageId: String(pageDoc._id), newBody, reverted: pageReverted });
    revertibleOccurrences += pageReverted;
  }

  return { work, revertibleOccurrences, collidingElements };
}

export const wikilinkHtmlRecover = defineMigration({
  id: 'wikilink-html-recover',
  fromVersion: '2.1',
  toVersion: '2.1',
  layer: 'preflight',
  // Order after wikilink-format so the misfire is stopped (5 tags added)
  // before its corrupted output is recovered.
  order: 100,
  description: 'Recover HTML close tags corrupted to wikilinks by the earlier wikilink-format misfire',

  /**
   * Pending iff at least one published page's current revision body still
   * carries a revertible `[[/<html-element>]]` whose element has no same-named
   * page. There is no index on `revision.body`, so this walks published pages
   * and short-circuits at the first revertible occurrence — never a full
   * `revisions` scan, and it stops early rather than reading every page.
   *
   * Colliding occurrences (`[[/font]]` with a real `/font` page) do NOT count
   * as pending: this migration will never revert them, so reporting pending
   * for them would block boot forever under preflight + `block`.
   */
  isPending: async (ctx) => {
    const Page = ctx.crowi.model('Page');
    const Revision = ctx.crowi.model('Revision');
    const pageExists = makePageExistsProbe(Page);
    const cursor = Page.find({ $or: [{ status: STATUS_PUBLISHED }, { status: null }] })
      .select('_id revision')
      .lean()
      .cursor();
    for await (const page of cursor) {
      const revisionId = (page as { revision?: unknown }).revision;
      if (!revisionId) continue;
      const revision = await Revision.findById(revisionId).select('body').lean().exec();
      const body = (revision as { body?: unknown } | null)?.body;
      if (typeof body !== 'string' || !body.includes('[[/')) continue;
      for (const occ of detectRecoverable(body)) {
        if (!(await pageExists(occ.element))) {
          await cursor.close();
          return true;
        }
      }
    }
    return false;
  },

  /**
   * Full scan for `plan`: report how many pages / occurrences would be
   * reverted plus, separately, the HTML element names that were left alone
   * because a same-named real page exists (the operator must resolve those
   * by hand). Not called at boot.
   */
  detect: async (ctx) => {
    const { work, revertibleOccurrences, collidingElements } = await scan(ctx);
    const colliding = [...collidingElements].sort();
    const collisionNote =
      colliding.length > 0 ? `; ${colliding.length} element(s) skipped due to same-named pages: ${colliding.map((e) => `/${e}`).join(', ')}` : '';
    return {
      summary: `${work.length} page(s) hold ${revertibleOccurrences} recoverable HTML close tag(s)${collisionNote}`,
      counts: {
        pages: work.length,
        occurrences: revertibleOccurrences,
        collisions: colliding.length,
      },
    };
  },

  stages: [
    {
      name: 'recover-html-close-tags',
      fn: async (ctx) => {
        if (ctx.dryRun) {
          const { work, revertibleOccurrences, collidingElements } = await scan(ctx);
          return {
            name: 'recover-html-close-tags',
            transformed: 0,
            stats: { wouldRevert: work.length, occurrences: revertibleOccurrences, collisions: collidingElements.size },
          };
        }

        const actingUserId = await resolveActingUserId(ctx, 'wikilink-html-recover');
        const { work, collidingElements } = await scan(ctx);
        ctx.progress.setTotal(work.length);

        let reverted = 0;
        for (const page of work) {
          await ctx.rewritePageBody(page.pageId, page.newBody, { userId: actingUserId });
          reverted += 1;
          ctx.progress.increment();
        }

        if (reverted > 0) {
          ctx.logger.info(`wikilink-html-recover: reverted HTML close tags on ${reverted} page(s) via the updatePage path (yjsState invalidated)`);
        }
        if (collidingElements.size > 0) {
          ctx.logger.warn(
            `wikilink-html-recover: left ${collidingElements.size} element(s) untouched because a same-named page exists: ${[...collidingElements]
              .sort()
              .map((e) => `/${e}`)
              .join(', ')} — review these manually`,
          );
        }
        return { name: 'recover-html-close-tags', transformed: reverted, stats: { collisions: collidingElements.size } };
      },
    },
  ],
});
