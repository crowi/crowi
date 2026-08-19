import Debug from 'debug';
import type { Types } from 'mongoose';
import type Crowi from 'src/crowi';
import { MigrationRunnerCore } from 'src/migration/runner';
import type { ProgressReporter } from 'src/migration/types';
import { STATUS_DELETED, STATUS_DEPRECATED, STATUS_PUBLISHED } from 'src/models/page';
import type { UserDocument } from 'src/models/user';
import { allocateContentSequence } from 'src/service/page-history/content-sequence';

const debug = Debug('crowi:util:replace-url');

/**
 * feature-url-replace-admin-cli — bulk in-body URL/host replacement.
 *
 * When a Crowi instance changes its public domain during a v1→v2 migration,
 * page bodies keep absolute URLs pinned to the old host (e.g.
 * `![shot.png](https://old.example/files/<id>)`). File / page ids are carried
 * over unchanged, so the fix is a literal host (URL prefix) swap — not an id
 * remap. Run via `crowi-admin replace url --from <url> --to <url>`.
 *
 * Why this does NOT route through `Page.updatePage` / `ctx.rewritePageBody`
 * (the path `wikilink-format` uses): `updatePage` ends with
 * `pageEvent.emit('update', …, revisionCreated=true)`, and `onUpdate`
 * (registered unconditionally in `setupModels`, so live even under the CLI's
 * `initForCli`) fans out an UPDATE notification to every watcher, auto-watches
 * the acting user onto every touched page, and kicks per-page search/backlink
 * side effects that race `teardownForCli`. A domain cleanup must be invisible
 * to end users, so we rewrite at the persistence layer WITHOUT emitting the
 * event: push a new revision, repoint `revision` / `currentRevision`, null the
 * Yjs snapshot (so the next `onLoadDocument` rebuilds from the new body — the
 * same invariant `updatePage` upholds), and deliberately leave `updatedAt` /
 * `lastUpdateUser` / `grant` untouched so listings and visibility don't move.
 *
 * Derived data after a run: served HTML is fresh because `prepareRevision`
 * re-renders `renderedAst` onto the new revision; only the per-page embed cache
 * is evicted directly. Search must be rebuilt separately (`crowi-admin rebuild
 * search`); backlinks are unaffected (external URLs are not internal links).
 */

/** Minimum sensible `--from` length; anything shorter risks mass corruption. */
const MIN_FROM_LENGTH = 4;
/** How many matched pages to surface as preview samples. */
const SAMPLE_LIMIT = 10;
/** Max characters of a sample line before truncation. */
const SNIPPET_MAX = 160;

/** Result of a single pure body replacement. */
export interface ReplaceResult {
  /** Rewritten body — returned by reference (=== input) when nothing matched. */
  body: string;
  /** Number of literal occurrences of `from` replaced. */
  occurrences: number;
}

/**
 * Literal, single-pass, global substring replacement. `from` is matched
 * verbatim (no regex), so it is safe for URLs full of `/` `.` `?` etc.
 * `from === to` / empty `from` are no-ops. Returns the input body by reference
 * when there is nothing to change so callers can cheap-skip on `result.body === body`.
 */
export function replaceUrlInBody(body: string, from: string, to: string): ReplaceResult {
  if (from === '' || from === to) return { body, occurrences: 0 };
  const parts = body.split(from);
  const occurrences = parts.length - 1;
  if (occurrences === 0) return { body, occurrences: 0 };
  return { body: parts.join(to), occurrences };
}

/** Verdict from the pre-flight argument safety check (§a guard). */
export interface ReplaceSafety {
  /** Hard errors — abort regardless of `--force`. */
  errors: string[];
  /** Advisory warnings — print and continue. */
  warnings: string[];
  /** True when `--from` lacks an `http(s)://` scheme (prefix-collision risk → needs `--force`). */
  bareHostFrom: boolean;
}

/**
 * Assess whether a `from`→`to` pair is safe to apply as a literal replace.
 * Pure + exported so both the CLI and tests share one rule set.
 *
 * The headline risk of literal substring replace is silent prefix corruption:
 * `from = "wiki.example.in"` is a prefix of `wiki.example.int`, so a bare host
 * can mangle unrelated domains. We therefore flag scheme-less `from` (caller
 * gates it behind `--force`) and reject empty / identical / too-short inputs.
 */
export function assessReplaceSafety(from: string, to: string): ReplaceSafety {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (from === '') errors.push('--from must not be empty.');
  else if (from === to) errors.push('--from and --to are identical; nothing to replace.');
  else if (from.length < MIN_FROM_LENGTH) errors.push(`--from is too short (<${MIN_FROM_LENGTH} chars); refusing to avoid mass corruption.`);

  const bareHostFrom = from.length > 0 && !/^https?:\/\//i.test(from);

  if (from.length > 0 && to.length > 0) {
    if (to.includes(from)) warnings.push('--to contains --from; re-running this command would replace again (not idempotent).');
    else if (from.includes(to)) warnings.push('--from contains --to; double-check you did not swap --from and --to.');
  }

  return { errors, warnings, bareHostFrom };
}

/** One previewed page that contains `from`. */
export interface ReplaceUrlSample {
  path: string;
  occurrences: number;
  /** The first line containing `from`, trimmed/capped for display. */
  snippet: string;
}

/** Scan result shown before any write (and the whole story for `--dry-run`). */
export interface ReplaceUrlPreview {
  pagesMatched: number;
  occurrences: number;
  samples: ReplaceUrlSample[];
}

/** Final outcome surfaced to the CLI for the summary block + exit code. */
export interface ReplaceUrlSummary extends ReplaceUrlPreview {
  from: string;
  to: string;
  dryRun: boolean;
  /** True when a `confirm` hook declined the write. */
  aborted: boolean;
  pagesScanned: number;
  pagesRewritten: number;
  failed: number;
  interrupted: boolean;
  actingUserEmail?: string;
}

export interface ReplaceUrlOptions {
  from: string;
  to: string;
  /** Email of the author recorded on the new revisions; defaults to the oldest admin. */
  userEmail?: string;
  dryRun?: boolean;
  /** Include trashed / deprecated pages in addition to published (+ legacy null). */
  includeTrash?: boolean;
  concurrency?: number;
  progress?: ProgressReporter;
  /**
   * Optional gate called once after the scan and before any write (never in
   * dry-run). Return false to abort without writing. The CLI binds this to an
   * interactive confirmation; tests omit it to write unconditionally.
   */
  confirm?: (preview: ReplaceUrlPreview) => Promise<boolean>;
}

/** Status set in scope: default = published + legacy null; +trash adds deleted/deprecated. */
function statusFilter(includeTrash: boolean): Record<string, unknown> {
  const statuses = includeTrash ? [null, STATUS_PUBLISHED, STATUS_DELETED, STATUS_DEPRECATED] : [null, STATUS_PUBLISHED];
  return { status: { $in: statuses } };
}

/** Extract the first line containing `from`, trimmed and capped, for a preview sample. */
function firstSnippet(body: string, from: string): string {
  const idx = body.indexOf(from);
  if (idx === -1) return '';
  const lineStart = body.lastIndexOf('\n', idx) + 1;
  const nl = body.indexOf('\n', idx);
  const lineEnd = nl === -1 ? body.length : nl;
  const line = body.slice(lineStart, lineEnd).trim();
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX)}…` : line;
}

/**
 * Resolve the author recorded on every new revision: `--user <email>` (must
 * exist) → else the oldest admin (deterministic). `prepareRevision` throws on a
 * userless revision, so a real user must be resolved up front. Mirrors
 * `wikilink-format`'s `resolveActingUserId`.
 */
async function resolveActingUser(crowi: Crowi, email?: string): Promise<UserDocument> {
  const User = crowi.model('User');
  if (email) {
    const named = await User.findOne({ email }).exec();
    if (!named) throw new Error(`--user '${email}': no user with that email exists.`);
    return named;
  }
  const admin = await User.findOne({ admin: true }).sort({ createdAt: 1 }).exec();
  if (!admin) throw new Error('replace url: no admin user found; pass --user <email> or create an admin user first.');
  return admin;
}

/** Walk in-scope pages, returning those whose current revision body contains `from`. */
async function scan(
  crowi: Crowi,
  from: string,
  includeTrash: boolean,
): Promise<{ matches: { pageId: string; path: string }[]; pagesScanned: number; preview: ReplaceUrlPreview }> {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');

  const matches: { pageId: string; path: string }[] = [];
  const samples: ReplaceUrlSample[] = [];
  let pagesScanned = 0;
  let occurrences = 0;

  // Stream-walk so a large install doesn't have to fit in memory. Read each
  // page's CURRENT revision body (the body editors / viewers seed from).
  const cursor = Page.find(statusFilter(includeTrash)).select('_id path revision').lean().cursor();
  for (let page = await cursor.next(); page != null; page = await cursor.next()) {
    pagesScanned++;
    const pageDoc = page as unknown as { _id: Types.ObjectId; path: string; revision?: Types.ObjectId | null };
    if (!pageDoc.revision) continue;
    const rev = (await Revision.findById(pageDoc.revision).select('body').lean()) as { body?: unknown } | null;
    const body = rev?.body;
    if (typeof body !== 'string' || !body.includes(from)) continue;
    const occ = body.split(from).length - 1;
    if (occ === 0) continue;
    matches.push({ pageId: String(pageDoc._id), path: pageDoc.path });
    occurrences += occ;
    if (samples.length < SAMPLE_LIMIT) samples.push({ path: pageDoc.path, occurrences: occ, snippet: firstSnippet(body, from) });
  }

  return { matches, pagesScanned, preview: { pagesMatched: matches.length, occurrences, samples } };
}

/**
 * Quietly rewrite one page's current body: re-read the latest revision (so a
 * concurrent edit isn't clobbered with stale content), re-apply the literal
 * replace, push a new revision, repoint `revision` / `currentRevision`, and
 * null the Yjs snapshot — WITHOUT touching `updatedAt` / `lastUpdateUser` /
 * `grant` and WITHOUT emitting `pageEvent`. Returns true when a rewrite was
 * written, false when the page vanished or no longer matches.
 */
async function quietRewrite(crowi: Crowi, pageId: string, from: string, to: string, actingUser: UserDocument): Promise<boolean> {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');

  const page = await Page.findById(pageId).exec();
  if (!page?.revision) return false;
  const currentRev = await Revision.findById(page.revision).exec();
  if (!currentRev || typeof currentRev.body !== 'string') return false;

  const { body: newBody, occurrences } = replaceUrlInBody(currentRev.body, from, to);
  if (occurrences === 0) return false; // changed since the scan — nothing to do

  const newRevision = await Revision.prepareRevision(page, newBody, actingUser, {});
  await newRevision.save();

  // Repoint both pointers (display + collab seed) and drop the Y.Doc snapshot
  // so the next onLoadDocument rebuilds from the new body. Leave updatedAt /
  // lastUpdateUser / grant exactly as they were — the change is invisible in
  // listings and visibility, auditable only via the new revision's author.
  page.revision = newRevision._id;
  page.currentRevision = newRevision._id;
  page.yjsState = null;
  page.yjsCheckpointAt = null;
  await page.save();

  // RFC-0021 §D-1/§D-8 (Phase 2a) — the only one of the 5 content-writer
  // routes that reaches neither `Page.pushRevision` nor `Page.updatePage`,
  // so it calls the allocator explicitly. Runs strictly after the pointer
  // write above commits (§D-1). `updatedAt` / `lastUpdateUser` stay
  // untouched (this function's own contract, unaffected — the allocator
  // never writes pointer-adjacent fields, §D-4). Never allowed to turn a
  // successful rewrite into a failed one (§D-6): the outcome is logged at
  // `debug` (pageId/revisionId/reason only, per the spec's operator-output
  // contract) and otherwise discarded either way. No try/catch here on
  // purpose: `allocateContentSequence` never rejects.
  const outcome = await allocateContentSequence(crowi, page._id, newRevision._id);
  if (!outcome.allocated) {
    debug('quietRewrite: allocateContentSequence did not allocate for page %s revision %s: %s', pageId, newRevision._id, outcome.reason);
  }

  // Evict only this page's embed render cache, directly (not via pageEvent, so
  // no notification fan-out). Served markdown is already fresh via the new
  // revision's renderedAst; this covers `@[tag](old-url)` plugin embeds.
  const renderer = crowi.renderer;
  if (renderer && crowi.isMongoConnected()) {
    try {
      await renderer.cache.invalidatePage(String(page._id));
    } catch {
      // best-effort — a stale embed cache entry is not worth failing the run
    }
  }

  return true;
}

/**
 * Scan every in-scope page for `from`, optionally confirm, then quietly rewrite
 * each match to `to`. Reuses `MigrationRunnerCore` purely for its public
 * SIGINT-aware bounded-concurrency map (`mapBounded` / `installSigintHandler`);
 * it never touches the migration audit log.
 */
export async function runReplaceUrl(crowi: Crowi, opts: ReplaceUrlOptions): Promise<ReplaceUrlSummary> {
  const { from, to } = opts;
  const dryRun = Boolean(opts.dryRun);
  const includeTrash = Boolean(opts.includeTrash);

  // Resolve the acting user before the (potentially long) scan so a bad
  // `--user` fails fast. Not needed for a dry-run (no writes).
  const actingUser = dryRun ? undefined : await resolveActingUser(crowi, opts.userEmail);

  const { matches, pagesScanned, preview } = await scan(crowi, from, includeTrash);

  const base: ReplaceUrlSummary = {
    ...preview,
    from,
    to,
    dryRun,
    aborted: false,
    pagesScanned,
    pagesRewritten: 0,
    failed: 0,
    interrupted: false,
    actingUserEmail: actingUser?.email,
  };

  if (dryRun || matches.length === 0) return base;

  if (opts.confirm) {
    const proceed = await opts.confirm(preview);
    if (!proceed) return { ...base, aborted: true };
  }

  const core = new MigrationRunnerCore(crowi, { concurrency: opts.concurrency ?? 8 });
  const dispose = core.installSigintHandler();
  let pagesRewritten = 0;
  let failed = 0;
  try {
    const { interrupted } = await core.mapBounded(matches, async (m) => {
      opts.progress?.setLabel(m.path);
      try {
        if (await quietRewrite(crowi, m.pageId, from, to, actingUser as UserDocument)) pagesRewritten++;
      } catch (err) {
        failed++;
        core.context.logger.warn(`replace url: failed on ${m.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      opts.progress?.increment(1);
    });
    return { ...base, pagesRewritten, failed, interrupted };
  } finally {
    dispose();
  }
}
