module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/ban-ts-comment': 'warn',
    '@typescript-eslint/no-var-requires': 'warn',
  },
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  overrides: [
    {
      files: ['src/**/*.ts'],
      excludedFiles: ['**/*.test.ts', 'src/test/**/*'],
      parserOptions: {
        project: './tsconfig.json',
        // Resolve `project` relative to THIS config's directory, not the
        // process cwd. `pnpm lint` runs with cwd = packages/api (turbo), but
        // the VSCode ESLint extension runs with cwd = repo root, where
        // `./tsconfig.json` would wrongly resolve to the root solution-style
        // tsconfig (`include: []`) and fail with "TSConfig does not include
        // this file". `__dirname` makes it deterministic in both.
        tsconfigRootDir: __dirname,
      },
    },
    {
      files: ['**/*.test.ts', 'src/test/**/*'],
      env: {
        jest: true,
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    // B1 (feature-test-parallel-db-flake-hardening Phase 3): block the
    // common ways a test file could open its own ad hoc DB connection
    // instead of going through the harness (`test/setup.ts` / `Fixture`).
    // A SEPARATE override block, not an addition to the one above:
    // `excludedFiles` here carves out `src/test/**/*` itself — that's the
    // harness's OWN implementation, and e.g. `crowi-environment.test.ts`
    // legitimately calls `mongoose.createConnection()` directly to drive
    // `dropPerFileDatabase()` against a real server. Adding `excludedFiles`
    // to the override above would also strip its unrelated
    // `no-explicit-any: off`, hence a second, additive block instead.
    //
    // This is the FULL directory, not a hand-picked file list, and that is
    // intentional (matches the spec's AC2 literally: "除外対象は
    // `src/test/**`(既存 harness 実装ファイル)... のみに限定されている") —
    // every `.ts`/`.js` file under `src/test/` today IS either harness
    // implementation or a harness-only unit test that legitimately drives a
    // real connection (`crowi-environment.js`, `crowi-environment.test.ts`,
    // `global-setup.js`, `global-setup.test.ts`, `db-connect-retry.ts`,
    // `test-mongo-sentinel.js`, `setup.ts`, ...) — there is no ordinary
    // feature test in this directory for the guard to fail to cover. A
    // hand-picked allowlist would be MORE fragile here, not less: nearly
    // every file in this directory legitimately mentions
    // connect/createConnection/MongoMemoryServer in doc comments or test
    // fixtures (this rule's own negative-fixture test,
    // `src/test/eslint-db-guard.test.ts`, is a case in point), so a
    // per-file list would need constant, error-prone upkeep for zero
    // additional safety. `eslint-db-guard.test.ts` proves the guard is NOT
    // silently defeated for ordinary test files elsewhere by linting its
    // fixtures with a virtual `filePath` OUTSIDE `src/test/**`
    // (`src/hono/handlers/...`) — see that file's module doc comment — and
    // separately proves (with a decisive test) that a fixture path INSIDE
    // `src/test/**` is, as designed, exempt.
    {
      files: ['**/*.test.ts', 'src/test/**/*'],
      excludedFiles: ['src/test/**/*'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'mongodb-memory-server',
                message: 'Do not spin up mongodb-memory-server directly in a test file — use the harness (test/setup.ts + crowi-environment.js) instead.',
              },
              {
                name: 'mongodb',
                message: 'Do not import the mongodb driver directly in a test file — use the harness (test/setup.ts + crowi-environment.js) instead.',
              },
              {
                name: 'mongoose',
                importNames: ['connect', 'createConnection'],
                message: 'Do not import connect/createConnection from mongoose in a test file — the harness (test/setup.ts) already provides a connection.',
              },
            ],
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='mongoose'][callee.property.name=/^(connect|createConnection)$/]",
            message: 'Do not call mongoose.connect()/mongoose.createConnection() in a test file — the harness (test/setup.ts) already provides a connection.',
          },
          {
            selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='MongoMemoryServer'][callee.property.name='create']",
            message:
              'Do not call MongoMemoryServer.create() in a test file — the harness (crowi-environment.js) already falls back to it when no docker Mongo is reachable.',
          },
          {
            selector: "VariableDeclarator[init.name='mongoose'] > ObjectPattern > Property[key.name=/^(connect|createConnection)$/]",
            message:
              'Do not destructure connect/createConnection off mongoose (e.g. `const { connect } = mongoose`) in a test file — the harness (test/setup.ts) already provides a connection.',
          },
        ],
      },
    },
  ],
  env: {
    node: true,
    es6: true,
    jest: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', 'tmp/', '*.js', '!.eslintrc.js', '!jest.config.js', '*.d.ts'],
};
