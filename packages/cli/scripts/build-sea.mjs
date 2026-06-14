#!/usr/bin/env node
/**
 * Build a single-file `crowi` executable using Node's native Single
 * Executable Application (SEA) support — no Bun / pkg / native toolchain
 * required beyond the Node that runs this script and `postject` (pulled via
 * `npx` on demand).
 *
 * Pipeline (per the Node SEA docs):
 *   1. tsup has already produced a self-contained CJS bundle at dist/bin.js.
 *   2. `node --experimental-sea-config sea-config.json` → dist/sea-prep.blob.
 *   3. copy the running `node` binary to dist/crowi.
 *   4. `postject` injects the blob into the copy under the NODE_SEA_BLOB fuse.
 *
 * This is best-effort: if `postject` cannot be fetched (offline CI) the script
 * exits non-zero with a clear message but leaves the prepared blob in place,
 * and callers may treat a missing binary as a soft failure. The browser-based
 * login flow (`open`) is unavailable inside the SEA bundle — use `crowi login
 * --device` from the single-file binary.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/build-sea.mjs → the package root is its parent directory.
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(pkgDir, 'dist');
// The standalone bundle produced by tsup.sea.config.ts (everything inlined
// except `open`), distinct from the externalised publish bundle dist/bin.js.
const bundle = join(distDir, 'bin.sea.js');
const blob = join(distDir, 'sea-prep.blob');
const outName = process.platform === 'win32' ? 'crowi.exe' : 'crowi';
const outBin = join(distDir, outName);

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: pkgDir, ...opts });
}

if (!existsSync(bundle)) {
  console.error(`build-sea: ${bundle} not found — run \`pnpm --filter @crowi/cli build:binary\` (which bundles it first).`);
  process.exit(1);
}

// 1. Generate the SEA preparation blob.
console.error('build-sea: generating SEA blob…');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

// 2. Copy the node binary and inject the blob.
console.error(`build-sea: copying node → ${outBin}`);
copyFileSync(process.execPath, outBin);
chmodSync(outBin, 0o755);

const sentinel = 'NODE_SEA_BLOB';
const postjectArgs = [outBin, sentinel, blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
// macOS requires the binary to be re-signed after injection.
if (process.platform === 'darwin') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}

try {
  console.error('build-sea: injecting blob via postject…');
  run('npx', ['--yes', 'postject', ...postjectArgs]);
} catch (err) {
  console.error(`build-sea: postject step failed (${err instanceof Error ? err.message : String(err)}).`);
  console.error('build-sea: the prepared blob is at dist/sea-prep.blob; install `postject` and re-run to finish.');
  process.exit(2);
}

if (process.platform === 'darwin') {
  try {
    run('codesign', ['--sign', '-', outBin]);
  } catch {
    console.error('build-sea: warning — could not re-sign the binary (codesign unavailable); it may not run on macOS.');
  }
}

console.error(`build-sea: done → ${outBin}`);
