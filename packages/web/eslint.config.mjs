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
