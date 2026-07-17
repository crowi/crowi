#!/usr/bin/env node
// CI `flake-report` job (feature-flake-report-triage-loop): runs as the
// independent step AFTER "Classify + report" (`test-flake-report-consume.mjs`)
// and turns a `classified` report with FLAKY≥1 into something a human/manager
// actually sees — the classify step itself is non-blocking (`continue-on-error:
// true`) and its artifact/summary was going unread (see PR #915's postmortem:
// FLAKY was correctly detected but nobody looked). This script never touches
// classification logic — it only reads the report `resolveClassificationReportPath`
// already wrote and, per FLAKY file, files/updates a GitHub issue (or, on a
// fork PR where `GITHUB_TOKEN` is read-only, degrades to a `::notice::`
// workflow annotation instead).
//
// dedup key = the FLAKY test file's `flake: <repo-relative path>` title, exact
// match, scoped to open issues labeled `flaky-test` (search API is fuzzy, so
// this fetches the open+labeled set once via `gh issue list` and compares
// titles in code — see `planIssueActions`). A closed issue is never reopened
// (a human closed it on purpose); a fresh occurrence of the same file re-files
// a NEW issue instead (out-of-scope note in the spec — history still reachable
// via label + title search).
//
// Same shape as the rest of this pipeline: decision/rendering logic is pure,
// exported, and unit-tested (`test-flake-report-issue.test.mjs`); `main()` is
// `gh` spawn + report I/O glue, untested (same precedent as
// `test-flake-report-consume.mjs` / `test-flake-report-produce.mjs`). Fail-open
// end to end — `main()`'s try/catch always resolves to `process.exitCode = 0`,
// and `.github/workflows/ci.yml`'s step additionally sets `if: always()` +
// `continue-on-error: true` (belt-and-suspenders, matching every other step in
// this non-blocking job).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveClassificationReportPath } from './flake-report-shared.mjs'

const FLAKY_LABEL = 'flaky-test'
// `gh issue list`'s own default limit is 30 — an explicit limit avoids
// silently missing older open `flaky-test` issues once the backlog grows past
// that (flagged as an open question during planning; picking a generous but
// bounded value here rather than `--paginate`, since a single classify run
// only ever needs to dedup against issues that could plausibly still be open).
const OPEN_ISSUE_LIST_LIMIT = 200

// ── pure decision / rendering functions (unit-tested) ──

/** Strips embedded newlines/carriage-returns and surrounding whitespace, collapsing to one line — shared by the issue title and the `::notice::` annotation's file list, both of which are a single GitHub Actions/CLI argument that a raw newline would corrupt (`gh issue create --title`'s value, or the workflow-command annotation itself). */
function sanitizeSingleLine(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

/**
 * Converts a test file path as recorded in the classification report to a
 * repo-relative, forward-slash path (AC-1's `flake: <repo-relative path>`
 * dedup title). Jest's `--json --outputFile` records `testResults[].name` as
 * an ABSOLUTE path (`flake-report-shared.mjs`'s `selectNonPassedTestFiles`
 * passes that straight through as `entry.file`), so without this the issue
 * title would leak the CI runner's absolute filesystem path instead of the
 * stable, human-recognizable repo path. Idempotent for a path that is
 * ALREADY relative (resolves it against `repoRoot` first, then re-relativizes
 * — a no-op round trip), so callers never need to know which shape they have.
 * Pure — `path.relative`/`path.resolve` are path arithmetic, no filesystem
 * access.
 */
export function toRepoRelativeFilePath(filePath, repoRoot) {
  const raw = String(filePath ?? '')
  if (!raw) return raw
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw)
  return path.relative(repoRoot, absolute).split(path.sep).join('/')
}

/** `flake: <repo-relative path>` — the exact-match dedup title. Newlines are stripped (a jest file name is never legitimately multi-line; a stray one would corrupt `gh issue create --title`). */
export function buildFlakeIssueTitle(filePath) {
  return `flake: ${sanitizeSingleLine(filePath)}`
}

/** Caps `text` at `maxCodePoints` Unicode code points (not UTF-16 code units — a surrogate-pair emoji must count as one), annotating the cut with the original length. `firstFailureMessage` is untrusted free text from jest, so this is applied before it ever reaches an issue body/comment. */
export function truncateFailureMessage(text, maxCodePoints = 800) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const codePoints = Array.from(text)
  if (codePoints.length <= maxCodePoints) return text
  return `${codePoints.slice(0, maxCodePoints).join('')}… (truncated, ${codePoints.length} code points total)`
}

/**
 * Wraps `text` in a backtick fence long enough that no run of backticks
 * already inside `text` can prematurely close it (CommonMark: a fenced code
 * block's closing fence must be at least as long as the opening one, and a
 * shorter backtick run inside the content is just content) — "promote the
 * fence" rather than escaping, since `firstFailureMessage` can itself contain
 * markdown/code fences (a jest diff, another triple-backtick block, etc.).
 */
export function fenceSafeCodeBlock(text) {
  const backtickRuns = text.match(/`+/g) ?? []
  const longestRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}\n${text}\n${fence}`
}

function formatOccurrence({ detectedAt, runUrl, ref, firstFailureMessage }) {
  const excerpt = truncateFailureMessage(firstFailureMessage || '(no failure message captured)')
  return [`- Detected: ${detectedAt}`, `- Run: ${runUrl}`, `- Ref: ${ref}`, '', 'First failure excerpt:', '', fenceSafeCodeBlock(excerpt)].join('\n')
}

const FLAKY_EXPLANATION =
  'FLAKY means this test file failed in the gating `test` job run but passed a standalone solo-rerun on the exact same commit ' +
  '(see `scripts/test-flake-report-consume.mjs`). Each run that reproduces this records a `crowi-flake-report-classification.<runId>.json` ' +
  'artifact with the full classification.'

/** Body for a brand-new issue: the one-line FLAKY explanation + the first occurrence. Never used to overwrite an existing issue's body (`planIssueActions` only ever pairs this with a `create-issue` action). */
export function buildFlakeIssueBody(occurrence) {
  return [FLAKY_EXPLANATION, '', '## Occurrences', '', formatOccurrence(occurrence)].join('\n')
}

/** Occurrence-only comment appended to an existing open issue — title/body of the issue itself are never touched. */
export function buildFlakeOccurrenceComment(occurrence) {
  return ['### New occurrence', '', formatOccurrence(occurrence)].join('\n')
}

function findOpenIssueByTitle(openIssues, title) {
  return (Array.isArray(openIssues) ? openIssues : []).find((issue) => issue && issue.title === title) ?? null
}

/**
 * Decides what to do with a `classified` report (AC-1/AC-2): no-op (`[]`)
 * unless `report.status === 'classified'` AND at least one file is `FLAKY`
 * (REGRESSION/INCONCLUSIVE are never filed — REGRESSION already shows up as a
 * red `test` job through the existing path). Every FLAKY file's `file` is
 * first run through `toRepoRelativeFilePath` (jest reports it as an absolute
 * path — AC-1 requires the repo-relative form in the dedup title/annotation)
 * and `sanitizeSingleLine`, so every action returned here already carries the
 * normalized `file`. In `annotate` mode (fork PR — the default `GITHUB_TOKEN`
 * there is read-only) this returns a SINGLE `annotate` action listing every
 * FLAKY file instead of filing anything. In `file` mode, each FLAKY file
 * becomes either `create-issue` (no open `flaky-test` issue with the exact
 * dedup title) or `add-comment` (one already exists — occurrence-only,
 * title/body untouched); a CLOSED issue with a matching title is deliberately
 * invisible here (`openIssues` is expected to already be `--state open`
 * filtered by the caller), so it always resolves to a fresh `create-issue`
 * instead of reopening anything. `repoRoot` defaults to `process.cwd()` (only
 * exercised when the caller omits it — every path in this repo's own unit
 * tests is already relative, so the default's exact value never changes
 * their expected output; `main()` always passes an explicit, deterministic
 * `repoRoot`).
 */
export function planIssueActions(report, openIssues, mode, repoRoot = process.cwd()) {
  if (!report || typeof report !== 'object' || report.status !== 'classified') return []
  const flakyFiles = Array.isArray(report.files) ? report.files.filter((entry) => entry && entry.classification === 'FLAKY') : []
  if (flakyFiles.length === 0) return []

  const normalizedFiles = flakyFiles.map((entry) => ({ ...entry, file: sanitizeSingleLine(toRepoRelativeFilePath(entry.file, repoRoot)) }))

  if (mode === 'annotate') {
    return [{ type: 'annotate', files: normalizedFiles.map((entry) => entry.file) }]
  }

  return normalizedFiles.map((entry) => {
    const title = buildFlakeIssueTitle(entry.file)
    const existingIssue = findOpenIssueByTitle(openIssues, title)
    return existingIssue
      ? { type: 'add-comment', file: entry.file, title, issueNumber: existingIssue.number }
      : { type: 'create-issue', file: entry.file, title }
  })
}

// ── glue (gh spawns + report I/O — not covered by unit tests, same
// untested-`main()` precedent as test-flake-report-consume.mjs) ──

function readClassificationReport(runId) {
  if (!runId || !runId.trim()) return null
  const reportPath = resolveClassificationReportPath(runId)
  if (!existsSync(reportPath)) return null
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (err) {
    process.stderr.write(`[flake-report-issue] could not parse the classification report at ${reportPath}: ${err.message}\n`)
    return null
  }
}

function isGhAvailable() {
  const result = spawnSync('gh', ['--version'], { encoding: 'utf8' })
  return !(result.error && result.error.code === 'ENOENT')
}

/** `['--repo', repo]`, or `[]` when `repo` is falsy — shared by every `gh` spawn below that targets a specific repo. */
function repoArgs(repo) {
  return repo ? ['--repo', repo] : []
}

/** Best-effort human-readable reason for a failed `spawnSync(...)` result: prefers captured stderr, falls back to the spawn error's own message, then a placeholder. */
function spawnFailureDetail(result) {
  return result.stderr || result.error?.message || '(no detail)'
}

/**
 * `{ ok: true, issues }` on a confirmed, parsed open-issue set, or
 * `{ ok: false, issues: [] }` when the list itself could not be trusted
 * (spawn/API failure, unparseable/wrong-shaped output). Callers MUST treat
 * `ok: false` as "cannot currently confirm dedup state" and skip filing
 * ENTIRELY for this run, not silently fall back to "zero open issues" — a
 * transient `gh issue list` failure (rate limit, network blip) coerced to an
 * empty array would make every already-open `flaky-test` issue look
 * dedup-unmatched and file a duplicate on top of it, defeating AC-1's
 * dedup guarantee.
 */
function fetchOpenFlakyIssues(repo) {
  if (!repo) return { ok: false, issues: [], reason: 'GITHUB_REPOSITORY is unset' }
  const result = spawnSync(
    'gh',
    ['issue', 'list', '--repo', repo, '--label', FLAKY_LABEL, '--state', 'open', '--json', 'number,title', '--limit', String(OPEN_ISSUE_LIST_LIMIT)],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    return { ok: false, issues: [], reason: `gh issue list failed: ${spawnFailureDetail(result)}` }
  }
  try {
    const parsed = JSON.parse(result.stdout)
    if (!Array.isArray(parsed)) return { ok: false, issues: [], reason: 'gh issue list did not return a JSON array' }
    return { ok: true, issues: parsed, reason: null }
  } catch (err) {
    return { ok: false, issues: [], reason: `could not parse gh issue list output: ${err.message}` }
  }
}

function ensureFlakyLabel() {
  // Best-effort only: `gh label create` fails when the label already exists
  // (the expected common case after the first run) — that failure is
  // swallowed here on purpose, the create/comment calls below are what
  // actually determine success.
  spawnSync(
    'gh',
    ['label', 'create', FLAKY_LABEL, '--color', 'e99695', '--description', 'A test file the flake-report pipeline classified as FLAKY (failed under load, passed standalone).'],
    { encoding: 'utf8' },
  )
}

function createFlakeIssue(repo, title, body) {
  const args = repoArgs(repo)
  const withLabel = spawnSync('gh', ['issue', 'create', ...args, '--title', title, '--body', body, '--label', FLAKY_LABEL], { encoding: 'utf8' })
  if (withLabel.status === 0) return { ok: true }
  process.stderr.write(`[flake-report-issue] gh issue create with label "${FLAKY_LABEL}" failed, retrying without a label: ${spawnFailureDetail(withLabel)}\n`)
  const withoutLabel = spawnSync('gh', ['issue', 'create', ...args, '--title', title, '--body', body], { encoding: 'utf8' })
  if (withoutLabel.status === 0) return { ok: true }
  return { ok: false, reason: spawnFailureDetail(withoutLabel) }
}

function addFlakeOccurrenceComment(repo, issueNumber, body) {
  const result = spawnSync('gh', ['issue', 'comment', ...repoArgs(repo), String(issueNumber), '--body', body], { encoding: 'utf8' })
  if (result.status === 0) return { ok: true }
  return { ok: false, reason: spawnFailureDetail(result) }
}

function emitAnnotation(files) {
  console.log(`::notice::flake-report: ${files.length} FLAKY — ${files.join(', ')}`)
}

function buildOccurrenceFromEnv(entry) {
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  const runId = process.env.GITHUB_RUN_ID ?? ''
  return {
    detectedAt: new Date().toISOString(),
    runUrl: `${serverUrl}/${repo}/actions/runs/${runId}`,
    ref: process.env.CROWI_FLAKE_REF_LABEL ?? '(unknown ref)',
    firstFailureMessage: entry.firstFailureMessage ?? '',
  }
}

function main() {
  const runId = process.env.CROWI_TEST_RUN_ID
  const mode = process.env.CROWI_FLAKE_ISSUE_MODE === 'file' ? 'file' : 'annotate'

  const report = readClassificationReport(runId)
  if (!report) {
    console.log(`[flake-report-issue] no-op: no classification report found for run ${runId ?? '(unset)'}`)
    return
  }
  if (report.status !== 'classified') {
    console.log(`[flake-report-issue] no-op: report status is "${report.status}", not "classified"`)
    return
  }
  if ((report.counts?.FLAKY ?? 0) < 1) {
    console.log('[flake-report-issue] no-op: zero FLAKY files in this report')
    return
  }

  if (mode === 'file' && !isGhAvailable()) {
    console.log('[flake-report-issue] no-op: gh CLI not found on PATH')
    return
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  let openIssues = []
  if (mode === 'file') {
    const fetched = fetchOpenFlakyIssues(repo)
    if (!fetched.ok) {
      // Cannot confirm the open `flaky-test` issue set — skip filing
      // ENTIRELY rather than risk a duplicate (see `fetchOpenFlakyIssues`'s
      // doc comment; AC-1 dedup safety).
      console.log(`[flake-report-issue] no-op: could not confirm the open flaky-test issue set, skipping to avoid filing a duplicate (${fetched.reason})`)
      return
    }
    openIssues = fetched.issues
  }
  const actions = planIssueActions(report, openIssues, mode, repoRoot)
  if (actions.length === 0) {
    console.log('[flake-report-issue] no-op: planIssueActions produced no actions')
    return
  }

  if (mode === 'annotate') {
    emitAnnotation(actions[0].files)
    return
  }

  const filesByPath = new Map((report.files ?? []).map((entry) => [sanitizeSingleLine(toRepoRelativeFilePath(entry.file, repoRoot)), entry]))
  let labelEnsured = false
  for (const action of actions) {
    const entry = filesByPath.get(action.file) ?? {}
    const occurrence = buildOccurrenceFromEnv(entry)
    if (action.type === 'create-issue') {
      if (!labelEnsured) {
        ensureFlakyLabel()
        labelEnsured = true
      }
      const result = createFlakeIssue(repo, action.title, buildFlakeIssueBody(occurrence))
      if (result.ok) {
        console.log(`[flake-report-issue] filed a new issue for ${action.file}`)
      } else {
        process.stderr.write(`[flake-report-issue] could not file an issue for ${action.file}: ${result.reason}\n`)
      }
    } else if (action.type === 'add-comment') {
      const result = addFlakeOccurrenceComment(repo, action.issueNumber, buildFlakeOccurrenceComment(occurrence))
      if (result.ok) {
        console.log(`[flake-report-issue] recorded a new occurrence on #${action.issueNumber} for ${action.file}`)
      } else {
        process.stderr.write(`[flake-report-issue] could not comment on #${action.issueNumber} for ${action.file}: ${result.reason}\n`)
      }
    }
  }
}

// `import.meta.main` is Node 24+ (this repo's `engines.node`), same as
// `test-flake-report-consume.mjs` / `test-flake-report-produce.mjs`.
if (import.meta.main) {
  try {
    main()
  } catch (err) {
    // Fail-open, matching every other step in this non-blocking job —
    // `.github/workflows/ci.yml`'s step also sets `continue-on-error: true`.
    process.stderr.write(`[flake-report-issue] unexpected error (fail-open, no-op): ${err.stack ?? err.message}\n`)
  }
  process.exitCode = 0
}
