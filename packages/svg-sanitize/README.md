# @crowi/svg-sanitize

Private, internal DOM-based SVG sanitizer. Not a renderer plugin itself — a
policy-parameterised `sanitizeSvg` function (+ `extractSvgDimensions`) and its
test vectors.

## This package is never published, and has exactly one consumer

`private: true`, and listed in `.changeset/config.json`'s `ignore` array. A
published package under `@crowi/` would sit in the plugin namespace
(`plugin-renderer-*`) despite not being something an operator can list in
`crowi.config.json`'s `plugins` array, and would need its own npm release
cadence for what is, in practice, an implementation detail.

**`@crowi/plugin-api` is the only package that may depend on this one.** It
inlines the compiled output into its own `dist` at build time (`tsup`'s
`noExternal`, see that package's `tsup.config.ts`) and re-exports `sanitizeSvg`
/ `extractSvgDimensions` from `src/svg.ts`. Everything else — core
(`@crowi/api`) and every renderer plugin — imports them from
`@crowi/plugin-api`.

That indirection is not ceremony. Core builds with `tsc`, which does not bundle,
so it cannot inline a private workspace package at all; a direct dependency
would make the published `@crowi/api` declare a dependency that does not exist
on npm, and `changeset` correctly refuses to release in that state. Routing
through the SDK is also what the SDK is for: shared functionality the core
provides for plugins to use, so a third-party plugin needs nothing but
`@crowi/plugin-api` in its dependencies.

`@xmldom/xmldom` (the one runtime dependency `sanitize.ts` actually needs, for
`DOMParser` / `XMLSerializer`) is deliberately **not** inlined: it is a declared
`dependencies` entry of `@crowi/plugin-api`, so an operator can address a CVE in
it via their own lockfile/overrides without waiting on a Crowi release.

## What to do when you change this package

The compiled sanitizer is inlined into `@crowi/plugin-api`'s `dist`, so **a
behaviour change here (a policy tweak, a bug fix, a test vector that changes
sanitized output) requires bumping and re-publishing `@crowi/plugin-api`** —
consumers pick it up through their existing dependency on that package. Add a
changeset for `@crowi/plugin-api` when you change anything under `src/`.

Do not add a second inlining site. Earlier this package was inlined separately
into each renderer plugin, which meant every consumer had to be re-published on
every change and multiple copies were in circulation; consolidating on the SDK
removed that. In particular, do not give any other package a `dependencies`
entry on `@crowi/svg-sanitize`, and do not make one consumer depend on
another's `dist`.

## Local development

```bash
pnpm --filter @crowi/svg-sanitize test
pnpm --filter @crowi/svg-sanitize build   # regenerates the dist/ plugin-api inlines
```

`pnpm build` at the repo root (or building `@crowi/plugin-api` directly)
builds this package first via Turborepo's `^build` dependency graph, since
`@crowi/plugin-api` resolves it as a workspace package during its own `tsup`
build. Core and the renderer plugins do not resolve it at all — they build
against `@crowi/plugin-api`'s output.

Note that `tsup`'s `noExternal` inlines runtime JS only. `@crowi/plugin-api`
also sets `dts: { resolve: ['@crowi/svg-sanitize'] }` so the emitted `.d.ts`
inlines the types; without it the declaration file keeps an `export ... from
'@crowi/svg-sanitize'` that no consumer of the published tarball can resolve.
