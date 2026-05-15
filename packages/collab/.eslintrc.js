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
  ],
  env: {
    node: true,
    es6: true,
    jest: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', 'tmp/', '*.js', '!.eslintrc.js', '*.d.ts'],
};
