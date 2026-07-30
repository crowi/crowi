#!/usr/bin/env node
// HTTP-only QA fixture seeder for the `crowi-qa` skill's `api-fixture` setup
// mode (`.claude/skills/crowi-qa/SKILL.md` §6.4, design in
// `.feature-state/specs/feature-qa-fixture-seeding.md`). Talks only to the
// QA-owned instance's `/api` surface via the Node built-in `fetch` — no
// Mongo driver, no workspace package import (design judgement §4). Starting
// the QA-owned instance, provisioning the installer admin, and dropping the
// per-run DB afterwards are the calling skill's responsibility, not this
// script's — see SKILL.md §6.4.
//
// Usage:
//   node seed-fixtures.mjs \
//     --proxy-url http://127.0.0.1:<proxyPort> \
//     --run-id <run-id> \
//     --charter <table|grant|backlink|search|comment> \
//     --email <fixed admin email> \
//     --password <fixed admin password> \
//     --manifest-path .reviews/qa/<run-id>/created.json \
//     [--poll-interval-ms 300] [--poll-max-attempts 10]
//
// Prints a single JSON object to stdout (never a raw token — design
// judgement §1.4 / §12) and appends the created resources to the manifest
// before exiting. Exit code is 0 on success, 1 when the charter's own
// readiness polling classifies the run as `blocked: ...` (design judgement
// §1.3 — a blocked charter still keeps whatever fixtures it managed to
// create; only the "wait for the side effect to become visible" step
// failed), and 2 for a hard usage/network error.

import fs from 'node:fs';
import path from 'node:path';

// ── CLI arg parsing (zero-dep) ──

const REQUIRED_FLAGS = ['proxy-url', 'run-id', 'charter', 'email', 'password', 'manifest-path'];
const OPTIONAL_FLAGS = ['poll-interval-ms', 'poll-max-attempts'];
const ALL_FLAGS = [...REQUIRED_FLAGS, ...OPTIONAL_FLAGS];

export const CHARTERS = ['table', 'grant', 'backlink', 'search', 'comment'];

/**
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {Record<string, string>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (!ALL_FLAGS.includes(name)) {
      throw new Error(`unknown flag --${name} (known flags: ${ALL_FLAGS.map((f) => `--${f}`).join(', ')})`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    out[name] = value;
    i += 1;
  }
  for (const name of REQUIRED_FLAGS) {
    if (out[name] === undefined) throw new Error(`--${name} is required`);
  }
  if (!CHARTERS.includes(out.charter)) {
    throw new Error(`--charter must be one of: ${CHARTERS.join(', ')} (got ${out.charter})`);
  }
  return out;
}

// ── manifest read/write (design judgement §3: type-tagged, backward compatible) ──

/**
 * Pre-existing manifest entries (written before this feature) have no
 * `type` field — read them as `type: "page"`. New entries this script
 * writes always carry an explicit `type`.
 * @param {unknown} entry
 * @returns {Record<string, unknown>}
 */
export function normalizeManifestEntry(entry) {
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && (/** @type {Record<string, unknown>} */ (entry)).type === undefined) {
    return { type: 'page', .../** @type {Record<string, unknown>} */ (entry) };
  }
  return /** @type {Record<string, unknown>} */ (entry);
}

/**
 * @param {string} manifestPath
 * @returns {Record<string, unknown>[]}
 */
export function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return [];
  const raw = fs.readFileSync(manifestPath, 'utf8').trim();
  if (raw === '') return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`manifest ${manifestPath} does not contain a JSON array`);
  return parsed.map(normalizeManifestEntry);
}

/**
 * Append `newEntries` to the manifest at `manifestPath`, creating the file
 * (and its parent directory) if it doesn't exist yet. Pre-existing entries
 * are normalized (see `normalizeManifestEntry`) so re-reading an old-shape
 * manifest and writing it back never drops the back-compat parsing.
 * @param {string} manifestPath
 * @param {Record<string, unknown>[]} newEntries
 */
export function appendManifest(manifestPath, newEntries) {
  const existing = readManifest(manifestPath);
  const merged = [...existing, ...newEntries];
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
}

// ── HTTP helpers ──

/** Read a response body as text without throwing if the stream is already spent. */
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

/**
 * `POST /api/auth/login` — mirrors `packages/e2e/src/api.ts`'s
 * `loginViaApi`. Returns only the access token; this script never writes
 * `refreshToken` anywhere (nothing needs a long-lived session).
 * @param {{ proxyUrl: string, email: string, password: string }} params
 * @returns {Promise<string>}
 */
export async function login({ proxyUrl, email, password }) {
  const response = await fetch(`${proxyUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`login failed for ${email}: HTTP ${response.status} ${await safeText(response)}`);
  }
  const body = /** @type {{ accessToken?: string }} */ (await response.json());
  if (!body.accessToken) throw new Error('login response did not include an accessToken');
  return body.accessToken;
}

/**
 * `POST /api/pages` — creates a fixture page and returns its id, path,
 * and (populated) latest revision id.
 * @param {{ proxyUrl: string, accessToken: string, path: string, body: string }} params
 * @returns {Promise<{ pageId: string, path: string, revisionId: string | null }>}
 */
export async function createPage({ proxyUrl, accessToken, path: pagePath, body }) {
  const response = await fetch(`${proxyUrl}/api/pages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: pagePath, body }),
  });
  if (!response.ok) {
    throw new Error(`create page ${pagePath} failed: HTTP ${response.status} ${await safeText(response)}`);
  }
  const json = /** @type {{ page?: { _id?: string, id?: string, revision?: string | { _id?: string } } }} */ (await response.json());
  const pageId = json.page?._id ?? json.page?.id;
  if (!pageId) throw new Error(`create page ${pagePath} response did not include a page id: ${JSON.stringify(json)}`);
  const revision = json.page?.revision;
  const revisionId = typeof revision === 'string' ? revision : (revision?._id ?? null);
  return { pageId, path: pagePath, revisionId };
}

/**
 * `GET /api/pages?page_id=...` — fallback revision-id lookup for
 * `createPage` responses whose `revision` isn't populated for some reason
 * (mirrors `getPageLatestRevisionId` in `packages/e2e/src/api.ts`).
 * @param {{ proxyUrl: string, accessToken: string, pageId: string }} params
 * @returns {Promise<string>}
 */
export async function getPageLatestRevisionId({ proxyUrl, accessToken, pageId }) {
  const response = await fetch(`${proxyUrl}/api/pages?page_id=${encodeURIComponent(pageId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`get page ${pageId} failed: HTTP ${response.status} ${await safeText(response)}`);
  }
  const json = /** @type {{ page?: { revision?: string | { _id?: string } } }} */ (await response.json());
  const revision = json.page?.revision;
  const revisionId = typeof revision === 'string' ? revision : revision?._id;
  if (!revisionId) throw new Error(`get page ${pageId} response did not include a revision id: ${JSON.stringify(json)}`);
  return revisionId;
}

/**
 * `POST /api/comments` — mirrors `addCommentViaApi` in
 * `packages/e2e/src/api.ts`.
 * @param {{ proxyUrl: string, accessToken: string, pageId: string, revisionId: string, comment: string }} params
 * @returns {Promise<string>}
 */
export async function addComment({ proxyUrl, accessToken, pageId, revisionId, comment }) {
  const response = await fetch(`${proxyUrl}/api/comments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ page_id: pageId, revision_id: revisionId, comment }),
  });
  if (!response.ok) {
    throw new Error(`add comment on ${pageId} failed: HTTP ${response.status} ${await safeText(response)}`);
  }
  const json = /** @type {{ comment?: { _id?: string } }} */ (await response.json());
  const commentId = json.comment?._id;
  if (!commentId) throw new Error(`add comment response did not include a comment id: ${JSON.stringify(json)}`);
  return commentId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `GET /api/backlinks?page_id=<target>` readiness polling (design
 * judgement §1.3): backlink registration is fire-and-forget from the source
 * page's save, so poll a finite number of times until the source page
 * shows up rather than trusting the create response.
 * @param {{ proxyUrl: string, accessToken: string, targetPageId: string, sourcePageId: string, intervalMs: number, maxAttempts: number }} params
 * @returns {Promise<boolean>} whether the backlink was observed
 */
export async function pollBacklinkObserved({ proxyUrl, accessToken, targetPageId, sourcePageId, intervalMs, maxAttempts }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(`${proxyUrl}/api/backlinks?page_id=${encodeURIComponent(targetPageId)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const json = /** @type {{ backlinks?: { fromPage?: { _id?: string } }[] }} */ (await response.json());
      const found = (json.backlinks ?? []).some((b) => b.fromPage?._id === sourcePageId);
      if (found) return true;
    }
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }
  return false;
}

/**
 * `GET /api/search?q=<token>` readiness polling (design judgement §1.3).
 * A 503 (`SEARCH_UNAVAILABLE`) short-circuits immediately — a new per-run DB
 * has no search backend configured by default, so this is the expected path
 * there, not a transient "still indexing" state worth retrying.
 * @param {{ proxyUrl: string, accessToken: string, query: string, pageId: string, intervalMs: number, maxAttempts: number }} params
 * @returns {Promise<{ shortCircuited: boolean, observed: boolean }>}
 */
export async function pollSearchObserved({ proxyUrl, accessToken, query, pageId, intervalMs, maxAttempts }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(`${proxyUrl}/api/search?q=${encodeURIComponent(query)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 503) {
      return { shortCircuited: true, observed: false };
    }
    if (response.ok) {
      const json = /** @type {{ data?: { pageId?: string }[] }} */ (await response.json());
      const found = (json.data ?? []).some((hit) => hit.pageId === pageId);
      if (found) return { shortCircuited: false, observed: true };
    }
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }
  return { shortCircuited: false, observed: false };
}

// ── fixture content (design judgement §4: kept inline for now — split into
// a `fixture-definitions.mjs` only if this grows unwieldy) ──

const TABLE_FIXTURE_BODY = `# QA Fixture: Table

Seeded by \`seed-fixtures.mjs\` for the table-display charter — open this
page directly, no editor input needed.

| Column A | Column B | Column C |
| --- | --- | --- |
| a1 | b1 | c1 |
| a2 | b2 | c2 |
| a3 | b3 | c3 |
`;

const GRANT_FIXTURE_BODY = `# QA Fixture: Grant Visibility

Seeded by \`seed-fixtures.mjs\` for the grant-visibility charter (single
identity: the seeding admin is both creator and owner of this page).
`;

const BACKLINK_TARGET_BODY = `# QA Fixture: Backlink Target

Seeded by \`seed-fixtures.mjs\`. A source page links to this page; backlink
registration only resolves links to pages that already exist at save time,
so this page must be created before the source page (see SKILL.md §6.4).
`;

/** @param {string} targetPath */
function backlinkSourceBody(targetPath) {
  return `# QA Fixture: Backlink Source

Seeded by \`seed-fixtures.mjs\`. Links to the target page with a markdown
link (bare \`[[wikilink]]\` syntax is reserved and does not resolve): see
[target](${targetPath}).
`;
}

/** @param {string} token */
function searchFixtureBody(token) {
  return `# QA Fixture: Search

Seeded by \`seed-fixtures.mjs\`. Unique search token: ${token}
`;
}

const COMMENT_FIXTURE_PAGE_BODY = `# QA Fixture: Comment Thread

Seeded by \`seed-fixtures.mjs\` for the comment charter. A fixture comment is
added to this page by the same run.
`;

const COMMENT_FIXTURE_TEXT = 'QA fixture comment (seeded by seed-fixtures.mjs).';

// ── charter implementations ──
// Each returns `{ resources, blocked?, query? }`. `resources` is always the
// manifest entries to append, even when `blocked` is set — fixtures already
// created stay created (design judgement §1.3: only the readiness check
// failed, not the page/comment creation).

/** @param {{ proxyUrl: string, runId: string, accessToken: string }} ctx */
async function seedTable({ proxyUrl, runId, accessToken }) {
  const created = await createPage({ proxyUrl, accessToken, path: `/qa/${runId}/table/display`, body: TABLE_FIXTURE_BODY });
  return { resources: [{ type: 'page', pageId: created.pageId, path: created.path, charter: 'table' }] };
}

/** @param {{ proxyUrl: string, runId: string, accessToken: string }} ctx */
async function seedGrant({ proxyUrl, runId, accessToken }) {
  const created = await createPage({ proxyUrl, accessToken, path: `/qa/${runId}/grant/visible`, body: GRANT_FIXTURE_BODY });
  return { resources: [{ type: 'page', pageId: created.pageId, path: created.path, charter: 'grant' }] };
}

/** @param {{ proxyUrl: string, runId: string, accessToken: string, pollIntervalMs: number, pollMaxAttempts: number }} ctx */
async function seedBacklink({ proxyUrl, runId, accessToken, pollIntervalMs, pollMaxAttempts }) {
  // Order matters (design judgement §1.2): target FIRST, source SECOND. A
  // reversed order means backlink registration never resolves the link and
  // the readiness poll below always times out.
  const target = await createPage({ proxyUrl, accessToken, path: `/qa/${runId}/backlink/target`, body: BACKLINK_TARGET_BODY });
  const source = await createPage({
    proxyUrl,
    accessToken,
    path: `/qa/${runId}/backlink/source`,
    body: backlinkSourceBody(target.path),
  });
  const resources = [
    { type: 'page', pageId: target.pageId, path: target.path, charter: 'backlink' },
    { type: 'page', pageId: source.pageId, path: source.path, charter: 'backlink' },
  ];
  const timeoutMs = pollIntervalMs * pollMaxAttempts;
  const observed = await pollBacklinkObserved({
    proxyUrl,
    accessToken,
    targetPageId: target.pageId,
    sourcePageId: source.pageId,
    intervalMs: pollIntervalMs,
    maxAttempts: pollMaxAttempts,
  });
  if (!observed) {
    return { resources, blocked: `blocked: backlink side effect not observed within ${timeoutMs}ms` };
  }
  return { resources };
}

/** @param {{ proxyUrl: string, runId: string, accessToken: string, pollIntervalMs: number, pollMaxAttempts: number }} ctx */
async function seedSearch({ proxyUrl, runId, accessToken, pollIntervalMs, pollMaxAttempts }) {
  const token = `qa-search-${runId}`;
  const created = await createPage({ proxyUrl, accessToken, path: `/qa/${runId}/search/target`, body: searchFixtureBody(token) });
  const resources = [{ type: 'page', pageId: created.pageId, path: created.path, charter: 'search' }];
  const timeoutMs = pollIntervalMs * pollMaxAttempts;
  const { shortCircuited, observed } = await pollSearchObserved({
    proxyUrl,
    accessToken,
    query: token,
    pageId: created.pageId,
    intervalMs: pollIntervalMs,
    maxAttempts: pollMaxAttempts,
  });
  if (shortCircuited) {
    return { resources, query: token, blocked: 'blocked: search backend unreachable (503)' };
  }
  if (!observed) {
    return { resources, query: token, blocked: `blocked: search index side effect not observed within ${timeoutMs}ms` };
  }
  return { resources, query: token };
}

/** @param {{ proxyUrl: string, runId: string, accessToken: string }} ctx */
async function seedComment({ proxyUrl, runId, accessToken }) {
  const created = await createPage({ proxyUrl, accessToken, path: `/qa/${runId}/comment/thread`, body: COMMENT_FIXTURE_PAGE_BODY });
  const revisionId = created.revisionId ?? (await getPageLatestRevisionId({ proxyUrl, accessToken, pageId: created.pageId }));
  const commentId = await addComment({ proxyUrl, accessToken, pageId: created.pageId, revisionId, comment: COMMENT_FIXTURE_TEXT });
  return {
    resources: [
      { type: 'page', pageId: created.pageId, path: created.path, charter: 'comment' },
      { type: 'comment', commentId, pageId: created.pageId, charter: 'comment' },
    ],
  };
}

const SEED_FNS = {
  table: seedTable,
  grant: seedGrant,
  backlink: seedBacklink,
  search: seedSearch,
  comment: seedComment,
};

// ── entrypoint ──

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const proxyUrl = args['proxy-url'].replace(/\/$/, '');
  const runId = args['run-id'];
  const charter = /** @type {(typeof CHARTERS)[number]} */ (args.charter);
  const manifestPath = args['manifest-path'];
  const pollIntervalMs = Number(args['poll-interval-ms'] ?? 300);
  const pollMaxAttempts = Number(args['poll-max-attempts'] ?? 10);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('--poll-interval-ms must be a positive integer');
  if (!Number.isInteger(pollMaxAttempts) || pollMaxAttempts <= 0) throw new Error('--poll-max-attempts must be a positive integer');

  const accessToken = await login({ proxyUrl, email: args.email, password: args.password });

  const seed = SEED_FNS[charter];
  const result = await seed({ proxyUrl, runId, accessToken, pollIntervalMs, pollMaxAttempts });

  appendManifest(manifestPath, result.resources);

  const output = {
    ok: result.blocked === undefined,
    charter,
    runId,
    resources: result.resources,
    ...(result.query !== undefined ? { query: result.query } : {}),
    ...(result.blocked !== undefined ? { blocked: result.blocked } : {}),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = result.blocked === undefined ? 0 : 1;
}

// Only auto-run when invoked directly (`node seed-fixtures.mjs ...`), not
// when imported for its pure helpers (e.g. from a future test file).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`seed-fixtures: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
