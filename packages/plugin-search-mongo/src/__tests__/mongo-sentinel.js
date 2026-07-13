const os = require('node:os');
const path = require('node:path');

// `@crowi/plugin-search-mongo`'s OWN run-scoped sentinel — a deliberate,
// protocol-identical DUPLICATE of `packages/api/src/test/test-mongo-sentinel.js`
// and `packages/collab/src/__tests__/mongo-sentinel.js` (Phase 3 / B1 of
// feature-test-parallel-db-flake-hardening). No shared npm package — see
// `global-setup.js`'s doc comment for the full rationale.
//
// THIS FILE MUST STAY IN SYNC WITH:
//   - packages/api/src/test/test-mongo-sentinel.js
//   - packages/collab/src/__tests__/mongo-sentinel.js
// If you change the protocol here (probe order, run-id generation, sentinel
// naming, the loud-throw-on-unset behaviour), check the other two.
function getSentinelPath() {
  const runId = process.env.CROWI_TEST_RUN_ID;
  if (!runId) {
    throw new Error(
      'plugin-search-mongo mongo-sentinel: CROWI_TEST_RUN_ID is unset. This should always be inherited from ' +
        'global-setup.js (set before any jest worker forks) — an unset value here means env ' +
        'propagation to this worker is broken. Refusing to fall back to a machine-shared sentinel path.',
    );
  }
  return path.join(os.tmpdir(), `crowi-plugin-search-mongo-test-mongo-uri.${runId}`);
}

module.exports = { getSentinelPath };
