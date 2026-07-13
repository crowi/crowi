/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  // Probes for a shared docker Mongo (`crowi-test-mongodb`:27018 / dev
  // `mongodb`:27017) ONCE, before any worker forks, falling back to
  // per-file `mongodb-memory-server` when neither is reachable — a
  // deliberate duplicate of `packages/api`'s jest globalSetup protocol
  // (feature-test-parallel-db-flake-hardening Phase 3 / B1). See
  // `src/__tests__/global-setup.js`'s doc comment.
  globalSetup: './src/__tests__/global-setup.js',
  // `package.json`'s `test` script pins `--maxWorkers=5` (was previously
  // unset, defaulting to jest's `cores - 1`): now that a docker-detected run
  // opens a REAL connection to the shared test mongod (not just an isolated
  // in-process memory-server per file), an unbounded worker count risks the
  // same N×maxPoolSize socket-burst-against-one-shared-mongod class
  // `packages/api`'s own `--maxWorkers=5` (`packages/api/package.json`) cap
  // exists to prevent — same pool math (`maxPoolSize=10`, `buildPerFileUri()`
  // above), applied independently since this is a separate jest process with
  // its own worker pool (Phase 3 / B1).
  // Smoke test spins up a per-file Mongo database and drives the Phase 3
  // hooks directly. Allow generous slack so CI cold-starts don't
  // false-flag.
  testTimeout: 60000,
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
};
