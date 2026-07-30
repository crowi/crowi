---
"@crowi/plugin-renderer-katex": major
---

BREAKING: the KaTeX stylesheet manifest path (`STYLESHEET_MANIFEST_PATH`, what `registry.addStylesheet(...)` advertises and what `RendererStylesheets` renders into a `<link href>`) moves from `/api/v2/plugins/@crowi/plugin-renderer-katex/katex.min.css` to `/api/plugins/@crowi/plugin-renderer-katex/katex.min.css`, following the api-wide `/api/v2` → `/api` prefix cutover. Bumping this package alone is not required before the cutover — `@crowi/api`'s `renderer/registry.ts` validator dual-accepts both prefixes for a transitional period and normalizes a legacy-prefixed path to canonical before publishing it, so an unbumped install keeps rendering KaTeX correctly. Bump to pick up the canonical prefix once your runner has also upgraded `@crowi/api` past the cutover.
