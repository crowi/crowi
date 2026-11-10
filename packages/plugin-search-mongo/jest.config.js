/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  // Probes for a shared docker Mongo (`crowi-test-mongodb`:27018 / dev
  // `mongodb`:27017) ONCE, before any worker forks, falling back to
  // per-file `mongodb-memory-server` when neither is reachable — a
  // deliberate duplicate of `packages/api`'s / `packages/collab`'s jest
  // globalSetup protocol (feature-test-parallel-db-flake-hardening
  // Phase 3 / B1). See `src/__tests__/global-setup.js`'s doc comment.
  globalSetup: './src/__tests__/global-setup.js',
  // mongodb-memory-server downloads + spins up a real mongod (only on the
  // no-docker fallback path now); give the driver suite room beyond the 5s
  // default.
  testTimeout: 60000,
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
    // The mongodb driver (>= 7.6) loads its default `os` adapter with a
    // dynamic `import('os')`, which throws inside jest's vm context unless
    // node runs with `--experimental-vm-modules`. The driver swallows that
    // into an empty client metadata document and mongod refuses every
    // handshake ("Missing required sub-document 'driver'"). Down-compiling
    // this one file turns the import into a `require('os')`.
    '.+/mongodb/lib/runtime_adapters\\.js$': [
      'ts-jest',
      {
        tsconfig: { allowJs: true, module: 'commonjs' },
      },
    ],
  },
  // The leading `.*` is load-bearing under pnpm: the driver sits after the
  // SECOND `node_modules/` (`node_modules/.pnpm/mongodb@<v>/node_modules/...`).
  transformIgnorePatterns: ['/node_modules/(?!(.*mongodb/lib/runtime_adapters\\.js$))'],
};
