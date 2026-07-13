// `root: true` stops ESLint's ancestor-config search at this package.
// Without it, `@crowi/collab` (pinned to ESLint 8 + @typescript-eslint 6)
// would pick up the repo's ESLint 9 flat config and load a mismatched
// plugin major. Mirrors `packages/api/.eslintrc.js`.
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
      files: ['**/*.test.ts', 'src/__tests__/**/*'],
      env: {
        jest: true,
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    // B1 (feature-test-parallel-db-flake-hardening Phase 3): same
    // DB-bypass guard as `packages/api/.eslintrc.js` — block a test file
    // from opening its own ad hoc DB connection instead of going through
    // the harness (`__tests__/setup.ts`'s `startInMemoryMongo()`).
    // `excludedFiles` carves out this package's own harness implementation
    // files (mirrors `packages/api/.eslintrc.js`'s `src/test/**/*`
    // exclusion) as a SEPARATE override so the `no-explicit-any: off`
    // above stays scoped to exactly the files it already applied to.
    {
      files: ['**/*.test.ts', 'src/__tests__/**/*'],
      excludedFiles: ['src/__tests__/setup.ts', 'src/__tests__/global-setup.js', 'src/__tests__/mongo-sentinel.js'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'mongodb-memory-server',
                message: 'Do not spin up mongodb-memory-server directly in a test file — use the harness (__tests__/setup.ts) instead.',
              },
              {
                name: 'mongodb',
                message: 'Do not import the mongodb driver directly in a test file — use the harness (__tests__/setup.ts) instead.',
              },
              {
                name: 'mongoose',
                importNames: ['connect', 'createConnection'],
                message:
                  'Do not import connect/createConnection from mongoose in a test file — the harness (__tests__/setup.ts) already provides a connection.',
              },
            ],
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='mongoose'][callee.property.name=/^(connect|createConnection)$/]",
            message:
              'Do not call mongoose.connect()/mongoose.createConnection() in a test file — the harness (__tests__/setup.ts) already provides a connection.',
          },
          {
            selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='MongoMemoryServer'][callee.property.name='create']",
            message:
              'Do not call MongoMemoryServer.create() in a test file — the harness (__tests__/setup.ts) already falls back to it when no docker Mongo is reachable.',
          },
          {
            selector: "VariableDeclarator[init.name='mongoose'] > ObjectPattern > Property[key.name=/^(connect|createConnection)$/]",
            message:
              'Do not destructure connect/createConnection off mongoose (e.g. `const { connect } = mongoose`) in a test file — the harness (__tests__/setup.ts) already provides a connection.',
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
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', 'tmp/', '*.js', '!.eslintrc.js', '*.d.ts'],
};
