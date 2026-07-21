import linkDetectorFactory from 'src/util/link-detector';

import { resolveActingUserId } from '../helpers';
import { defineMigration } from '../types';
import type { MigrationContext } from '../types';
import { rewriteOutsideCode } from './code-mask';
import { forEachPublishedCurrentRevision, STOP } from './published-current-revision';

/**
 * v1 → v2 — `files-url-to-attachments` (preflight layer).
 *
 * v1 embedded attachment / image references in page bodies as the v1 file
 * URL `/files/<24hex>` (absolute `https://<host>/files/<id>` when the editor
 * pasted a full URL, or relative `/files/<id>`). v2 serves attachments from a
 * dedicated stream route at `/api/v2/attachments/<id>` and the legacy
 * `/files/<id>` compat redirect was removed with the Express host (RFC-0006
 * Phase 6 Sub-batch D), so those v1 URLs now 404 — every such image is
 * broken. The id is identical in both forms (the same 24-hex `Attachment._id`;
 * `attachment.ts` `ATTACHMENT_URI_RE` extracts the same id from either), so the
 * fix is a pure URL rewrite — no id mapping.
 *
 * Modelled on `wikilink-format.ts` (the sibling v1→v2 body-rewrite preflight):
 * walk published (+ legacy `null`) pages, rewrite each current-revision body
 * with a single-pass detect-and-rewrite, route every write through
 * `ctx.rewritePageBody` (the `updatePage`-equivalent path that nulls
 * `yjsState` / `yjsCheckpointAt` so an active editor can't revert the rewrite
 * from a stale `Y.Doc` — see wikilink-format §4.3.1), and use a cheap
 * substring prefilter (`/files/`) before the detail regex in `isPending`.
 *
 * Rewrite rules (Markdown `![alt](url)` images and `[text](url)` links only —
 * raw HTML `<img src>` / `<a href>` is out of scope; v1 emitted Markdown):
 *
 *   1. relative `/files/<id>`                  → `/api/v2/attachments/<id>`
 *      (unconditional — a root-relative path is always this site).
 *   2. self-host absolute `https://<origin>/files/<id>`
 *                                              → `/api/v2/attachments/<id>`
 *      (relativised — drops the host so the URL is portable). `<origin>` must
 *      match `linkDetector.getAppOrigins()` (CLIENT_URL / BASE_URL).
 *   3. external absolute `https://other/files/<id>` → left untouched
 *      (we must not rewrite an unrelated third-party `/files/<id>` image).
 *
 * Host moves (v1 domain ≠ v2 domain) are out of scope: the separate `replace
 * url` admin-cli command rewrites the old host → new host first, after which
 * the self-host absolute URLs match CLIENT_URL and rule 2 relativises them.
 *
 * Idempotent: the output `/api/v2/attachments/<id>` never matches the
 * `/files/` regex, so a re-apply is a no-op (no double rewrite).
 *
 * CLIENT_URL / BASE_URL unset: `getAppOrigins()` returns `[]`, so the
 * self-host alternation is empty and rule 2 is skipped — only relative
 * `/files/<id>` (rule 1) is rewritten and absolute URLs are left alone.
 */

/** v2 attachment URL prefix the rewrite targets. */
const V2_ATTACHMENT_PREFIX = '/api/v2/attachments/';

/**
 * Substring that necessarily precedes every rewritable v1 file URL: `/files/`.
 * Cheapest probe guaranteed present whenever a real `/files/<id>` reference
 * exists, so a body without it can skip the regex entirely (no false
 * negatives). The actual verdict still applies the full detect rule — see
 * `bodyHasRewritableFilesUrl`.
 */
const FILES_SUBSTRING_PROBE = '/files/';

/**
 * Per-body breakdown of what a rewrite touched / skipped, returned alongside
 * the rewritten body so callers walk the regex once.
 *   - `relative`: rule 1 (relative `/files/<id>`) rewrites.
 *   - `selfHostAbsolute`: rule 2 (self-host absolute) rewrites.
 *   - `externalSkipped`: rule 3 (external absolute) left untouched.
 */
export interface FilesUrlRewriteCounts {
  relative: number;
  selfHostAbsolute: number;
  externalSkipped: number;
}

const emptyCounts = (): FilesUrlRewriteCounts => ({ relative: 0, selfHostAbsolute: 0, externalSkipped: 0 });

/**
 * Build the per-body rewrite regex. It matches a Markdown image/link whose URL
 * payload points at `/files/<24hex>` in one of two forms:
 *
 *   - relative: the URL part starts with `/files/<id>`
 *   - absolute: the URL part is `<scheme>://<host>.../files/<id>`
 *
 * The `![alt]` / `[text]` head and the trailing path/query/fragment after the
 * id are captured verbatim and re-emitted unchanged; only the host + `/files/`
 * → `/api/v2/attachments/` portion is rewritten. Self-host classification of
 * absolute URLs is decided in the callback (not the regex) so external hosts
 * fall through untouched.
 *
 * A fresh `RegExp` per call keeps `lastIndex` state local (the regex is `g`).
 */
function buildFilesUrlRegex(): RegExp {
  // Group layout:
  //   1: the markdown head `![alt]` or `[text]` (incl. the leading `!` if image)
  //   2: optional `<scheme>://<host>` for an absolute URL (undefined when relative)
  //   3: the 24-hex attachment id
  //   4: the trailing remainder inside the parens after the id (path/query/#),
  //      excluding the closing `)` and whitespace
  return /(!?\[[^\]]*\])\((https?:\/\/[^\s)/]+)?\/files\/([0-9a-fA-F]{24})([^\s)]*)\)/g;
}

/**
 * Decide whether an absolute URL's `<scheme>://<host>` prefix belongs to this
 * Crowi instance. `origins` are the normalised `getAppOrigins()` values
 * (trailing slash trimmed). A match means the URL is self-host and should be
 * relativised (rule 2); a non-match is external and left untouched (rule 3).
 *
 * The match is exact against the captured `<scheme>://<host>` (no path), so
 * `https://wiki.example.com` matches origin `https://wiki.example.com` but not
 * `https://evil.example.com`.
 */
function isSelfHostOrigin(schemeAndHost: string, origins: readonly string[]): boolean {
  return origins.includes(schemeAndHost);
}

/**
 * Single-pass detect-and-rewrite. Returns the rewritten body plus a count
 * breakdown so callers don't walk the regex twice. Pure — no I/O. Returns
 * `body` by reference when nothing changed (no rule-1/2 rewrite), letting
 * callers cheap-skip via `result.body === body`.
 *
 * `origins` is the self-host allow-list (`getAppOrigins()`); pass `[]` to
 * disable rule 2 (CLIENT_URL / BASE_URL unset).
 *
 * Code regions (fenced blocks + inline spans) are excluded via the shared
 * `rewriteOutsideCode` primitive: a `/files/<id>` written as a code example is
 * left byte-identical (never rewritten, never counted) so it cannot be
 * corrupted, nor falsely report the migration as pending. Indented code is an
 * accepted divergence (still rewritten). AD-2 (an `![alt](url)` whose alt text
 * contains an inline-code span straddles a segment boundary, leaving its URL
 * unrewritten) is documented in the spec — an accepted false-negative.
 */
export function rewriteFilesUrls(body: string, origins: readonly string[]): { body: string; counts: FilesUrlRewriteCounts } {
  const counts = emptyCounts();
  const rewriteSegment = (text: string): string =>
    text.replace(buildFilesUrlRegex(), (whole, head: string, schemeAndHost: string | undefined, id: string, rest: string) => {
      if (schemeAndHost === undefined) {
        // Rule 1 — relative `/files/<id>` is unconditionally this site.
        counts.relative += 1;
        return `${head}(${V2_ATTACHMENT_PREFIX}${id}${rest})`;
      }
      if (isSelfHostOrigin(schemeAndHost, origins)) {
        // Rule 2 — self-host absolute URL; relativise (drop the host).
        counts.selfHostAbsolute += 1;
        return `${head}(${V2_ATTACHMENT_PREFIX}${id}${rest})`;
      }
      // Rule 3 — external host; leave untouched.
      counts.externalSkipped += 1;
      return whole;
    });
  const rewritten = rewriteOutsideCode(body, rewriteSegment);
  const changed = counts.relative > 0 || counts.selfHostAbsolute > 0;
  return { body: changed ? rewritten : body, counts };
}

/**
 * True iff `body` holds at least one *rewritable* v1 file URL — a relative
 * `/files/<id>` or a self-host absolute one (external-only bodies report
 * false). `/files/` is a cheap prefilter so bodies that can't contain one skip
 * the regex; the verdict itself is the full rule (external skips don't count)
 * so a body whose only `/files/<id>` is external correctly reports false.
 * Shared by `isPending` and `collectRewritablePages`.
 */
export function bodyHasRewritableFilesUrl(body: string, origins: readonly string[]): boolean {
  if (!body.includes(FILES_SUBSTRING_PROBE)) return false;
  const { counts } = rewriteFilesUrls(body, origins);
  return counts.relative > 0 || counts.selfHostAbsolute > 0;
}

/**
 * The self-host origins for the current instance, via the same
 * `linkDetector.getAppOrigins()` helper backlink classification uses
 * (CLIENT_URL + BASE_URL, trailing slash trimmed, deduped). Returns `[]` when
 * neither is configured — rule 2 is then disabled (relative-only rewrite).
 */
function resolveAppOrigins(ctx: MigrationContext): string[] {
  return linkDetectorFactory(ctx.crowi).getAppOrigins();
}

/**
 * Resolve which user is recorded as the author of every rewritten revision.
 * `rewritePageBody` ultimately calls `Revision.prepareRevision`, which throws
 * on a falsy user, so we resolve a real acting user up front. Order mirrors
 * `wikilink-format`:
 *   1. `process.env.CROWI_MIGRATE_USER` (an email; the user must exist).
 *   2. otherwise the oldest admin (`{ admin: true }` by `createdAt`).
 * Throws when neither yields a user. Implementation in `../helpers.ts` is
 * shared with the other preflight body-rewrite migrations (`wikilink-format`).
 */

/** A page that actually changes under the rewrite, paired with its new body. */
interface RewritablePage {
  pageId: string;
  newBody: string;
  counts: FilesUrlRewriteCounts;
}

/**
 * One full scan of every published (+ legacy `null`) page (trash & deprecated
 * are read-only fixtures — same scope as `wikilink-format`). Returns:
 *   - `rewritable`: the pages that actually change (≥1 relative / self-host
 *     rewrite), each with its rewritten body for `ctx.rewritePageBody`.
 *   - `totals`: the rewrite breakdown aggregated across **every** page with a
 *     `/files/` reference (so `externalSkipped` reflects external URLs even on
 *     pages with no rewritable URL — an operator signal for "why some /files/
 *     references remain").
 * Stream-walks so memory stays constant on large installs.
 */
async function scanFilesUrls(ctx: MigrationContext, origins: readonly string[]): Promise<{ rewritable: RewritablePage[]; totals: FilesUrlRewriteCounts }> {
  const rewritable: RewritablePage[] = [];
  const totals = emptyCounts();

  // `forEachPublishedCurrentRevision` streams the published-page walk and
  // batch-fetches revisions (`$in`, default batch size) so memory stays
  // constant on large installs and there is no per-page `findById`.
  await forEachPublishedCurrentRevision(ctx, { projection: 'body' }, ({ revision, pageId }) => {
    const body = (revision as { body?: unknown }).body;
    if (typeof body !== 'string') return;
    if (!body.includes(FILES_SUBSTRING_PROBE)) return;
    const result = rewriteFilesUrls(body, origins);
    totals.relative += result.counts.relative;
    totals.selfHostAbsolute += result.counts.selfHostAbsolute;
    totals.externalSkipped += result.counts.externalSkipped;
    if (result.body === body) return;
    rewritable.push({ pageId, newBody: result.body, counts: result.counts });
  });
  return { rewritable, totals };
}

export const filesUrlToAttachments = defineMigration({
  id: 'files-url-to-attachments',
  fromVersion: '1.x',
  toVersion: '2.1',
  layer: 'preflight',
  // Body URL rewrite only; a `/files/<id>` → 302 fallback keeps pages working
  // even unapplied. `isPending` scans the live corpus → re-triggers on new
  // content. Cosmetic.
  severity: 'cosmetic',
  description: 'Rewrite v1 /files/<id> attachment URLs to v2 /api/v2/attachments/<id>',

  /**
   * Pending verdict = at least one published page whose **current** revision
   * body still contains a rewritable v1 file URL. Mirrors `wikilink-format`:
   *
   *  1. The verdict uses the **full rule** (`bodyHasRewritableFilesUrl`), not
   *     the bare substring. `/files/` could appear in an external URL we leave
   *     alone (rule 3); counting that would report pending forever after apply
   *     (apply only rewrites self URLs), deadlocking boot under preflight +
   *     `block`. The full rule reports false once only external `/files/`
   *     references remain, so boot clears.
   *  2. We scan only each page's **current** revision, never the whole
   *     `revisions` collection — historical revisions keep their original
   *     `/files/<id>` text forever (immutable), so a collection-wide scan
   *     would pend permanently after any such page ever existed.
   *
   * Short-circuits at the first rewritable page. `batchSize: 1` makes
   * `forEachPublishedCurrentRevision` fetch (and visit) one page's revision at
   * a time, so `STOP` aborts at the first hit — strictly equivalent to the
   * former first-hit `cursor.close(); return true` (a default batch size
   * would fetch a whole batch's revisions before the `STOP` took effect).
   */
  isPending: async (ctx) => {
    const origins = resolveAppOrigins(ctx);
    let pending = false;
    await forEachPublishedCurrentRevision(ctx, { projection: 'body', batchSize: 1 }, ({ revision }) => {
      const body = (revision as { body?: unknown }).body;
      if (typeof body === 'string' && bodyHasRewritableFilesUrl(body, origins)) {
        pending = true;
        return STOP;
      }
    });
    return pending;
  },

  /**
   * Full scan for `plan`: affected page count plus the rewrite breakdown
   * (relative / self-host absolute rewrites + external skips, the last
   * aggregated across every `/files/` page — see `scanFilesUrls`). Not called
   * at boot.
   */
  detect: async (ctx) => {
    const origins = resolveAppOrigins(ctx);
    const { rewritable, totals } = await scanFilesUrls(ctx, origins);
    const rewrites = totals.relative + totals.selfHostAbsolute;
    return {
      summary: `${rewritable.length} page(s) need a v1 /files/<id> rewrite (${rewrites} rewrite(s): ${totals.relative} relative, ${totals.selfHostAbsolute} self-host absolute; ${totals.externalSkipped} external skipped)`,
      counts: {
        pages: rewritable.length,
        rewrites,
        relative: totals.relative,
        selfHostAbsolute: totals.selfHostAbsolute,
        externalSkipped: totals.externalSkipped,
      },
    };
  },

  stages: [
    {
      name: 'rewrite-files-url',
      fn: async (ctx) => {
        const origins = resolveAppOrigins(ctx);
        if (ctx.dryRun) {
          const { rewritable } = await scanFilesUrls(ctx, origins);
          return { name: 'rewrite-files-url', transformed: 0, stats: { wouldRewrite: rewritable.length } };
        }

        const actingUserId = await resolveActingUserId(ctx, 'files-url-to-attachments');
        const { rewritable: pages } = await scanFilesUrls(ctx, origins);
        ctx.progress.setTotal(pages.length);

        let rewritten = 0;
        // Serial walk through `ctx.rewritePageBody` (each call re-fetches the
        // live page, prepares a revision, and pushes it via the updatePage
        // path so yjsState / yjsCheckpointAt are nulled).
        for (const page of pages) {
          await ctx.rewritePageBody(page.pageId, page.newBody, { userId: actingUserId });
          rewritten += 1;
          ctx.progress.increment();
        }

        if (rewritten > 0) {
          ctx.logger.info(`files-url-to-attachments: rewrote ${rewritten} page(s) via the updatePage path (yjsState invalidated)`);
        }
        return { name: 'rewrite-files-url', transformed: rewritten };
      },
    },
  ],
});
