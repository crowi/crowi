// Unit tests for the pure decision/rendering helpers in
// scripts/test-flake-report-issue.mjs (feature-flake-report-triage-loop
// AC-1/AC-2/AC-3/AC-6). `main()` (gh spawns + report I/O) is glue, not
// covered by unit tests here — same untested-`main()` precedent as
// `test-flake-report-consume.mjs` / `test-flake-report-produce.mjs`. A small
// number of subprocess-level checks at the bottom exercise `main()` end to
// end for the no-`gh`-needed paths (no report / annotate mode), without
// requiring a real `gh` CLI or network access.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveClassificationReportPath } from './flake-report-shared.mjs'
import {
  buildCheckRunOutput,
  buildFlakeIssueBody,
  buildFlakeIssueTitle,
  buildFlakeOccurrenceComment,
  fenceSafeCodeBlock,
  planIssueActions,
  toRepoRelativeFilePath,
  truncateFailureMessage,
} from './test-flake-report-issue.mjs'

describe('buildFlakeIssueTitle', () => {
  it('prefixes the repo-relative path with "flake: "', () => {
    assert.equal(buildFlakeIssueTitle('packages/api/src/foo.test.ts'), 'flake: packages/api/src/foo.test.ts')
  })

  it('strips embedded newlines/carriage-returns instead of letting them corrupt the title', () => {
    assert.equal(buildFlakeIssueTitle('packages/api/src/foo.test.ts\n--title\nhijack'), 'flake: packages/api/src/foo.test.ts --title hijack')
  })

  it('trims surrounding whitespace', () => {
    assert.equal(buildFlakeIssueTitle('  packages/api/src/foo.test.ts  '), 'flake: packages/api/src/foo.test.ts')
  })
})

describe('toRepoRelativeFilePath', () => {
  it('converts an absolute jest test path (jest --json reports testResults[].name as absolute — AC-1) to a repo-relative, forward-slash path', () => {
    assert.equal(toRepoRelativeFilePath('/repo/packages/api/src/foo.test.ts', '/repo'), 'packages/api/src/foo.test.ts')
  })

  it('leaves an already-relative path unchanged (idempotent round trip)', () => {
    assert.equal(toRepoRelativeFilePath('packages/api/src/foo.test.ts', '/repo'), 'packages/api/src/foo.test.ts')
    const once = toRepoRelativeFilePath('/repo/packages/api/src/foo.test.ts', '/repo')
    assert.equal(toRepoRelativeFilePath(once, '/repo'), once)
  })

  it('handles empty/nullish input without throwing', () => {
    assert.equal(toRepoRelativeFilePath('', '/repo'), '')
    assert.equal(toRepoRelativeFilePath(null, '/repo'), '')
    assert.equal(toRepoRelativeFilePath(undefined, '/repo'), '')
  })
})

describe('truncateFailureMessage', () => {
  it('returns short text unchanged', () => {
    assert.equal(truncateFailureMessage('boom', 800), 'boom')
  })

  it('truncates text over the max and annotates the original code-point count', () => {
    const text = 'x'.repeat(850)
    const result = truncateFailureMessage(text, 800)
    assert.equal(result.startsWith('x'.repeat(800)), true)
    assert.match(result, /truncated, 850 code points total/)
  })

  it('defaults to an 800 code-point cap', () => {
    const text = 'y'.repeat(801)
    const result = truncateFailureMessage(text)
    assert.equal(Array.from(result.split('… ')[0]).length, 800)
  })

  it('counts astral (surrogate-pair) characters as ONE code point each, not two UTF-16 units', () => {
    const text = '😀😀😀'
    const result = truncateFailureMessage(text, 2)
    assert.equal(result.startsWith('😀😀'), true)
    assert.match(result, /truncated, 3 code points total/)
  })

  it('returns an empty string for non-string/empty input instead of throwing', () => {
    assert.equal(truncateFailureMessage(''), '')
    assert.equal(truncateFailureMessage(null), '')
    assert.equal(truncateFailureMessage(undefined), '')
  })
})

describe('fenceSafeCodeBlock', () => {
  it('uses a plain triple-backtick fence when the content has no backticks', () => {
    const result = fenceSafeCodeBlock('boom, expected true got false')
    assert.equal(result, '```\nboom, expected true got false\n```')
  })

  it('promotes to a 4-backtick fence when the content contains a triple-backtick run (e.g. an embedded fenced block)', () => {
    const content = 'before\n```\ninner code\n```\nafter'
    const result = fenceSafeCodeBlock(content)
    assert.equal(result.startsWith('````\n'), true)
    assert.equal(result.endsWith('\n````'), true)
  })

  it('promotes past the LONGEST backtick run in the content, not just the first one found', () => {
    const content = '``` then later `````` (six backticks)'
    const result = fenceSafeCodeBlock(content)
    assert.equal(result.startsWith('`'.repeat(7)), true)
  })
})

describe('buildFlakeIssueBody / buildFlakeOccurrenceComment', () => {
  const occurrence = {
    detectedAt: '2026-07-17T00:00:00.000Z',
    runUrl: 'https://github.com/crowi/crowi/actions/runs/123',
    ref: 'PR #42',
    firstFailureMessage: 'expected 1 to equal 2',
  }

  it('the new-issue body explains what FLAKY means and includes the first occurrence', () => {
    const body = buildFlakeIssueBody(occurrence)
    assert.match(body, /FLAKY means this test file failed/)
    assert.match(body, /passed a standalone solo-rerun/)
    assert.match(body, /- Detected: 2026-07-17T00:00:00\.000Z/)
    assert.match(body, /- Run: https:\/\/github\.com\/crowi\/crowi\/actions\/runs\/123/)
    assert.match(body, /- Ref: PR #42/)
    assert.match(body, /```\nexpected 1 to equal 2\n```/)
  })

  it('the occurrence comment does NOT repeat the FLAKY explanation (title/body of the issue are never rewritten)', () => {
    const comment = buildFlakeOccurrenceComment(occurrence)
    assert.equal(/FLAKY means this test file failed/.test(comment), false)
    assert.match(comment, /### New occurrence/)
    assert.match(comment, /- Ref: PR #42/)
  })

  it('truncates and fence-escapes a hostile firstFailureMessage before it reaches either rendering', () => {
    const hostile = { ...occurrence, firstFailureMessage: `\`\`\`\n${'z'.repeat(900)}` }
    const body = buildFlakeIssueBody(hostile)
    assert.match(body, /````\n/) // promoted past the embedded ``` run
    assert.match(body, /truncated, \d+ code points total/)
  })
})

describe('planIssueActions', () => {
  it('is a no-op when the report is missing', () => {
    assert.deepEqual(planIssueActions(null, [], 'file'), [])
  })

  it('is a no-op when the report status is not "classified"', () => {
    const report = { status: 'source-unavailable', counts: { FLAKY: 0 }, files: [] }
    assert.deepEqual(planIssueActions(report, [], 'file'), [])
  })

  it('is a no-op when there are zero FLAKY files, even if REGRESSION/INCONCLUSIVE files are present', () => {
    const report = {
      status: 'classified',
      files: [
        { file: 'a.test.ts', classification: 'REGRESSION' },
        { file: 'b.test.ts', classification: 'INCONCLUSIVE' },
      ],
    }
    assert.deepEqual(planIssueActions(report, [], 'file'), [])
  })

  it('plans create-issue for a FLAKY file with no matching open issue, carrying its firstFailureMessage', () => {
    const report = { status: 'classified', files: [{ file: 'a.test.ts', classification: 'FLAKY', firstFailureMessage: 'boom' }] }
    const actions = planIssueActions(report, [], 'file')
    assert.deepEqual(actions, [{ type: 'create-issue', file: 'a.test.ts', title: 'flake: a.test.ts', firstFailureMessage: 'boom' }])
  })

  it('defaults a missing firstFailureMessage to an empty string rather than leaving it undefined on the action', () => {
    const report = { status: 'classified', files: [{ file: 'a.test.ts', classification: 'FLAKY' }] }
    const actions = planIssueActions(report, [], 'file')
    assert.equal(actions[0].firstFailureMessage, '')
  })

  it('AC-1: normalizes an absolute jest test path (as jest --json reports it) to a repo-relative dedup title/file, given an explicit repoRoot', () => {
    const report = { status: 'classified', files: [{ file: '/repo/packages/api/src/foo.test.ts', classification: 'FLAKY', firstFailureMessage: 'boom' }] }
    const actions = planIssueActions(report, [], 'file', '/repo')
    assert.deepEqual(actions, [
      { type: 'create-issue', file: 'packages/api/src/foo.test.ts', title: 'flake: packages/api/src/foo.test.ts', firstFailureMessage: 'boom' },
    ])
  })

  it('AC-1: dedup matches an absolute-path FLAKY entry against an open issue whose title already uses the repo-relative form', () => {
    const report = { status: 'classified', files: [{ file: '/repo/packages/api/src/foo.test.ts', classification: 'FLAKY' }] }
    const openIssues = [{ number: 9, title: 'flake: packages/api/src/foo.test.ts' }]
    const actions = planIssueActions(report, openIssues, 'file', '/repo')
    assert.deepEqual(actions, [
      { type: 'add-comment', file: 'packages/api/src/foo.test.ts', title: 'flake: packages/api/src/foo.test.ts', issueNumber: 9, firstFailureMessage: '' },
    ])
  })

  it('plans add-comment (not a new issue) when an open issue with the exact dedup title already exists', () => {
    const report = { status: 'classified', files: [{ file: 'a.test.ts', classification: 'FLAKY' }] }
    const openIssues = [{ number: 7, title: 'flake: a.test.ts' }]
    const actions = planIssueActions(report, openIssues, 'file')
    assert.deepEqual(actions, [{ type: 'add-comment', file: 'a.test.ts', title: 'flake: a.test.ts', issueNumber: 7, firstFailureMessage: '' }])
  })

  it('a title that only partially matches (e.g. a renamed/closed issue not in the open set) still creates a new issue rather than reopening', () => {
    const report = { status: 'classified', files: [{ file: 'a.test.ts', classification: 'FLAKY' }] }
    const openIssues = [{ number: 5, title: 'flake: a.test.ts (old, now closed and re-titled by a human)' }]
    const actions = planIssueActions(report, openIssues, 'file')
    assert.deepEqual(actions, [{ type: 'create-issue', file: 'a.test.ts', title: 'flake: a.test.ts', firstFailureMessage: '' }])
  })

  it('filters REGRESSION/INCONCLUSIVE files out and only plans actions for the FLAKY ones, preserving file order', () => {
    const report = {
      status: 'classified',
      files: [
        { file: 'a.test.ts', classification: 'FLAKY' },
        { file: 'b.test.ts', classification: 'REGRESSION' },
        { file: 'c.test.ts', classification: 'FLAKY' },
      ],
    }
    const actions = planIssueActions(report, [], 'file')
    assert.deepEqual(
      actions.map((a) => a.file),
      ['a.test.ts', 'c.test.ts'],
    )
  })

  it('annotate mode returns a single "annotate" action listing every FLAKY file, ignoring openIssues entirely', () => {
    const report = {
      status: 'classified',
      files: [
        { file: 'a.test.ts', classification: 'FLAKY' },
        { file: 'b.test.ts', classification: 'REGRESSION' },
        { file: 'c.test.ts', classification: 'FLAKY' },
      ],
    }
    const actions = planIssueActions(report, [{ number: 1, title: 'flake: a.test.ts' }], 'annotate')
    assert.deepEqual(actions, [{ type: 'annotate', files: ['a.test.ts', 'c.test.ts'] }])
  })
})

describe('buildCheckRunOutput', () => {
  it('AC-9: titles the neutral check-run with the FLAKY count', () => {
    assert.equal(buildCheckRunOutput(3).title, 'flake-report: 3 FLAKY')
  })

  it('points the summary at the artifact and the filed issues rather than restating the failure', () => {
    const { summary } = buildCheckRunOutput(1)
    assert.match(summary, /1 FLAKY/)
    assert.match(summary, /flake-report-classification artifact/)
    assert.match(summary, /flaky-test issue/)
  })
})

describe('main() end-to-end via subprocess', () => {
  const scriptPath = fileURLToPath(new URL('./test-flake-report-issue.mjs', import.meta.url))
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))

  /** The one-FLAKY-file report every test below drives `main()` with — kept in one place so a report-shape change is one edit, not one per test. */
  const FLAKY_REPORT = {
    status: 'classified',
    counts: { FLAKY: 1, REGRESSION: 0, INCONCLUSIVE: 0 },
    files: [{ file: 'packages/api/src/foo.test.ts', classification: 'FLAKY', firstFailureMessage: 'boom' }],
  }

  /** Writes `FLAKY_REPORT` at the run-scoped path `main()` resolves from `CROWI_TEST_RUN_ID`, runs `fn({ runId, reportPath })`, and always removes it again. */
  function withFlakyReport(label, fn) {
    const runId = `test-issue-${label}-${process.pid}-${Date.now().toString(36)}`
    const reportPath = resolveClassificationReportPath(runId)
    writeFileSync(reportPath, JSON.stringify(FLAKY_REPORT))
    try {
      return fn({ runId, reportPath })
    } finally {
      rmSync(reportPath, { force: true })
    }
  }

  it('no-ops (exit 0, log only) when no classification report exists for the given run id', () => {
    const runId = `test-issue-noreport-${process.pid}-${Date.now().toString(36)}`
    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, CROWI_TEST_RUN_ID: runId, CROWI_FLAKE_ISSUE_MODE: 'file' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /no-op: no classification report found/)
  })

  it('emits a ::notice:: annotation (no gh call) in annotate mode when the report has FLAKY files', () => {
    withFlakyReport('annotate', ({ runId }) => {
      const result = spawnSync('node', [scriptPath], {
        cwd: repoRoot,
        env: { ...process.env, CROWI_TEST_RUN_ID: runId, CROWI_FLAKE_ISSUE_MODE: 'annotate' },
        encoding: 'utf8',
      })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /::notice::flake-report: 1 FLAKY — packages\/api\/src\/foo\.test\.ts/)
    })
  })

  it('AC-4 fail-open: still exits 0 (and logs, never throws) when every `gh` call fails', () => {
    // A fake `gh` on PATH that always fails — stands in for "gh is present but
    // every call errors" (auth expired, rate-limited, network blip, ...).
    // `isGhAvailable()` only checks `gh --version` succeeds and is NOT
    // stubbed to fail, so this exercises the create/comment failure paths
    // specifically, not the separate "gh missing entirely" no-op path.
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'crowi-flake-issue-fail-test-'))
    const fakeBinDir = path.join(scratchDir, 'bin')
    mkdirSync(fakeBinDir)
    const fakeGhPath = path.join(fakeBinDir, 'gh')
    writeFileSync(fakeGhPath, '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\n[ "$1" = "issue" ] && [ "$2" = "list" ] && echo "[]" && exit 0\nexit 1\n')
    chmodSync(fakeGhPath, 0o755)

    try {
      withFlakyReport('ghfail', ({ runId }) => {
        const result = spawnSync('node', [scriptPath], {
          cwd: repoRoot,
          env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, CROWI_TEST_RUN_ID: runId, CROWI_FLAKE_ISSUE_MODE: 'file', GITHUB_REPOSITORY: 'crowi/crowi' },
          encoding: 'utf8',
        })
        assert.equal(result.status, 0, `expected exit 0 even though every gh call failed (stderr: ${result.stderr})`)
        assert.match(result.stderr, /could not file an issue/)
      })
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('no-ops (exit 0, log only) in file mode when `gh` is genuinely absent from PATH (not just failing)', () => {
    // Distinct from the "every gh call fails" case above: here `gh` cannot be
    // resolved on PATH at all, so `isGhAvailable()`'s `gh --version` spawn
    // itself gets ENOENT. PATH is narrowed to just node's own directory
    // (rather than blanked) so the outer `spawnSync('node', ...)` can still
    // resolve `node` itself.
    withFlakyReport('nogh', ({ runId }) => {
      const result = spawnSync('node', [scriptPath], {
        cwd: repoRoot,
        env: { ...process.env, PATH: path.dirname(process.execPath), CROWI_TEST_RUN_ID: runId, CROWI_FLAKE_ISSUE_MODE: 'file', GITHUB_REPOSITORY: 'crowi/crowi' },
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, `expected exit 0 (stderr: ${result.stderr})`)
      assert.match(result.stdout, /no-op: gh CLI not found on PATH/)
    })
  })

  /**
   * Shared harness for the three "the open `flaky-test` issue set cannot be
   * trusted" regression tests below (a non-zero exit, AND the two malformed-
   * output shapes that exit 0 but can't be parsed/trusted — distinct code
   * paths through `fetchOpenFlakyIssues`'s `result.status !== 0` guard vs. its
   * `JSON.parse`/`Array.isArray` guard). All three must resolve to the exact
   * same outcome: no-op with the "could not confirm" message, and NO `gh
   * issue create` call ever made (verified via the call log, since a `gh`
   * that DID reach the create step would still exit 0 here and silently pass
   * without it).
   */
  function assertSkipsFilingWhenOpenIssueListCannotBeTrusted({ listExitCode = 0, listStdout = '' } = {}) {
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'crowi-flake-issue-untrusted-list-test-'))
    const fakeBinDir = path.join(scratchDir, 'bin')
    mkdirSync(fakeBinDir)
    const callLogPath = path.join(scratchDir, 'calls.log')
    const fakeGhPath = path.join(fakeBinDir, 'gh')
    writeFileSync(
      fakeGhPath,
      `#!/bin/sh\necho "$@" >> "${callLogPath}"\n[ "$1" = "--version" ] && exit 0\nif [ "$1" = "issue" ] && [ "$2" = "list" ]; then\n  cat <<'GHOUT'\n${listStdout}\nGHOUT\n  exit ${listExitCode}\nfi\nexit 0\n`,
    )
    chmodSync(fakeGhPath, 0o755)

    try {
      withFlakyReport('untrusted-list', ({ runId }) => {
        const result = spawnSync('node', [scriptPath], {
          cwd: repoRoot,
          env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, CROWI_TEST_RUN_ID: runId, CROWI_FLAKE_ISSUE_MODE: 'file', GITHUB_REPOSITORY: 'crowi/crowi' },
          encoding: 'utf8',
        })
        assert.equal(result.status, 0, `expected exit 0 even though the open flaky-test issue set could not be trusted (stderr: ${result.stderr})`)
        assert.match(result.stdout, /no-op: could not confirm the open flaky-test issue set/)
        const calls = existsSync(callLogPath) ? readFileSync(callLogPath, 'utf8') : ''
        assert.equal(/^issue create/m.test(calls), false, `expected no "gh issue create" call, got calls:\n${calls}`)
      })
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  }

  it('AC-1 dedup safety: skips filing entirely (no `gh issue create` call) when `gh issue list` itself fails, instead of treating the failure as zero open issues and creating a duplicate', () => {
    assertSkipsFilingWhenOpenIssueListCannotBeTrusted({ listExitCode: 1 })
  })

  it('AC-1 dedup safety: skips filing entirely when `gh issue list` exits 0 but prints a non-array JSON value (unexpected shape, not a spawn/API failure)', () => {
    assertSkipsFilingWhenOpenIssueListCannotBeTrusted({ listStdout: '{"unexpected":"shape"}' })
  })

  it('AC-1 dedup safety: skips filing entirely when `gh issue list` exits 0 but prints truncated/invalid JSON (e.g. an interrupted write)', () => {
    assertSkipsFilingWhenOpenIssueListCannotBeTrusted({ listStdout: '[{"number":1,"title":"flake: a.test.ts"' })
  })
})
