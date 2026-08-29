import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// `packages/cli` and `packages/e2e` have no `eslint.config.mjs` of their
// own — flat config's resolution (`findUp`, same as classic config's
// ancestor cascade) walks up from their cwd and lands on this file, so this
// IS their effective config, byte-identical to how they fell back to this
// file as `.eslintrc.js` before.
export default defineConfig([
  globalIgnores([
    'dist/**',
    'coverage/**',
    'tmp/**',
    // `--ext .ts` only ADDS `.ts` to flat config's default extension set
    // (`.js`/`.mjs`/`.cjs`) — under eslintrc it REPLACED the default set.
    '**/*.js',
    '**/*.d.ts',
  ]),
  {
    // Flat config's built-in default (`reportUnusedDisableDirectives: 1`,
    // see eslint's `lib/config/default-config.js`) has no eslintrc
    // equivalent — classic config only reported these behind the
    // `--report-unused-disable-directives` CLI flag, which no `lint` script
    // here ever passed.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  js.configs.recommended,
  {
    // eslintrc's `'eslint:recommended'` resolved through the installed
    // eslint's OWN bundled `@eslint/js` (verified in eslint 8.57.1's
    // `lib/config/flat-config-array.js`: the string is a thin alias for
    // `jsPlugin.configs.recommended`) — so on eslint 8.57.1 it pinned
    // `@eslint/js@8.57.1`'s rule set. `js.configs.recommended` above now
    // resolves through the installed eslint 9.x's `@eslint/js` instead,
    // which added/removed rules from "recommended" (AC-9 requires the old
    // states survive the migration unchanged). Diffed both versions'
    // `eslint-recommended.js` directly to get this list.
    //
    // `no-new-symbol`/`no-new-native-nonconstructor` also moved between the
    // two versions' recommended sets but are deliberately NOT restored
    // here: `tsPlugin.configs['flat/recommended']` below unconditionally
    // force-disables both for every `*.ts`/`*.tsx` file (TypeScript's own
    // type checker already rejects `new Symbol()`) — true on eslint 8.57.1
    // too, since that override lives in `@typescript-eslint`, not eslint.
    // Every file this repo lints is `.ts` (plain `.js` is globally
    // ignored), so the ts-eslint layer already reproduces the 8.57.1
    // effective state for those two rules without help; adding an
    // `'error'` here would just get silently reverted below and mislead a
    // future reader into thinking it does something.
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
    // Dead today (verified via `eslint --print-config` against
    // `packages/cli/src/index.ts`): `files` resolves relative to THIS
    // config file's own directory (the repo root), which has no literal
    // `src/` — every package's source lives one level down
    // (`packages/*/src/`), so this never matches. Ported byte-faithfully
    // rather than dropped or fixed — this migration's job is porting
    // syntax, not auditing rule content (AC-9).
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/test/**/*'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
  },
  {
    // Unlike the override above, this one DOES apply repo-wide — the
    // `**/` prefix matches regardless of the config file's own directory
    // (verified via `eslint --print-config` against
    // `packages/cli/src/cli.test.ts`: `no-explicit-any` off, `env.jest`
    // true in the effective eslintrc config).
    files: ['**/*.test.ts', 'src/test/**/*'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]);
