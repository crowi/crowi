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
`katex/dist/katex.min.css`. The web side imports the CSS at the top
of `packages/web/src/app/globals.css`:

```css
@import 'katex/dist/katex.min.css';
```

KaTeX webfonts download lazily on first math render.

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
pnpm --filter @crowi/dev-runner add @crowi/plugin-renderer-katex
# or in a standalone runner:
npm install @crowi/plugin-renderer-katex
```

The web side also needs `katex` (for the CSS asset):

```bash
pnpm --filter @crowi/web add katex
```

(For the bundled dev-runner this is already wired.)

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
