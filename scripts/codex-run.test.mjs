import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRAPPER = join(REPO_ROOT, '.claude/scripts/codex-run.sh');

/**
 * Run the wrapper with `codex` stubbed by `stubBody`, against a run directory
 * that already holds `existingOut` (the artifact a PREVIOUS invocation left
 * behind — callers key `--out` on a stable path, so this is the normal state,
 * not an exotic one).
 */
function runWithStub({ stubBody, existingOut }) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-run-test-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = join(bin, 'codex');
  writeFileSync(stub, stubBody);
  chmodSync(stub, 0o755);

  const out = join(dir, 'out.json');
  const promptFile = join(dir, 'prompt.md');
  const schemaFile = join(dir, 'schema.json');
  writeFileSync(promptFile, 'prompt\n');
  writeFileSync(schemaFile, '{"type":"object"}\n');
  if (existingOut !== undefined) writeFileSync(out, existingOut);

  let status = 0;
  try {
    execFileSync('bash', [WRAPPER, '--prompt-file', promptFile, '--schema-file', schemaFile, '--out', out, '--label', 'test'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: 'pipe',
    });
  } catch (err) {
    status = err.status ?? 1;
  }
  return { status, out: readFileSync(out, 'utf8') };
}

const EXIT_ZERO_WITHOUT_WRITING = '#!/usr/bin/env bash\nexit 0\n';

test('a previous run\'s output is never reported as this run\'s result', () => {
  // The regression: `succeeded` only checks that `$OUT` is non-empty and
  // parses, so before the fix a leftover artifact made an empty codex run look
  // like a fresh success — every review lens driven through this wrapper could
  // silently return the verdict of an earlier invocation.
  const stale = '{"verdict":"STALE_FROM_PREVIOUS_RUN"}\n';
  const { status, out } = runWithStub({ stubBody: EXIT_ZERO_WITHOUT_WRITING, existingOut: stale });

  assert.notEqual(status, 0, 'wrapper must not report success when codex wrote no output');
  assert.equal(status, 3, 'a run that produced no usable output is an invalid-output failure (exit 3)');
  assert.notEqual(out, stale, 'the stale artifact must not survive for the caller to read');
});

test('a run that writes valid output still succeeds', () => {
  // The fix truncates `$OUT` before every attempt; this pins that it truncates
  // before the run rather than after it.
  const stub = ['#!/usr/bin/env bash', 'while [ $# -gt 0 ]; do', '  if [ "$1" = "-o" ]; then printf \'{"verdict":"FRESH"}\' > "$2"; fi', '  shift', 'done', 'exit 0', ''].join('\n');
  const { status, out } = runWithStub({ stubBody: stub, existingOut: '{"verdict":"STALE_FROM_PREVIOUS_RUN"}\n' });

  assert.equal(status, 0);
  assert.equal(JSON.parse(out).verdict, 'FRESH');
});
