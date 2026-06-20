import { STATUS_PUBLISHED } from 'src/models/page';
import type { MigrationContext } from '../types';
import { defineMigration } from '../types';
import { resolveActingUserId } from './resolve-acting-user';

/**
 * RFC-0008 §10.2 step 4 / §4.3.1 — `wikilink-format` (preflight layer).
 *
 * Ported from the former standalone `crowi-admin migrate --only=wikilink`
 * (`packages/admin-cli/src/commands/migrate-wikilink.ts`). The migration
 * rewrites v1 angle-bracket internal links (`</path>` / `</path|alias>`) to
 * the v2 wikilink form (`[[path]]` / `[[path|alias]]`).
 *
 * Why this is a migration (not just a CLI command): the old command called
 * `Revision.prepareRevision` + `Page.pushRevision` directly, bypassing
 * `Page.updatePage`. That path never nulls `yjsState` / `yjsCheckpointAt`, so
 * any user editing a rewritten page stayed pinned to a stale `Y.Doc` and could
 * silently revert the migration on their next autosave (RFC-0008 §4.3.1
 * "Motivating bug"). Routing every body rewrite through `ctx.rewritePageBody`
 * (= the `updatePage`-equivalent path) repoints `currentRevision` and nulls the
 * Yjs snapshot, so the next `onLoadDocument` rebuilds from the new body. As a
 * preflight migration this is persistence-only (no live force-reload broadcast):
 * preflight runs in a maintenance window with no connected editors (§4.3.1).
 *
 * The textual conversion logic below is moved verbatim from the old command so
 * the rewrite output is byte-identical to the legacy migrator.
 */

/**
 * HTML5 element name set used to reject `</foo>` matches whose first path
 * segment is actually a closing HTML tag. Source:
 * https://developer.mozilla.org/en-US/docs/Web/HTML/Element — the full
 * standard element list as of the HTML Living Standard.
 *
 * Kept as a top-level `Set<string>` so detection runs O(1) per match.
 * `h1`..`h6` are listed explicitly because the regex captures `foo` for
 * `</foo>` and we want both `</h1>` and `</h6>` to be rejected.
 *
 * Includes the deprecated/obsolete presentational elements `font` /
 * `center` / `marquee` / `blink` / `applet`: they no longer appear in the
 * MDN current element list but still occur in real legacy wiki content
 * (e.g. `### <font color="1a73e8">…</font>` headings), so `</font>` etc.
 * MUST be treated as close tags rather than rewritten to `[[/font]]`.
 */
export const KNOWN_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'address',
  'applet',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blink',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'font',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'marquee',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

/**
 * v1 angle-bracket internal link form. The capture group grabs the path-style
 * payload (starts with `/`, no whitespace, no `<` / `>` / `|` other than the
 * optional `|alias` segment). See `packages/api/src/util/linkDetector.ts` — v1
 * used `<(/[^>]+)>` for the same primitive; we tighten it here to:
 *
 *   - leading `/` to keep this strictly path-style (not arbitrary text)
 *   - no whitespace inside the **path** (Crowi page paths cannot contain spaces)
 *   - no `<` / `>` until the closing `>` and no `|` until the optional alias
 *   - optional `|alias` (free-form text, no `<` / `>`)
 *
 * Detection only — see `shouldRewriteWikilink` for the HTML-element filter.
 */
export const WIKILINK_DETECTION_REGEX = /<(\/[^\s<>|]+)(\|[^<>]+)?>/g;

/**
 * Substring that necessarily precedes every legacy wikilink: `</` (the match is
 * `<` followed by the path's leading `/`, e.g. `</docs/api>`). HTML close tags
 * (`</div>`) share this prefix, so this is a *prefilter* only — it is the
 * cheapest substring guaranteed present whenever a real legacy wikilink exists
 * (so it never yields a false negative), letting us skip the regex on bodies
 * that obviously cannot contain one. The actual pending *verdict* applies the
 * full `shouldRewriteWikilink` rule — see `bodyHasRewritableWikilink`.
 */
const WIKILINK_SUBSTRING_PROBE = '</';

/**
 * True iff `body` contains at least one *genuine* legacy wikilink — i.e. a
 * `</...>` match that survives the full `shouldRewriteWikilink` HTML-element
 * filter. `</div>` and other close tags return false.
 *
 * `</` is used as a cheap prefilter so bodies that cannot possibly contain a
 * legacy wikilink skip the regex entirely; the verdict itself is the full
 * detection rule (not the substring), so a body whose only `</` occurrences are
 * HTML close tags correctly reports false. Shared by `isPending` (current-
 * revision verdict) and `collectRewritablePages` (full detect/stage scan) so
 * the detection logic lives in one place.
 */
export function bodyHasRewritableWikilink(body: string): boolean {
  if (!body.includes(WIKILINK_SUBSTRING_PROBE)) return false;
  return rewriteAndDetect(body).occurrences.length > 0;
}

/**
 * Decide whether a detected `</...>` match is a v1 wikilink we should rewrite,
 * or a coincidental HTML close tag we must leave alone.
 *
 * The rule: reject when the **first path segment** (everything between the
 * leading `/` and the next `/`, `#`, or end-of-payload) is a known HTML element
 * name (lowercased). Crowi page paths are case-sensitive, so `</Section>` is a
 * wikilink (page `Section`) while `</section>` is the HTML element.
 */
export function shouldRewriteWikilink(innerPath: string): boolean {
  if (innerPath === '/') return false;
  if (!innerPath.startsWith('/')) return false;
  const afterLeadingSlash = innerPath.slice(1);
  const firstSegmentEnd = afterLeadingSlash.search(/[/#]/);
  const firstSegment = firstSegmentEnd === -1 ? afterLeadingSlash : afterLeadingSlash.slice(0, firstSegmentEnd);
  if (firstSegment.length === 0) return false;
  // Only reject lowercase-ASCII first segments that are real HTML elements.
  if (!/^[a-z][a-z0-9]*$/.test(firstSegment)) return true;
  return !KNOWN_HTML_ELEMENTS.has(firstSegment);
}

/**
 * Per-body detection result — `occurrences[].raw` preserves the original raw
 * match (e.g. `</docs/api>`) so a dry-run report can print the exact textual
 * substring being touched.
 */
export interface WikilinkOccurrence {
  raw: string;
  path: string;
  alias?: string;
}

/**
 * Single-pass detect-and-rewrite. Returns the rewritten body together with the
 * occurrence list so callers don't walk the regex twice. `body` is returned by
 * reference when nothing changed, letting callers cheap-skip via
 * `result.body === body`. Pure function — no side effects, no I/O.
 */
export function rewriteAndDetect(body: string): { body: string; occurrences: WikilinkOccurrence[] } {
  const occurrences: WikilinkOccurrence[] = [];
  const rewritten = body.replace(WIKILINK_DETECTION_REGEX, (whole, innerPath: string, aliasWithPipe?: string) => {
    if (!shouldRewriteWikilink(innerPath)) return whole;
    occurrences.push({
      raw: whole,
      path: innerPath,
      alias: aliasWithPipe ? aliasWithPipe.slice(1) : undefined,
    });
    const aliasSegment = aliasWithPipe ?? '';
    return `[[${innerPath}${aliasSegment}]]`;
  });
  return { body: occurrences.length === 0 ? body : rewritten, occurrences };
}

/**
 * Convenience wrapper for tests / callers that only need the rewritten body.
 * The migration hot path uses `rewriteAndDetect` to avoid walking the regex
 * twice.
 */
export function rewriteWikilinks(body: string): string {
  return rewriteAndDetect(body).body;
}

/**
 * Walk every published page, keep those whose current revision body holds a
 * genuine legacy wikilink (`bodyHasRewritableWikilink` — the same full
 * `shouldRewriteWikilink` rule `isPending` uses, with `</` as a cheap
 * prefilter), and pair each with its rewritten body + occurrence count for
 * `ctx.rewritePageBody`.
 *
 * Restricted to `status: 'published'` (and legacy `null`, treated as published)
 * because trash / deprecated pages are read-only fixtures — touching them would
 * generate noisy update events, matching the legacy command's scope.
 */
async function collectRewritablePages(ctx: MigrationContext): Promise<{ pageId: string; newBody: string; occurrences: number }[]> {
  const Page = ctx.crowi.model('Page');
  const Revision = ctx.crowi.model('Revision');

  const out: { pageId: string; newBody: string; occurrences: number }[] = [];
  // `currentRevision ?? revision` is the body the editor seeds from
  // (on-load-document.ts), but the legacy command read `page.revision`; both
  // point at the latest body for a published page, so we read `revision` to
  // keep parity. Stream-walk so memory stays constant on large installs.
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
    if (!bodyHasRewritableWikilink(body)) continue;
    const result = rewriteAndDetect(body);
    out.push({ pageId: String(pageDoc._id), newBody: result.body, occurrences: result.occurrences.length });
  }
  return out;
}

export const wikilinkFormat = defineMigration({
  id: 'wikilink-format',
  fromVersion: '1.x',
  toVersion: '2.1',
  layer: 'preflight',
  description: 'Migrate wikilink syntax',

  /**
   * Pending verdict = at least one published page whose **current** revision
   * body still contains a genuine legacy wikilink. Two constraints shape this:
   *
   *  1. The verdict uses the **full detection rule**, not the bare substring.
   *     A v1 wikilink (`</docs/api>`) and an HTML close tag (`</div>`) both
   *     start with `</`, and there is no index on `revision.body`, so an
   *     index-backed O(1) probe is impossible without a text index (which §9
   *     says the framework does not own). We therefore walk published pages and
   *     run `bodyHasRewritableWikilink` (the same `shouldRewriteWikilink` filter
   *     used by `detect`/stage) on each current-revision body. `</` is kept only
   *     as a cheap prefilter inside that helper to skip the regex on bodies that
   *     obviously cannot contain a legacy link.
   *
   *     This is load-bearing for boot under preflight + `block` (the default):
   *     the substring alone would over-match `</div>` and report pending forever
   *     even after `migrate apply` — apply rewrites only genuine wikilinks, so
   *     HTML close tags survive and a substring verdict would never clear,
   *     deadlocking boot (§6.2: a false positive blocks every cluster boot, and
   *     here it would be unrecoverable). Using the full rule means once the
   *     migration rewrites the genuine wikilinks, a body left with only `</div>`
   *     reports false and boot clears.
   *  2. We scan only each page's **current** revision, never the whole
   *     `revisions` collection. Historical revisions keep their original
   *     `</path>` text forever (revisions are immutable), so a collection-wide
   *     scan would report pending permanently after any wikilink page ever
   *     existed — even once every live page was rewritten. So we read only the
   *     body each page's editor seeds from.
   *
   * We short-circuit at the first page carrying a genuine wikilink, so this
   * stops early rather than reading every page.
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
      const revision = await Revision.findById(revisionId).select('body').lean().exec();
      const body = (revision as { body?: unknown } | null)?.body;
      if (typeof body === 'string' && bodyHasRewritableWikilink(body)) {
        await cursor.close();
        return true;
      }
    }
    return false;
  },

  /**
   * Full scan for `plan`: count the pages that actually contain a rewritable
   * occurrence (applying the full `shouldRewriteWikilink` rule, not just the
   * substring pre-filter), plus the total occurrence count. Not called at boot.
   */
  detect: async (ctx) => {
    const pages = await collectRewritablePages(ctx);
    const totalOccurrences = pages.reduce((sum, p) => sum + p.occurrences, 0);
    return {
      summary: `${pages.length} page(s) contain legacy wikilink syntax (${totalOccurrences} occurrence(s))`,
      counts: { pages: pages.length, occurrences: totalOccurrences },
    };
  },

  stages: [
    {
      name: 'rewrite-wikilink',
      fn: async (ctx) => {
        if (ctx.dryRun) {
          // Preview only — no writes, no acting-user resolution.
          const pages = await collectRewritablePages(ctx);
          return { name: 'rewrite-wikilink', transformed: 0, stats: { wouldRewrite: pages.length } };
        }

        const actingUserId = await resolveActingUserId(ctx, 'wikilink-format');
        const pages = await collectRewritablePages(ctx);
        ctx.progress.setTotal(pages.length);

        let rewritten = 0;
        // Bounded concurrency is owned by the runner; the stage walks pages
        // serially through `ctx.rewritePageBody` (each call re-fetches the live
        // page doc, prepares a revision, and pushes it — routing through the
        // `updatePage`-equivalent path so yjsState / yjsCheckpointAt are nulled).
        for (const page of pages) {
          await ctx.rewritePageBody(page.pageId, page.newBody, { userId: actingUserId });
          rewritten += 1;
          ctx.progress.increment();
        }

        if (rewritten > 0) {
          ctx.logger.info(`wikilink-format: rewrote ${rewritten} page(s) via the updatePage path (yjsState invalidated)`);
        }
        return { name: 'rewrite-wikilink', transformed: rewritten };
      },
    },
  ],
});
