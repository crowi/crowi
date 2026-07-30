# @crowi/plugin-renderer-katex

KaTeX math renderer for Crowi 2.x. Parses `$inline$` and `$$display$$`
LaTeX via [`remark-math`](https://github.com/remarkjs/remark-math) and
renders each math node to HTML via
[`katex.renderToString`](https://katex.org/docs/api).

No I/O. No cache (every save re-renders).

## What it does

Given a page body containing:

```markdown
The Pythagorean theorem: $a^2 + b^2 = c^2$.

Display style:

$$
\int_0^1 x \,dx = \frac{1}{2}
$$
```

The plugin emits the corresponding `<span class="katex-inline">…</span>`
and `<div class="katex-block">…</div>` wrappers carrying the KaTeX-
generated HTML.

### KaTeX CSS

KaTeX's HTML output references `class="katex"` rules that ship in
`katex/dist/katex.min.css`. The plugin self-serves this CSS (and the
webfonts it references) instead of requiring `@crowi/web` to carry a
`katex` dependency or a global CSS import:

- At build time, `scripts/copy-katex-assets.mjs` (a `tsup` `onSuccess`
  hook) copies `katex/dist/katex.min.css` and its referenced font
  files from the installed `katex` package into this plugin's own
  `dist/assets/`.
- `registerRoutes` mounts `GET /api/plugins/@crowi/plugin-renderer-katex/katex.min.css`
  and a `fonts/:filename` route for each font, both public
  (unauthenticated), serving directly from the in-memory copy of
  those built-in assets — no filesystem path is built from the
  request, so there is no path-traversal surface.
- `registerRenderer` advertises the CSS path via
  `registry.addStylesheet(...)`. The API publishes it in
  `GET /api/app/info`'s `rendererStylesheets` array once (and only
  once) `registerRoutes` above has succeeded, so the manifest never
  advertises an unreachable path.
- The web app's `RendererStylesheets` component reads that manifest
  and injects a `<link rel="stylesheet">` resolved against the
  runtime API origin (`resolveApiUrl`), the same origin resolver the
  rest of the API client uses. No web-side build step or dependency
  is required.

If the API and Web apps are deployed on different origins, make sure
the API's CORS policy allows the Web origin (`CLIENT_URL`, already
the default) and that any deployment CSP on the Web app allows the
API origin in `style-src` and `font-src` — see
`apps/crowi-site/content/docs/{ja,en}/operations/configuration.mdx`.

### Strict mode

Both renderers pass `strict: 'ignore'` + `throwOnError: false` to
KaTeX. Malformed LaTeX falls back to a red error frame in the
rendered HTML without crashing the page.

### Trust mode

`trust` is left at its KaTeX default (`false`). `\href` and other
trust-gated commands are inert. Phase 6 does NOT expose a config
toggle for this — the security trade-off is subtle and an
operator-misconfiguration could enable JS injection. Phase 7+ may
add a per-plugin admin option if real demand arrives.

## Install

Bundled in the Crowi monorepo:

```bash
pnpm --filter @crowi/api add -D @crowi/plugin-renderer-katex
# or in a standalone runner:
npm install @crowi/plugin-renderer-katex
```

No web-side install step is required — the plugin self-serves its
CSS/font assets from its own public route (see "KaTeX CSS" above),
so `@crowi/web` never needs a `katex` dependency.

## Configure

### Enable in `crowi.config.json`

```jsonc
{
  "plugins": [
    "@crowi/plugin-renderer-katex"
  ]
}
```

A server restart is required for plugin-list changes.

### Per-plugin config

None — the plugin uses vanilla KaTeX with sensible defaults baked
in at registration time.

## Out of scope (Phase 6)

- KaTeX macros / `\newcommand` user-defined commands — vanilla KaTeX
  standard commands only.
- MathJax compatibility — `\[ \]` / `\( \)` delimiters not parsed.
- Inline `trust` opt-in — disabled by default for security.
- Per-org / per-page enable toggle — Phase 7+.

## See also

- [`remark-math`](https://github.com/remarkjs/remark-math) — upstream
  parser that emits `math` / `inlineMath` mdast nodes.
- [KaTeX docs](https://katex.org/) — supported commands.
- RFC-0002 §"Phase 6 — bundled renderer plugins" for the design
  rationale.
