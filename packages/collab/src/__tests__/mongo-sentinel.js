const os = require('node:os');
const path = require('node:path');

// `@crowi/collab`'s OWN run-scoped sentinel — a deliberate, protocol-identical
// DUPLICATE of `packages/api/src/test/test-mongo-sentinel.js` and
// `packages/plugin-search-mongo/src/__tests__/mongo-sentinel.js` (Phase 3 /
// B1 of feature-test-parallel-db-flake-hardening). No shared npm package: a
// new monorepo package just to host ~20 lines would need its own
// `package.json` / `tsconfig` / lint setup, which is a worse cost than three
// small, independently-readable copies (see the design doc's B1 section for
// the full rationale, including why `packages/plugin-search-mongo` getting
// its OWN `.eslintrc.js` in this same phase makes a 3rd shared dependency
// even less attractive).
//
// THIS FILE MUST STAY IN SYNC WITH:
//   - packages/api/src/test/test-mongo-sentinel.js
//   - packages/plugin-search-mongo/src/__tests__/mongo-sentinel.js
// If you change the protocol here (probe order, run-id generation, sentinel
// naming, the loud-throw-on-unset behaviour), check the other two.
//
// Why a file at all, and why run-scoped: see
// `packages/api/src/test/test-mongo-sentinel.js`'s doc comment for the full
// jest-internals citation (`globalSetup` runs in the jest MAIN process,
// strictly before any worker is forked, so a `process.env` mutation made
// there — `CROWI_TEST_RUN_ID` — reaches every forked worker via
// `child_process.fork`'s env copy; the file's role is only to let a worker
// tell "no docker Mongo reachable" apart from "this run's own sentinel was
// never written").
function getSentinelPath() {
  const runId = process.env.CROWI_TEST_RUN_ID;
  if (!runId) {
    // Always inherited via `child_process.fork`'s env copy by the time any
    // worker-side code reaches here (see the citation above) — an unset
    // value is a broken-harness signal, not a legitimate state. Refusing to
    // fall back to a machine-shared path avoids reintroducing the exact
    // cross-run race `packages/api`'s A1-4 fix exists to prevent, just
    // relocated to this package.
    throw new Error(
      'collab mongo-sentinel: CROWI_TEST_RUN_ID is unset. This should always be inherited from ' +
        'global-setup.js (set before any jest worker forks) — an unset value here means env ' +
        'propagation to this worker is broken. Refusing to fall back to a machine-shared sentinel path.',
    );
  }
  return path.join(os.tmpdir(), `crowi-collab-test-mongo-uri.${runId}`);
}

module.exports = { getSentinelPath };
