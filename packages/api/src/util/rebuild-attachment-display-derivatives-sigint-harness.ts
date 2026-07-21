/**
 * feature-image-derivative-optimization Phase 3 §AC6 — a genuinely
 * separate-OS-process harness that runs `attachment-display-derivatives`
 * through the SAME production building blocks the real `crowi-admin rebuild
 * attachment-display-derivatives` command uses (`Crowi.initForCli()`,
 * `RebuildRunner`, `attachmentDisplayDerivativesRebuild`), so
 * `rebuild-attachment-display-derivatives.test.ts`'s SIGINT coverage can send
 * a REAL OS `SIGINT` to a REAL process and observe a REAL process exit code +
 * REAL stdout progress-summary text + REAL on-disk tmp cleanup — none of
 * which the cheaper in-process "invoke the captured `process.on('SIGINT',
 * ...)` listener directly" test can prove (sending a genuine signal to the
 * Jest process itself would tear down the whole test run when Jest is
 * invoked against a single/few matched file(s), which run in-band with no
 * worker child process — see that test's own doc comment for the empirical
 * confirmation).
 *
 * Deliberately reconstructs the CLI's *wiring* (`Crowi.initForCli()` +
 * `RebuildRunner` + the `attachmentDisplayDerivativesRebuild` task — the
 * exact building blocks `RebuildCliApi.rebuildAttachmentDisplayDerivatives`
 * assembles) rather than spawning the actual `crowi-admin` binary:
 * `@crowi/admin-cli`'s `loadApi()` `require()`s a BUILT `@crowi/api/dist`,
 * which this repo's jest suite never builds as a test prerequisite (and
 * making the test suite depend on a fresh `dist/` would be fragile — see
 * this feature's own Phase 2 attempt that hit a real `tsc`/`tsc-alias` build
 * defect). The exit-code mapping below mirrors (duplicates, deliberately — a
 * 2-line pure formula, not worth a cross-package `@crowi/api ->
 * @crowi/admin-cli` test-only dependency in the wrong direction)
 * `attachmentDisplayDerivativesExitCode` (`packages/admin-cli/src/commands/rebuild.ts`),
 * which is independently unit-tested there; the progress-summary text below
 * mirrors that same file's `printOutcome`.
 *
 * Run via `tsx` (same approach as `storage-local-atomic-put-worker.ts` /
 * `collab/redis-smoke-harness.ts`) so it is a genuinely separate OS process —
 * `process.pid` differs from the Jest process, and an OS-delivered SIGINT
 * here cannot tear down the test runner.
 *
 * Protocol (env vars — all required unless noted):
 *   - `CROWI_REBUILD_SIGINT_HARNESS_ROOT_DIR` — passed as `Crowi`'s
 *     `rootDir` constructor arg. A fresh, harness-private directory (the
 *     parent test `mkdtemp`s one) so `crowi.tmpDir` (`<rootDir>/tmp/`)
 *     resolves somewhere the parent can inspect in isolation, instead of the
 *     process-wide, test-file-shared `packages/api/tmp/` every other test in
 *     the sibling file has to snapshot before/after.
 *   - `MONGO_URI` — the SAME per-file test MongoDB the parent Jest process
 *     is already connected to (the parent seeds Attachment rows into it
 *     before spawning this harness); overrides whatever `process.env`
 *     otherwise carries, mirroring `src/test/setup.ts`'s own override of the
 *     inherited env for its in-process `crowi`.
 *   - `CROWI_REBUILD_SIGINT_HARNESS_STORAGE_ROOT` — a local filesystem root
 *     the parent's `withDriver('local', ...)`-equivalent seeding already
 *     wrote the seeded attachments' original objects into. There is no
 *     `crowi.config.json` in `ROOT_DIR` (so `initForCli()`'s `setupPlugins()`
 *     step resolves the documented "absent config" defaults — `plugins: []`,
 *     `storage.driver: 'local'` — and, since no plugin registered a `local`
 *     driver, leaves `active.storage: null`, exactly like every OTHER test
 *     in the sibling file that starts from a bare `crowi` and assigns
 *     `active.storage` itself); this harness assigns
 *     `crowi.getPlugins().active.storage` to a real
 *     `createLocalDriver({ rootDir: <this value> })` right after boot,
 *     mirroring that same override pattern instead of requiring a config
 *     file + a real `@crowi/plugin-storage-local` npm resolution.
 *   - `CROWI_REBUILD_SIGINT_HARNESS_CONCURRENCY` (optional, default `1`) —
 *     forwarded as `RebuildRunner`'s `concurrency` option.
 *
 * Output protocol:
 *   - One JSON line per item, emitted the instant that item's processing
 *     BEGINS (before any decode/stage work) — `{"itemStarted":"<attachmentId>"}`.
 *     The parent watches stdout for the FIRST such line before sending
 *     SIGINT, so the signal genuinely lands after the run has begun, not
 *     racing this process's own (Mongo-connecting) startup.
 *   - A final progress-summary block, mirroring `printOutcome`
 *     (`packages/admin-cli/src/commands/rebuild.ts`) closely enough for the
 *     parent to assert on its content — including the literal `Interrupted
 *     by SIGINT before completion` line when `outcome.interrupted`.
 *   - Exits via `process.exitCode` (never a mid-flight `process.exit()` call,
 *     which could truncate a not-yet-flushed stdout write) — Node exits
 *     naturally once `crowi.teardownForCli()` has closed the Mongo
 *     connection and nothing else is keeping the event loop alive.
 */
import { createLocalDriver } from '@crowi/plugin-storage-local';
// Relative imports (NOT the `src/...` bare-specifier alias every ts-jest /
// tsc-built file in this package otherwise uses) — this file is run
// standalone via plain `tsx`, not through jest's module-name-mapper or a
// `tsc`/`tsc-alias` build, and no other `tsx`-spawned harness in this
// codebase (`redis-smoke-harness.ts`, `storage-local-atomic-put-worker.ts`)
// risks a runtime (non-`import type`) bare `src/...` specifier — they either
// avoid same-package runtime imports entirely or use `import type` (erased,
// never actually resolved). Relative imports need no alias resolution at all.
import Crowi from '../crowi';
import { RebuildRunner } from '../migration/rebuild-runner';
import { attachmentDisplayDerivativesRebuild } from '../migration/rebuilds';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`rebuild-attachment-display-derivatives-sigint-harness: required env var ${name} is not set`);
  }
  return value;
}

async function main(): Promise<void> {
  const rootDir = requiredEnv('CROWI_REBUILD_SIGINT_HARNESS_ROOT_DIR');
  const storageRoot = requiredEnv('CROWI_REBUILD_SIGINT_HARNESS_STORAGE_ROOT');
  const concurrency = Number.parseInt(process.env.CROWI_REBUILD_SIGINT_HARNESS_CONCURRENCY ?? '1', 10);

  const crowi = new Crowi(rootDir, process.env);
  await crowi.initForCli();

  try {
    // See this file's own doc comment: no `crowi.config.json` in `rootDir`
    // means `active.storage` is `null` after boot — assign the real local
    // driver directly, the same override every other test in the sibling
    // file uses (`withDriver`).
    crowi.getPlugins().active.storage = createLocalDriver({ rootDir: storageRoot });

    const runner = new RebuildRunner(crowi, {
      concurrency,
      progress: {
        setTotal: () => undefined,
        increment: () => undefined,
        setLabel: (label) => {
          // `RebuildRunner.run()` itself calls `setLabel('rebuild:<task id>')`
          // ONCE, before `task.run()` even starts (see `rebuild-runner.ts`)
          // — filter that one out so the parent's "wait for the FIRST
          // itemStarted line" synchronization point genuinely corresponds to
          // an ATTACHMENT's processing beginning, not the run as a whole.
          if (label.startsWith('rebuild:')) return;
          process.stdout.write(`${JSON.stringify({ itemStarted: label })}\n`);
        },
      },
    });

    const outcome = await runner.run(attachmentDisplayDerivativesRebuild({}));

    process.stdout.write('\n--- summary ---\n');
    process.stdout.write('target:   attachment-display-derivatives\n');
    for (const [key, value] of Object.entries(outcome.stats)) {
      process.stdout.write(`${key}: ${JSON.stringify(value)}\n`);
    }
    process.stdout.write(`elapsed:  ${outcome.durationMs}ms\n`);
    if (outcome.interrupted) {
      process.stdout.write('\nInterrupted by SIGINT before completion — re-run to finish.\n');
    } else {
      process.stdout.write("\nRebuild 'attachment-display-derivatives' complete.\n");
    }

    const failed = outcome.stats.failed;
    // Mirrors `attachmentDisplayDerivativesExitCode` — see this file's own
    // doc comment for why it is duplicated rather than imported.
    process.exitCode = outcome.interrupted ? 130 : typeof failed === 'number' && failed > 0 ? 2 : 0;
  } finally {
    await crowi.teardownForCli().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`rebuild-attachment-display-derivatives-sigint-harness fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
