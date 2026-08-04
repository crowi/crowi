// feature-redis-subscriber-crash-fix: shared by every `no-restricted-syntax`
// override below that needs to flag a direct `.duplicate()` call (see the
// override blocks for why this can't live in a single override — ESLint
// REPLACES, not merges, a rule's config when two `overrides` entries with
// overlapping `files` both set the same ruleId, so this same selector has to
// be spread into each `no-restricted-syntax` array whose file scope would
// otherwise collide with another override that also configures that rule).
const DUPLICATE_GUARD_SELECTOR = {
  selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='duplicate']",
  message:
    'Do not call .duplicate() directly on a Redis client — use duplicateWithErrorHandler(client, label) from src/util/redis-opts.ts so the duplicate subscriber gets an error/ready listener before a Redis outage crashes the process.',
};

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
          // feature-redis-subscriber-crash-fix: spread in here (rather than
          // a separate override with an overlapping `files` glob) because
          // ESLint replaces — it does not merge — a rule's config when two
          // `overrides` entries with overlapping `files` both set the same
          // ruleId; a sibling override for `**/*.test.ts` would silently
          // wipe out the three DB-guard selectors above for every ordinary
          // test file. See `DUPLICATE_GUARD_SELECTOR`'s doc comment.
          DUPLICATE_GUARD_SELECTOR,
        ],
      },
    },
    // feature-redis-subscriber-crash-fix: a duplicated Redis client used as
    // a dedicated pub/sub subscriber needs an `error` listener attached
    // BEFORE it is `connect()`-ed, or a steady-state Redis outage after
    // connect raises an unhandled EventEmitter 'error' and crashes the api
    // process (the 2026-07-27 almoha Redis 7->8 restart incident).
    // `duplicateWithErrorHandler` (src/util/redis-opts.ts) is the one
    // helper that does this correctly and is the sole allowed place to call
    // `.duplicate()` directly; EVERY other file — production or test — must
    // go through it instead (AC-3 draws no test-file exception: "a direct
    // .duplicate() call outside src/util/redis-opts.ts is an ESLint
    // error"). No existing test file needs the raw call — a `FakeRedis`
    // DEFINES a `duplicate()` method rather than calling `.duplicate()` on
    // something, and calling `duplicateWithErrorHandler(...)` itself (as
    // `redis-opts.test.ts` does) doesn't match this selector either — so
    // covering test files too costs nothing.
    //
    // THREE blocks, not one, because a single `files: ['src/**/*.ts']`
    // override would overlap the DB-guard block above (both configure
    // `no-restricted-syntax`) and silently replace it for ordinary test
    // files — see `DUPLICATE_GUARD_SELECTOR`'s doc comment. This block
    // covers `src/test/**/*` (the DB guard's own `excludedFiles` carve-out,
    // so no collision there) and ordinary production source; the ordinary
    // `**/*.test.ts` case is covered by the selector spread into the
    // DB-guard block above instead.
    {
      files: ['src/test/**/*'],
      rules: {
        'no-restricted-syntax': ['error', DUPLICATE_GUARD_SELECTOR],
      },
    },
    {
      files: ['src/**/*.ts'],
      excludedFiles: ['**/*.test.ts', 'src/test/**/*', 'src/util/redis-opts.ts'],
      rules: {
        'no-restricted-syntax': ['error', DUPLICATE_GUARD_SELECTOR],
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
