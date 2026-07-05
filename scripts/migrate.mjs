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
//
// feature-dev-portal-worktree §3 data-protection backstop: `apply` (without
// `--dry-run`) is destructive. Run from a non-main worktree whose DB is NOT
// opt-in isolated (`dev.local.json`), it would hit the SHARED database — i.e.
// main's data — which is almost always a "forgot to isolate" mistake, not an
// intentional one. Guard it:
//   - main worktree, or an isolated worktree → no guard, runs as normal (and
//     the isolated worktree's MONGO_URI is transparently rewritten to its
//     `crowi_<key>` db, same derivation `pnpm dev` uses).
//   - non-main + shared DB + destructive command + interactive TTY → confirm.
//   - non-main + shared DB + destructive command + no TTY (CI / an agent) →
//     abort (no bypass-by-hanging-forever) unless `--yes` / CROWI_MIGRATE_FORCE=1.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { isolatedDbName, normalizeWorktreeKey, readDevLocalConfig, resolveBaseMongoUri, withMongoDbName } from './dev-ports.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runnerDir = path.join(repoRoot, 'apps', 'crowi-runner')
const envFile = path.join(repoRoot, '.env')
const bin = path.join(repoRoot, 'packages', 'admin-cli', 'dist', 'bin.js')

/** `apply` without `--dry-run` mutates the database; everything else (plan/status/list, or a dry-run) is safe to skip the guard. */
export function isDestructiveMigrateCommand(args) {
  return args.includes('apply') && !args.includes('--dry-run')
}

/** Explicit opt-out for CI / scripted / agent use, so the guard fails closed instead of hanging on a prompt nobody can answer. */
export function isMigrationGuardBypassed(args, env = process.env) {
  return args.includes('--yes') || env.CROWI_MIGRATE_FORCE === '1'
}

/** Guard fires only for a non-main worktree that hasn't opted into DB isolation — main and isolated worktrees are always safe. */
export function isNonMainSharedDb({ key, isolateDb }) {
  return key !== 'main' && !isolateDb
}

async function main() {
  if (!existsSync(bin)) {
    process.stderr.write(`[migrate] ${path.relative(repoRoot, bin)} not found — build the admin CLI first:\n  pnpm --filter @crowi/admin-cli build\n`)
    process.exit(1)
  }

  const rawArgs = process.argv.slice(2)
  // `--yes` is this wrapper's own bypass flag, not a crowi-admin option —
  // strip it before forwarding (commander errors out on unknown options).
  const forwardedArgs = rawArgs.filter((a) => a !== '--yes')

  const key = normalizeWorktreeKey(repoRoot)
  const { isolateDb } = readDevLocalConfig(repoRoot)

  if (isDestructiveMigrateCommand(rawArgs) && isNonMainSharedDb({ key, isolateDb })) {
    if (isMigrationGuardBypassed(rawArgs)) {
      process.stderr.write(`[migrate] guard bypassed (--yes / CROWI_MIGRATE_FORCE=1) for worktree "${key}" against the SHARED database.\n`)
    } else if (!process.stdin.isTTY) {
      process.stderr.write(
        `[migrate] refusing to run a destructive migration ('apply') from worktree "${key}" (not main) against the SHARED database ` +
          `(no dev.local.json isolation, and no TTY to confirm).\n` +
          `[migrate]   → isolate this worktree's DB (dev.local.json: { "isolateDb": true }) or re-run with --yes to override.\n`,
      )
      process.exit(1)
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      let answer
      try {
        answer = await rl.question(
          `[migrate] worktree "${key}" is NOT main and its DB is NOT isolated — this will run a destructive migration against ` +
            `the SHARED database (main's data). Continue? [y/N] `,
        )
      } finally {
        rl.close()
      }
      if (!/^y(es)?$/i.test(answer.trim())) {
        process.stderr.write('[migrate] aborted.\n')
        process.exit(1)
      }
    }
  }

  // Isolated worktrees target their own `crowi_<key>` db — same derivation
  // `pnpm dev` uses — so `pnpm migrate` never touches the shared DB by
  // accident once a worktree has opted in.
  let mongoUriOverride
  if (isolateDb) {
    const baseMongoUri = resolveBaseMongoUri(envFile)
    try {
      mongoUriOverride = withMongoDbName(baseMongoUri, isolatedDbName(key))
    } catch (err) {
      process.stderr.write(`[migrate] warning: could not derive an isolated MONGO_URI (${err.message}) — using the shared DB instead.\n`)
    }
  }

  const nodeArgs = []
  // `--env-file-if-exists` so a fresh clone without a .env still runs (the CLI
  // then relies on whatever is already in the environment).
  if (existsSync(envFile)) nodeArgs.push(`--env-file=${envFile}`)

  const res = spawnSync(process.execPath, [...nodeArgs, bin, 'migrate', ...forwardedArgs], {
    cwd: runnerDir,
    stdio: 'inherit',
    // An explicit MONGO_URI here is already present in the child's initial
    // env, so node's `--env-file` (which does NOT override existing env vars)
    // won't clobber it with the shared DB's URI from the repo-root `.env`.
    env: mongoUriOverride ? { ...process.env, MONGO_URI: mongoUriOverride } : process.env,
  })

  if (res.error) {
    process.stderr.write(`[migrate] failed to launch: ${res.error.message}\n`)
    process.exit(1)
  }
  process.exit(res.status ?? 1)
}

// `import.meta.main` is Node 24+. Guard so the module can be imported by a
// test (it re-exports the pure guard functions above) without shelling out.
if (import.meta.main) {
  main()
}
