#!/usr/bin/env node
// Guards against the committed OpenAPI artifacts drifting from the
// `@hono/zod-openapi` contracts they are generated from.
//
// The web client uses `hc<AppType>` (types straight from the contracts, no
// spec involved), so this drift is invisible day-to-day — but the published
// `openapi.{json,yaml}` / `src/generated/openapi.ts` are the source of truth
// for non-TS clients (mobile, future CLIs) generated via openapi-generator.
// A stale spec there means those clients silently target the wrong API.
//
// Runs on pre-push (before CI): regenerate, then fail if the tracked
// artifacts changed. Leaves the regenerated files in the working tree so the
// fix is just `git add` + `git commit`.

import { execFileSync } from 'node:child_process';

const ARTIFACTS = [
  'packages/api-contract/openapi.json',
  'packages/api-contract/openapi.yaml',
  'packages/api-contract/src/generated/openapi.ts',
];

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8' });

try {
  run('pnpm', ['--filter', '@crowi/api-contract', 'generate']);
} catch (err) {
  process.stderr.write('\n✗ Failed to regenerate the OpenAPI artifacts.\n');
  process.stderr.write(`${err.stdout ?? ''}${err.stderr ?? ''}\n`);
  process.exit(1);
}

const dirty = run('git', ['status', '--porcelain', '--', ...ARTIFACTS]).trim();

if (dirty) {
  process.stderr.write('\n✗ OpenAPI artifacts are out of date with the contracts.\n\n');
  process.stderr.write('  The following generated files changed after regeneration:\n');
  for (const line of dirty.split('\n')) process.stderr.write(`    ${line.trim()}\n`);
  process.stderr.write('\n  They have been regenerated in your working tree. To fix:\n');
  process.stderr.write(`    git add ${ARTIFACTS.join(' ')}\n`);
  process.stderr.write('    git commit --no-verify -m "chore(api-contract): regenerate OpenAPI artifacts"\n\n');
  process.exit(1);
}

process.stdout.write('✓ OpenAPI artifacts are in sync with the contracts.\n');
