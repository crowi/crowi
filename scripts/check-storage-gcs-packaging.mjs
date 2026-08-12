#!/usr/bin/env node
// Guards that `@crowi/plugin-storage-gcs` is actually wired into the full
// runner the way `@crowi/runner` resolves plugins at boot — `createRequire`
// from the runner projectDir's own `package.json`, NOT this script's — and
// that bundling it does not flip the active `storage.driver` (see
// feature-storage-gcs spec, "やること": "既存 runner の active driver は `s3`
// のまま維持し、明示的に `storage.driver: \"gcs\"` へ変更した環境だけが利用する").
//
// `pnpm check:packages` already checks generic publishability (repository
// metadata etc.) for every workspace package; this script only checks the
// GCS-specific runner wiring.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = '@crowi/plugin-storage-gcs';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_DIR = join(REPO_ROOT, 'apps', 'crowi-runner');
const RUNNER_PACKAGE_JSON = join(RUNNER_DIR, 'package.json');
const RUNNER_CONFIG_JSON = join(RUNNER_DIR, 'crowi.config.json');

function main() {
  const problems = [];

  if (!existsSync(RUNNER_PACKAGE_JSON)) {
    problems.push(`${RUNNER_PACKAGE_JSON}: not found`);
  } else {
    // Mirrors how `@crowi/runner` actually loads plugins: `createRequire`
    // anchored at the runner projectDir's own `package.json`, so resolution
    // follows the RUNNER's `node_modules`, not this script's.
    const runnerRequire = createRequire(RUNNER_PACKAGE_JSON);
    try {
      runnerRequire.resolve(PLUGIN_NAME);
    } catch (err) {
      problems.push(
        `${PLUGIN_NAME} does not resolve from the runner projectDir (${RUNNER_DIR}): ${err instanceof Error ? err.message : String(err)}\n` +
          '    Run "pnpm install && pnpm --filter @crowi/plugin-storage-gcs build" and retry.',
      );
    }

    let runnerPackage;
    try {
      runnerPackage = JSON.parse(readFileSync(RUNNER_PACKAGE_JSON, 'utf8'));
    } catch (err) {
      problems.push(`${RUNNER_PACKAGE_JSON}: unreadable package.json (${err instanceof Error ? err.message : String(err)})`);
    }
    if (runnerPackage && !runnerPackage.dependencies?.[PLUGIN_NAME]) {
      problems.push(`${RUNNER_PACKAGE_JSON}: "dependencies" must include "${PLUGIN_NAME}" so the full Docker image bundles it`);
    }
  }

  let config;
  try {
    config = JSON.parse(readFileSync(RUNNER_CONFIG_JSON, 'utf8'));
  } catch (err) {
    problems.push(`${RUNNER_CONFIG_JSON}: unreadable/invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  if (config) {
    if (!Array.isArray(config.plugins) || !config.plugins.includes(PLUGIN_NAME)) {
      problems.push(`${RUNNER_CONFIG_JSON}: "plugins" must include "${PLUGIN_NAME}"`);
    }
    if (config.storage?.driver !== 's3') {
      problems.push(
        `${RUNNER_CONFIG_JSON}: "storage.driver" must remain "s3" — bundling ${PLUGIN_NAME} must not switch the active driver ` +
          `(got ${JSON.stringify(config.storage?.driver ?? null)})`,
      );
    }
  }

  if (problems.length) {
    process.stderr.write(`\n✗ ${PLUGIN_NAME} runner packaging checks failed:\n\n`);
    for (const p of problems) process.stderr.write(`    ${p}\n`);
    process.stderr.write('\n');
    process.exit(1);
  }

  process.stdout.write(`✓ ${PLUGIN_NAME} resolves from the runner projectDir, is bundled as a runner dependency, is listed in crowi.config.json, and the default storage driver remains "s3".\n`);
}

main();
