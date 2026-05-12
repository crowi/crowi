import path from 'node:path';
import dotenv from 'dotenv';
import type { Command } from 'commander';

/**
 * Resolve the @crowi/api package's installed location relative to the
 * caller's CWD (= the runner directory). See `storage-copy.ts` for the
 * rationale on `require.resolve` + manual `require` indirection (we
 * avoid importing `@crowi/api` directly so its `app.ts` auto-boot
 * doesn't fire).
 *
 * Returns `null` when the API package isn't installed at the expected
 * path so the caller can print a helpful error instead of a stack
 * trace.
 */
function loadApi(): { Crowi: ApiCrowiCtor } | null {
  let apiPkgPath: string;
  try {
    apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  } catch {
    return null;
  }
  const apiRoot = path.dirname(apiPkgPath);
  const distDir = path.join(apiRoot, 'dist');

  const crowiModule = require(path.join(distDir, 'crowi')) as { default: ApiCrowiCtor };

  return { Crowi: crowiModule.default };
}

/**
 * Minimal structural types describing the bits of @crowi/api the
 * migrator needs. We use `unknown` for everything else so the admin-cli
 * type graph doesn't have to mirror the api package's mongoose model
 * surface.
 */
interface ApiCrowi {
  initForCli(): Promise<void>;
  teardownForCli(): Promise<void>;
  model(name: string): unknown;
  event(name: string): { emit(name: string, ...args: unknown[]): void };
}
interface ApiCrowiCtor {
  new (rootDir: string, env: NodeJS.ProcessEnv): ApiCrowi;
}

/**
 * HTML5 element name set used to reject `</foo>` matches whose first
 * path segment is actually a closing HTML tag. Source:
 * https://developer.mozilla.org/en-US/docs/Web/HTML/Element — full
 * standard element list as of HTML Living Standard.
 *
 * Kept as a top-level `Set<string>` so detection runs O(1) per match.
 * `h1`..`h6` are listed explicitly because the regex captures `foo` for
 * `</foo>` and we want both `</h1>` and `</h6>` to be rejected.
 */
export const KNOWN_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
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
 * v1 angle-bracket internal link form. The capture group grabs the
 * path-style payload (starts with `/`, no whitespace, no `<` / `>` / `|`
 * other than the optional `|alias` segment). See
 * `packages/api/src/util/linkDetector.ts` — v1 used
 * `<(/[^>]+)>` for the same primitive; we tighten it here to:
 *
 *   - leading `/` to keep this strictly path-style (not arbitrary text)
 *   - no whitespace inside the **path** (consistent with v1's
 *     wikilink path syntax — Crowi page paths cannot contain spaces)
 *   - no `<` / `>` until the closing `>` and no `|` until the
 *     optional alias segment
 *   - optional `|alias` (free-form text, no `<` / `>`) — v1 alias text
 *     could include spaces, mirroring `[[/page|Display Text]]`
 *
 * Detection only — see `shouldRewriteWikilink` for the additional
 * HTML-element-name filter.
 */
export const WIKILINK_DETECTION_REGEX = /<(\/[^\s<>|]+)(\|[^<>]+)?>/g;

/**
 * Decide whether a detected `</...>` match is a v1 wikilink we should
 * rewrite, or a coincidental HTML close tag we must leave alone.
 *
 * The rule: reject when the **first path segment** (everything between
 * the leading `/` and the next `/`, `#`, or end-of-payload) is a
 * known HTML element name (lowercased). This is the same heuristic v1's
 * LinkDetector applied implicitly — its consumers treated tagged closes
 * as HTML, not links, by virtue of how the renderer escaped them.
 *
 * Examples:
 *   `</docs/api>`   first segment = `docs`    → not HTML → wikilink
 *   `</foo>`        first segment = `foo`     → not HTML → wikilink
 *   `</section>`    first segment = `section` → HTML → reject
 *   `</div>`        first segment = `div`     → HTML → reject
 *   `</br>`         first segment = `br`      → HTML → reject
 *
 * Path `/` alone (= match payload `/`) is also rejected; it's almost
 * certainly stray markup.
 */
export function shouldRewriteWikilink(innerPath: string): boolean {
  if (innerPath === '/') return false;
  if (!innerPath.startsWith('/')) return false;
  // Extract the first segment between `/` and next `/` / `#`.
  const afterLeadingSlash = innerPath.slice(1);
  const firstSegmentEnd = afterLeadingSlash.search(/[/#]/);
  const firstSegment = firstSegmentEnd === -1 ? afterLeadingSlash : afterLeadingSlash.slice(0, firstSegmentEnd);
  if (firstSegment.length === 0) return false;
  // Only reject when the first segment is **lowercase ASCII** AND
  // appears in the HTML5 element set. Crowi page paths are
  // case-sensitive, so `</Section>` should be treated as a wikilink
  // (the page name is `Section`, not the HTML `section` element).
  // HTML close tags in Markdown source are conventionally lowercase,
  // matching the same constraint.
  if (!/^[a-z][a-z0-9]*$/.test(firstSegment)) return true;
  return !KNOWN_HTML_ELEMENTS.has(firstSegment);
}

/**
 * Per-body detection result — the `occurrences` array preserves the
 * original raw matches (e.g. `</docs/api>`) and the path we'd rewrite to
 * (`/docs/api`). The dry-run report prints `raw` directly so operators
 * see the exact textual substring they'd be touching.
 */
export interface WikilinkOccurrence {
  raw: string;
  path: string;
  alias?: string;
}

/**
 * Scan a single body and return every angle-bracket internal link that
 * should be rewritten. Pure function — no side effects, no I/O.
 * `matchAll` keeps the regex stateless, no manual `lastIndex` reset.
 */
export function detectWikilinks(body: string): WikilinkOccurrence[] {
  const out: WikilinkOccurrence[] = [];
  for (const match of body.matchAll(WIKILINK_DETECTION_REGEX)) {
    const innerPath = match[1];
    const aliasWithPipe = match[2];
    if (!shouldRewriteWikilink(innerPath)) continue;
    out.push({
      raw: match[0],
      path: innerPath,
      alias: aliasWithPipe ? aliasWithPipe.slice(1) : undefined,
    });
  }
  return out;
}

/**
 * Single-pass detect-and-rewrite. Returns the rewritten body together
 * with the occurrence list so callers don't have to walk the same regex
 * twice. `body` is returned by reference when nothing changed so callers
 * can cheaply skip the save step via `result.body === body`.
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
 * Convenience wrapper kept for tests and callers that only need the
 * rewritten body. The migrator hot path uses `rewriteAndDetect` to
 * avoid walking the regex twice.
 */
export function rewriteWikilinks(body: string): string {
  return rewriteAndDetect(body).body;
}

/**
 * Wire the `migrate --only=wikilink [--dry-run]` subcommand into the
 * root program. Per spec: `--only` is a switch (not a positional) so
 * future migrators can add `--only=h1-title` etc.
 *
 * Invocation:
 *   crowi-admin migrate --only=wikilink                  # do it
 *   crowi-admin migrate --only=wikilink --dry-run        # preview only
 */
export function registerMigrateWikilink(program: Command): void {
  program
    .command('migrate')
    .description('Run a one-shot data migration. Currently only `--only=wikilink` is supported.')
    .requiredOption('--only <target>', "Which migrator to run. Today: 'wikilink'.")
    .option('--dry-run', 'Scan + report but do not write any new revisions.', false)
    .action(async (opts: { only: string; dryRun: boolean }) => {
      if (opts.only !== 'wikilink') {
        console.error(`crowi-admin: unknown migrate target '--only=${opts.only}'. Today only 'wikilink' is supported.`);
        process.exit(1);
      }

      // Load .env from the runner's CWD so MONGO_URI / CROWI_ENCRYPTION_KEY
      // flow through the same way the api boot path reads them.
      dotenv.config();

      const api = loadApi();
      if (!api) {
        console.error('crowi-admin: could not locate @crowi/api. Run from a directory that has @crowi/api installed (e.g. the runner package).');
        process.exit(1);
      }

      const crowi = new api.Crowi(process.cwd(), process.env);

      console.log(`[crowi-admin] migrate wikilink: ${opts.dryRun ? 'dry-run' : 'live'} mode`);

      try {
        await crowi.initForCli();
      } catch (err) {
        console.error('crowi-admin: failed to initialise Crowi:', (err as Error).message);
        await crowi.teardownForCli().catch(() => undefined);
        process.exit(1);
      }

      let exitCode = 0;
      try {
        const startedAt = Date.now();
        const summary = await runMigrateWikilink(crowi, { dryRun: opts.dryRun });
        const elapsedMs = Date.now() - startedAt;
        printSummary(summary, opts.dryRun, elapsedMs);
        if (summary.failed > 0) exitCode = 2;
      } catch (err) {
        console.error('crowi-admin: migrate wikilink failed:', (err as Error).message);
        if (err instanceof Error && err.stack) console.error(err.stack);
        exitCode = 1;
      } finally {
        await crowi.teardownForCli().catch(() => undefined);
      }
      process.exit(exitCode);
    });
}

interface MigrateWikilinkOptions {
  dryRun: boolean;
}

interface MigrateWikilinkSummary {
  scanned: number;
  /** Pages with at least one rewritable occurrence. Counts both
   * dry-run (would-be-changed) and live (actually-changed) pages so
   * the label difference is purely cosmetic in `printSummary`. */
  affected: number;
  failed: number;
  totalOccurrences: number;
  /** Up to first 5 affected pages, populated on dry-run only. */
  sample: { path: string; occurrences: WikilinkOccurrence[] }[];
}

const PROGRESS_INTERVAL = 100;
const DRY_RUN_SAMPLE_LIMIT = 5;
const DRY_RUN_SAMPLE_OCCURRENCE_LIMIT = 5;

/**
 * Streaming-cursor scan over every published page. For each page:
 *   - read the latest body
 *   - detect occurrences
 *   - if dry-run: record into the sample buffer
 *   - otherwise: per-page transaction → prepareRevision → pushRevision
 *
 * Per-page errors are caught and logged at this layer so one bad page
 * does not abort the whole run.
 */
async function runMigrateWikilink(crowi: ApiCrowi, opts: MigrateWikilinkOptions): Promise<MigrateWikilinkSummary> {
  // Resolve mongoose models without referencing api types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = crowi.model('Page') as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Revision = crowi.model('Revision') as any;

  const author = await resolveAuthorUser(crowi);
  if (!author) {
    throw new Error('no admin user found; set CROWI_MIGRATE_USER=<email> or create an admin user first.');
  }

  const summary: MigrateWikilinkSummary = {
    scanned: 0,
    affected: 0,
    failed: 0,
    totalOccurrences: 0,
    sample: [],
  };

  const pageEvent = crowi.event('Page');

  // Stream-walk pages so memory stays constant on large installs. We
  // restrict to `status: 'published'` because trash / deprecated pages
  // are read-only fixtures; touching them would generate noisy update
  // events. `status: null` is treated as published by the model — match
  // that here so legacy rows are not skipped. `.lean()` skips Mongoose
  // hydration for the cursor result; we re-fetch the live document with
  // `findById` when we actually need to write.
  const cursor = Page.find({ $or: [{ status: 'published' }, { status: null }] })
    .select('_id path revision status')
    .lean()
    .cursor();

  for await (const page of cursor) {
    summary.scanned += 1;

    try {
      // Need the latest revision body — `page.revision` is just an
      // ObjectId on the lean cursor result.
      const revision = await Revision.findById(page.revision).select('body').lean().exec();
      if (!revision || typeof revision.body !== 'string') continue;
      const body: string = revision.body;
      // Single regex walk: rewrite + occurrence collection in one pass.
      // `result.body === body` (referential equality) when nothing
      // matched, letting us cheap-skip pages without occurrences.
      const result = rewriteAndDetect(body);
      if (result.occurrences.length === 0) continue;

      summary.totalOccurrences += result.occurrences.length;
      summary.affected += 1;
      if (opts.dryRun && summary.sample.length < DRY_RUN_SAMPLE_LIMIT) {
        summary.sample.push({
          path: page.path,
          occurrences: result.occurrences.slice(0, DRY_RUN_SAMPLE_OCCURRENCE_LIMIT),
        });
      }
      if (opts.dryRun) continue;

      // Re-fetch the live page document (the cursor gave us a lean
      // stream copy) so pushRevision sees the current state.
      // `prepareRevision` re-runs the renderer pipeline, so renderedAst
      // is picked up by the new revision automatically.
      const livePage = await Page.findById(page._id).exec();
      if (!livePage) continue; // page deleted between scan and write — skip
      const newRevision = await Revision.prepareRevision(livePage, result.body, author);
      await Page.pushRevision(livePage, newRevision, author);

      // Mirror `Page.updatePage`'s event so backlinks / notifications /
      // search re-index pick the new body up. `bookmarkCount` is set to
      // 0 here: fetching it per-page costs an extra round-trip and the
      // batch-migrate context doesn't need accurate bookmark counts (no
      // human-facing notifications fan out from a migration).
      pageEvent.emit('update', livePage, author, 0);
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [FAIL] ${page.path} — ${message}`);
    } finally {
      if (summary.scanned % PROGRESS_INTERVAL === 0) logProgress(summary);
    }
  }

  return summary;
}

/**
 * Resolve which user is recorded as the author of every rewritten
 * revision. Order:
 *   1. `process.env.CROWI_MIGRATE_USER` — interpreted as an email; the
 *      named user must exist.
 *   2. otherwise: the oldest active admin user (`User.findOne({ admin: true })`
 *      sorted by createdAt asc) — deterministic across re-runs.
 *
 * Returns null when neither yields a user; the caller turns this into a
 * clear exit-1 error.
 */
async function resolveAuthorUser(crowi: ApiCrowi): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const User = crowi.model('User') as any;
  const explicit = process.env.CROWI_MIGRATE_USER;
  if (explicit) {
    const named = await User.findOne({ email: explicit }).exec();
    if (named) return named;
    throw new Error(`CROWI_MIGRATE_USER='${explicit}' but no user with that email exists.`);
  }
  return User.findOne({ admin: true }).sort({ createdAt: 1 }).exec();
}

function logProgress(summary: MigrateWikilinkSummary): void {
  console.log(`[crowi-admin] migrate wikilink: scanned ${summary.scanned} pages, affected ${summary.affected} (failed ${summary.failed})`);
}

function printSummary(summary: MigrateWikilinkSummary, dryRun: boolean, elapsedMs: number): void {
  console.log('');
  console.log(dryRun ? '--- dry-run summary ---' : '--- summary ---');
  console.log(`scanned:           ${summary.scanned}`);
  console.log(`${dryRun ? 'affected pages:    ' : 'rewrote:           '}${summary.affected}`);
  console.log(`total occurrences: ${summary.totalOccurrences}`);
  console.log(`failed:            ${summary.failed}`);
  console.log(`elapsed:           ${formatElapsed(elapsedMs)}`);
  if (dryRun && summary.sample.length > 0) {
    console.log('');
    console.log(`first ${summary.sample.length} affected page(s):`);
    for (const entry of summary.sample) {
      console.log(`  ${entry.path}`);
      for (const occ of entry.occurrences) {
        const aliasStr = occ.alias ? ` (alias: ${occ.alias})` : '';
        console.log(`    ${occ.raw}${aliasStr}`);
      }
    }
  }
}

/**
 * Render an elapsed millisecond duration. Mirrors search-rebuild.ts so
 * the summary block reads consistently across migrate / rebuild /
 * storage-copy commands.
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}
