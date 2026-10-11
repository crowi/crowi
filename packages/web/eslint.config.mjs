import nextPlugin from "@next/eslint-plugin-next";
import eslintReact from "@eslint-react/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const SOURCE_FILES = ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"];

const eslintConfig = defineConfig([
  {
    files: SOURCE_FILES,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  nextPlugin.configs["core-web-vitals"],
  { ...reactHooks.configs.flat.recommended, files: SOURCE_FILES },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": [
        "warn",
        { allowShortCircuit: false, allowTernary: false, allowTaggedTemplates: false },
      ],
    },
  },
  {
    files: SOURCE_FILES,
    plugins: { "@eslint-react": eslintReact },
    rules: {
      "@eslint-react/no-missing-key": "error",
      "@eslint-react/jsx-no-children-prop": "error",
      "@eslint-react/dom-no-dangerously-set-innerhtml-with-children": "error",
      "@eslint-react/jsx-no-comment-textnodes": "error",
      "@eslint-react/no-missing-component-display-name": "error",
    },
  },
  {
    // feature-radix-upgrade-and-single-source: Radix primitives must be
    // imported from the `radix-ui` meta package only. A direct
    // `@radix-ui/react-*` import pulls a second, independently-versioned
    // copy of shared internals (eg. `@radix-ui/react-dismissable-layer`)
    // into the graph, which can split the module-local overlay body-lock
    // registry and leave `document.body.style.pointerEvents` stuck at
    // `none` after closing a dialog (see `dda4ba72`). `src/eslint-radix-
    // import-guard.test.ts` drives this real rule through the ESLint Node
    // API so a future edit that narrows or removes it fails a test.
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@radix-ui/react-*"],
              message:
                "Import Radix primitives from the `radix-ui` meta package instead of a direct `@radix-ui/react-*` package.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    // Next build output and generated typings:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // packages/e2e's dedicated dev-server distDir (NEXT_DIST_DIR, see
    // next.config.ts) — same generated Next.js build output as `.next/**`
    // above, just under a different directory name so it doesn't collide
    // with a concurrently running `pnpm dev`. Without this, linting this
    // package after running `pnpm --filter @crowi/e2e e2e` locally floods
    // the report with thousands of false positives from minified vendor
    // bundle chunks.
    ".next-e2e/**",
    // Paraglide JS generated output. Each emitted file starts with
    // `/* eslint-disable */`, but our config raises every rule it would
    // disable to "off" by default, leaving ~320 "Unused eslint-disable
    // directive" warnings that are pure noise. `**/paraglide/**` so the
    // ignore catches stray outputs (e.g. `src/paraglide/` from a typo'd
    // `--outdir` flag) too.
    "**/paraglide/**",
    // scripts/paraglide-compile.mjs's own bookkeeping dir — `staging/` holds
    // the same generated-output shape as `paraglide/` above (same noise),
    // and none of `.paraglide-meta/` is source anyway.
    "**/.paraglide-meta/**",
  ]),
]);

export default eslintConfig;
