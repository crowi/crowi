import nextPlugin from '@next/eslint-plugin-next';
import eslintReact from '@eslint-react/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SOURCE_FILES = ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'];

const eslintConfig = defineConfig([
  {
    files: SOURCE_FILES,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  nextPlugin.configs['core-web-vitals'],
  { ...reactHooks.configs.flat.recommended, files: SOURCE_FILES },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-unused-expressions': [
        'warn',
        { allowShortCircuit: false, allowTernary: false, allowTaggedTemplates: false },
      ],
    },
  },
  {
    files: SOURCE_FILES,
    plugins: { '@eslint-react': eslintReact },
    rules: {
      '@eslint-react/no-missing-key': 'error',
      '@eslint-react/jsx-no-children-prop': 'error',
      '@eslint-react/dom-no-dangerously-set-innerhtml-with-children': 'error',
      '@eslint-react/jsx-no-comment-textnodes': 'error',
      '@eslint-react/no-missing-component-display-name': 'error',
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', '.source/**']),
]);

export default eslintConfig;
