import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Self-contained (dependency-free) rule enforcing kebab-case source
// filenames. The whole web tree is kebab-case (see `components/`,
// `lib/`, `app/`); this keeps AI-generated / hand-authored files from
// drifting back into PascalCase (e.g. `MarkdownEditor.tsx`). Only the
// first dot-delimited segment is checked so compound extensions like
// `foo.test.tsx` / `next.config.ts` are handled. React component files
// still export PascalCase symbols — only the filename must be kebab.
const filenamePlugin = {
  rules: {
    "kebab-case-filename": {
      meta: {
        type: "suggestion",
        docs: { description: "Enforce kebab-case source filenames" },
        schema: [],
        messages: {
          notKebab:
            'Filename "{{name}}" is not kebab-case. Rename to "{{suggested}}" (lowercase words separated by hyphens).',
        },
      },
      create(context) {
        return {
          Program(node) {
            const filename = context.filename ?? context.getFilename?.();
            if (!filename || filename === "<input>" || filename === "<text>")
              return;
            const base = filename.split(/[/\\]/).pop() ?? "";
            const seg = base.split(".")[0];
            if (seg === "" || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(seg)) return;
            const kebab = seg
              .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
              .replace(/[_\s]+/g, "-")
              .toLowerCase();
            context.report({
              node,
              messageId: "notKebab",
              data: { name: base, suggested: base.replace(seg, kebab) },
            });
          },
        };
      },
    },
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Enforce kebab-case filenames across the source tree.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { local: filenamePlugin },
    rules: { "local/kebab-case-filename": "error" },
  },
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
