#!/usr/bin/env node
// `pnpm migrate <args>` — thin wrapper around the `crowi-admin migrate`
// namespace (RFC-0008 data migrations) so you don't have to type the long
// invocation by hand:
//
//   pnpm migrate plan
//   pnpm migrate apply --dry-run
//   pnpm migrate apply
//   pnpm migrate status
//
// It runs the built admin-cli from the reference runner project so that:
//   - `@crowi/api` resolves (it is a dependency of `apps/crowi-runner`), and
//   - the repo-root `.env` is loaded (MONGO_URI / CROWI_ENCRYPTION_KEY / …),
// which is the same projectDir/.env split the dev server uses since the
// runner-project restructure. Equivalent to:
//   (cd apps/crowi-runner && node --env-file=../../.env \
//      ../../packages/admin-cli/dist/bin.js migrate <args>)

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runnerDir = path.join(repoRoot, 'apps', 'crowi-runner')
const envFile = path.join(repoRoot, '.env')
const bin = path.join(repoRoot, 'packages', 'admin-cli', 'dist', 'bin.js')

if (!existsSync(bin)) {
  process.stderr.write(`[migrate] ${path.relative(repoRoot, bin)} not found — build the admin CLI first:\n  pnpm --filter @crowi/admin-cli build\n`)
  process.exit(1)
}

const nodeArgs = []
// `--env-file-if-exists` so a fresh clone without a .env still runs (the CLI
// then relies on whatever is already in the environment).
if (existsSync(envFile)) nodeArgs.push(`--env-file=${envFile}`)

const res = spawnSync(process.execPath, [...nodeArgs, bin, 'migrate', ...process.argv.slice(2)], {
  cwd: runnerDir,
  stdio: 'inherit',
})

if (res.error) {
  process.stderr.write(`[migrate] failed to launch: ${res.error.message}\n`)
  process.exit(1)
}
process.exit(res.status ?? 1)
