import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// B1 (feature-test-parallel-db-flake-hardening Phase 3): same DB-bypass
// guard as `packages/api/eslint.config.mjs` / `packages/collab/eslint.config.mjs`
// — block a test file from opening its own ad hoc DB connection instead of
// going through the harness (`__tests__/setup.ts`).
const dbBypassRules = {
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
          message: 'Do not import connect/createConnection from mongoose in a test file — the harness (__tests__/setup.ts) already provides a connection.',
        },
      ],
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='mongoose'][callee.property.name=/^(connect|createConnection)$/]",
      message: 'Do not call mongoose.connect()/mongoose.createConnection() in a test file — the harness (__tests__/setup.ts) already provides a connection.',
    },
    {
      selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='MongoMemoryServer'][callee.property.name='create']",
      message: 'Do not call MongoMemoryServer.create() in a test file — the harness (__tests__/setup.ts) already falls back to it when no docker Mongo is reachable.',
    },
    {
      selector: "VariableDeclarator[init.name='mongoose'] > ObjectPattern > Property[key.name=/^(connect|createConnection)$/]",
      message: 'Do not destructure connect/createConnection off mongoose (e.g. `const { connect } = mongoose`) in a test file — the harness (__tests__/setup.ts) already provides a connection.',
    },
  ],
};

export default defineConfig([
  // Flat config's resolution walks up from cwd (findUp) rather than
  // stopping at the nearest ancestor `root: true` the way eslintrc did, but
  // the nearest config file found IS the final config either way — this
  // package needs its own file regardless, for the DB-bypass guard below.
  globalIgnores([
    'dist/**',
    'coverage/**',
    'tmp/**',
    // `--ext .ts` only ADDS `.ts` to flat config's default extension set
    // (`.js`/`.mjs`/`.cjs`) — under eslintrc it REPLACED the default set.
    // Without this, `pnpm lint` would newly sweep in the harness's plain-JS
    // files below (`__tests__/global-setup.js`, `__tests__/mongo-sentinel.js`).
    '**/*.js',
    '**/*.d.ts',
  ]),
  {
    // See `packages/collab/eslint.config.mjs` for why this is set — flat
    // config's built-in default (`reportUnusedDisableDirectives: 1`) has no
    // eslintrc equivalent and would otherwise newly warn on every
    // `// eslint-disable-next-line @typescript-eslint/no-explicit-any` in a
    // test file (legal there under the override below).
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  js.configs.recommended,
  {
    // Restore eslint 8.57.1's `eslint:recommended` rule states — see the
    // repo-root `eslint.config.mjs`'s matching block for the full
    // rationale (AC-9: rule states must survive this migration unchanged;
    // `@eslint/js` added/removed rules from "recommended" between 8.57.1
    // and 9.x). `no-new-symbol`/`no-new-native-nonconstructor` also moved
    // but are intentionally left out — `tsPlugin.configs['flat/recommended']`
    // below force-disables both for every `.ts` file regardless of eslint
    // version, so they already match 8.57.1's effective state unaided.
    rules: {
      'no-extra-semi': 'error',
      'no-inner-declarations': 'error',
      'no-mixed-spaces-and-tabs': 'error',
      'no-constant-binary-expression': 'off',
      'no-empty-static-block': 'off',
      'no-unused-private-class-members': 'off',
    },
  },
  ...tsPlugin.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-var-requires': 'warn',
    },
  },
  {
    files: ['**/*.test.ts', 'src/__tests__/**/*'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.test.ts', 'src/__tests__/**/*'],
    ignores: ['src/__tests__/setup.ts', 'src/__tests__/global-setup.js', 'src/__tests__/mongo-sentinel.js'],
    rules: dbBypassRules,
  },
]);
