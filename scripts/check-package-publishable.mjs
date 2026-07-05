#!/usr/bin/env node
// Guards that every publishable (non-private) workspace package declares the
// `repository` metadata that npm's provenance publish REQUIRES.
//
// Why this exists: the release publishes with `NPM_CONFIG_PROVENANCE=true`, and
// npm rejects a package whose `package.json` `repository.url` does not match the
// GitHub Actions source repo — with `E422 ... "repository.url" is ""`. Because
// `changeset publish` publishes package-by-package, a single offender aborts the
// run *mid-way*, leaving a partial release (some packages on npm, no Docker, no
// tags). This bit @crowi/plugin-slack on 2.0.0-alpha.4 — a brand-new package
// created without `repository`. New packages are exactly where this recurs, so
// fail fast on pre-push / CI instead of discovering it half-published.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_URL = 'https://github.com/crowi/crowi.git';
const ROOTS = ['packages', 'apps'];

const problems = [];

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (err) {
      problems.push(`${pkgPath}: unreadable package.json (${err.message})`);
      continue;
    }

    // Private packages are never published (Docker-image sources, the web app,
    // e2e), so npm provenance never touches them.
    if (pkg.private === true) continue;

    const repo = pkg.repository;
    if (!repo || typeof repo !== 'object' || repo.url !== REPO_URL) {
      problems.push(`${pkgPath}: repository.url must be "${REPO_URL}" (got ${JSON.stringify(repo?.url ?? null)})`);
    } else if (repo.directory !== dir) {
      problems.push(`${pkgPath}: repository.directory must be "${dir}" (got ${JSON.stringify(repo.directory ?? null)})`);
    }
  }
}

if (problems.length) {
  process.stderr.write('\n✗ Publishable packages are missing the npm-provenance repository metadata:\n\n');
  for (const p of problems) process.stderr.write(`    ${p}\n`);
  process.stderr.write('\n  A publish with provenance rejects these (E422), aborting the release mid-way.\n');
  process.stderr.write('  Add to each package.json (a private package can set "private": true instead):\n\n');
  process.stderr.write(`    "repository": { "type": "git", "url": "${REPO_URL}", "directory": "packages/<name>" }\n\n`);
  process.exit(1);
}

process.stdout.write('✓ All publishable packages declare repository metadata for provenance.\n');
