# @crowi/svg-sanitize

Private, internal DOM-based SVG sanitizer shared by
`@crowi/plugin-renderer-mermaid` and `@crowi/plugin-renderer-plantuml`. Not a
renderer plugin itself — a policy-parameterised `sanitizeSvg` function + test
vectors, consumed as a workspace dependency.

## This package is never published

`private: true`, and listed in `.changeset/config.json`'s `ignore` array.
It exists purely so the sanitizer implementation and its test vectors live
in one place instead of being duplicated per renderer plugin — every
consumer bundles the compiled output into its own `dist` at build time
(`tsup`'s `noExternal: ['@crowi/svg-sanitize']`, set in each consumer's
`tsup.config.ts`) rather than depending on it at runtime. A published
package under `@crowi/` would otherwise sit in the plugin namespace
(`plugin-renderer-*`) despite not being something an operator can list in
`crowi.config.json`'s `plugins` array, and would need its own npm release
cadence for what is, in practice, an implementation detail of its two
consumers.

Because of this, the workspace dependency on `@crowi/svg-sanitize` lives in
each consumer's `devDependencies`, never `dependencies` — the published
tarball must not declare a runtime dependency on a package that does not
exist on npm. `@xmldom/xmldom` (the one runtime dependency this package's
`sanitize.ts` actually needs, for `DOMParser` / `XMLSerializer`) is
deliberately **not** bundled the same way: each consumer declares its own
`dependencies` entry on it, so an operator can address an `@xmldom/xmldom`
CVE via their own lockfile/overrides without waiting on a Crowi release.

## Bundling means duplication — and a two-package release obligation

This code is bundled into consumer dist. Changes require re-publishing all
packages that bundle it.

Because the compiled sanitizer is inlined into both
`@crowi/plugin-renderer-mermaid`'s and `@crowi/plugin-renderer-plantuml`'s
`dist`, **any change to this package's behaviour (a policy tweak, a bug
fix, a new test vector that changes sanitized output) requires bumping and
re-publishing both consumer packages**, not just this one. This duplication
is an accepted tradeoff, not an oversight — do not "fix" it by making one
consumer depend on the other's dist, or by re-introducing a runtime
dependency on this package.

When you change anything under `src/`, add a changeset for both
`@crowi/plugin-renderer-mermaid` and `@crowi/plugin-renderer-plantuml`
(both packages already flow through the monorepo's normal changeset
process, so bumping both together is the natural default, not extra work).

## Local development

```bash
pnpm --filter @crowi/svg-sanitize test
pnpm --filter @crowi/svg-sanitize build   # regenerates dist/ that consumers bundle
```

`pnpm build` at the repo root (or building `@crowi/plugin-renderer-mermaid`
/ `@crowi/plugin-renderer-plantuml` directly) builds this package first via
Turborepo's `^build` dependency graph, since both consumers still resolve
it as a workspace package during their own `tsup` build.
