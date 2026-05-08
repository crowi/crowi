import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Paraglide JS generated output. Each emitted file starts with
    // `/* eslint-disable */`, but our config raises every rule it would
    // disable to "off" by default, leaving ~320 "Unused eslint-disable
    // directive" warnings that are pure noise.
    "paraglide/**",
  ]),
]);

export default eslintConfig;
