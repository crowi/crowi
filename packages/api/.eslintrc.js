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
  ],
  env: {
    node: true,
    es6: true,
    jest: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', 'tmp/', '*.js', '!.eslintrc.js', '!jest.config.js', '*.d.ts'],
};
