import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// feature-redis-subscriber-crash-fix: shared by every `no-restricted-syntax`
// config object below that needs to flag a direct `.duplicate()` call. Flat
// config was expected (feature-eslint-10-flat-config §3) to resolve the
// eslintrc-era problem this constant works around — ESLint REPLACES, not
// merges, a rule's config when two config objects with overlapping `files`
// both set the same ruleId — but that turned out to hold under flat config
// too (verified empirically: a 2-entry flat config array both setting
// `no-restricted-syntax` on overlapping `**/*.test.ts` files, the second
// entry's selector array fully won, the first was gone). So this selector
// still has to be spread into every `no-restricted-syntax` array whose file
// scope collides with another config object that also configures that rule
// — just into 2 config objects below instead of eslintrc's 3, because
// `ignores` lets one of them say "everything except redis-opts.ts" instead
// of needing a whole separate object per carve-out.
const DUPLICATE_GUARD_SELECTOR = {
  selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='duplicate']",
  message:
    'Do not call .duplicate() directly on a Redis client — use duplicateWithErrorHandler(client, label) from src/util/redis-opts.ts so the duplicate subscriber gets an error/ready listener before a Redis outage crashes the process.',
};

export default defineConfig([
  globalIgnores([
    'dist/**',
    'coverage/**',
    'tmp/**',
    // `--ext .ts,.tsx` only ADDS these extensions to flat config's default
    // extension set (`.js`/`.mjs`/`.cjs`) — under eslintrc it REPLACED the
    // default set. Without this, `pnpm lint` would newly sweep in the
    // harness's plain-JS files under `src/test/` (`global-setup.js`,
    // `crowi-environment.js`, ...).
    '**/*.js',
    '**/*.d.ts',
  ]),
  {
    // Flat config's built-in default (`reportUnusedDisableDirectives: 1`,
    // see eslint's `lib/config/default-config.js`) has no eslintrc
    // equivalent — classic config only reported these behind the
    // `--report-unused-disable-directives` CLI flag, which `pnpm lint`
    // never passed. Left at the flat default, an existing `// eslint-
    // disable-next-line @typescript-eslint/no-explicit-any` in a test file
    // (legal under the override below, which turns that rule off there)
    // would newly warn as "unused".
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
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/test/**/*'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        // Resolve `project` relative to THIS config's directory, not the
        // process cwd. `pnpm lint` runs with cwd = packages/api (turbo), but
        // the VSCode ESLint extension runs with cwd = repo root, where
        // `./tsconfig.json` would wrongly resolve to the root solution-style
        // tsconfig (`include: []`) and fail with "TSConfig does not include
        // this file". `import.meta.dirname` makes it deterministic in both
        // (the `.mjs` equivalent of eslintrc's `__dirname`).
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.test.ts', 'src/test/**/*'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // B1 (feature-test-parallel-db-flake-hardening Phase 3) + feature-redis-
  // subscriber-crash-fix, restructured for flat config as 2 config objects
  // (D then T) rather than eslintrc's 3 — see `DUPLICATE_GUARD_SELECTOR`'s
  // doc comment for why this works despite flat config's own same-rule-
  // replace semantics. Required results (feature-eslint-10-flat-config §3),
  // asserted by `src/test/eslint-db-guard.test.ts`:
  //   - an ordinary test file gets all 3 DB-guard selectors
  //   - `src/test/**` (the harness's own implementation) is exempt from the
  //     DB guard
  //   - the `.duplicate()` guard applies to production AND test files
  //     alike, `src/util/redis-opts.ts` (`duplicateWithErrorHandler`) only
  //     excepted
  //
  // D: `.duplicate()` guard, everywhere except redis-opts.ts. This is the
  // ONLY guard `src/test/**` gets (T below never matches paths under it).
  {
    files: ['src/**/*.ts'],
    ignores: ['src/util/redis-opts.ts'],
    rules: {
      'no-restricted-syntax': ['error', DUPLICATE_GUARD_SELECTOR],
    },
  },
  // T: ordinary test files only (`src/test/**` carved back out — matches
  // the eslintrc override's `excludedFiles`). Ordered AFTER D and matching
  // the same files D does, so — per flat config's same-rule-replace
  // semantics — THIS array is what wins here; it has to restate
  // `DUPLICATE_GUARD_SELECTOR` itself rather than relying on D, or an
  // ordinary test file would lose the duplicate guard entirely.
  {
    files: ['**/*.test.ts'],
    ignores: ['src/test/**/*'],
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
        DUPLICATE_GUARD_SELECTOR,
      ],
    },
  },
]);
