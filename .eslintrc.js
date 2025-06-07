module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint',
    'prettier'
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier'
  ],
  rules: {
    'prettier/prettier': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/ban-ts-comment': 'warn',
    '@typescript-eslint/no-var-requires': 'warn'
  },
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module'
  },
  overrides: [
    {
      files: ['src/**/*.ts'],
      excludedFiles: ['**/*.test.ts'],
      parserOptions: {
        project: './tsconfig.json'
      }
    },
    {
      files: ['**/*.test.ts'],
      env: {
        jest: true
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off'
      }
    }
  ],
  env: {
    node: true,
    es6: true,
    jest: true
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    'tmp/',
    '*.js',
    '!.eslintrc.js',
    '!jest.config.js',
    '*.d.ts'
  ]
};