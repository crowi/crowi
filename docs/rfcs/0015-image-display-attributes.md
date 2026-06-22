# RFC-0015: Image display attributes (size / align / float / caption) + generic editor embed-affordance

- **Status**: Draft
- **Author**: (you)
- **Created**: 2026-06-22
- **Depends on**:
  - RFC-0002 (Renderer Plugin Architecture) — the markdown is parsed/rendered by
    the remark/mdast pipeline this RFC extends; `Revision.renderedAst` is where
    the typed image attributes persist.
  - RFC-0004 (Editor UX) — the CodeMirror editor the affordance tooltip mounts on.
  - RFC-0013 §8 (the "generic embed-affordance" — the *largest undesigned piece*).
    This RFC **implements that framework** and makes the image attribute panel its
    first built-in consumer, so the future Slack-embed affordance (RFC-0013 Phase
    E) plugs into the same surface.
- **Related**: RFC-0009 (renderedAst/yjsState storage; the persisted AST shape).

## §0 Summary

Add a markdown notation for controlling an embedded image's **display size,
alignment / float, and caption**, plus an **editor affordance** (a hover/inline
tooltip) that lets the user set those visually instead of memorizing syntax.

The key decisions are settled (with the user):

1. **Notation = Pandoc/MyST-style attribute block** `![alt](url){width=30% align=right}`
   (not the URL `#hash` 素案, not the Obsidian alt-pipe, not `=WxH`). Rationale in §3.
2. **Layout = block by default + opt-in float** — `align=` is block placement
   (no text wrap, predictable, mobile-safe); `float=` is the explicit, opt-in
   text-wrap that **degrades to block on narrow screens**. §4.
3. **Caption = alt-as-caption** (Pandoc figure semantics): an attributed image
   alone in a paragraph renders as `<figure>` with the alt text as `<figcaption>`.
   §4.3. (An explicit `caption="…"` is a documented future extension for when
   alt ≠ caption.)
4. **Editor = the generic embed-affordance framework now**, with the image panel
   as the first built-in consumer (§6). Plugins register their own affordances on
   the same surface; the Slack embed (RFC-0013 Phase E) becomes a consumer.

**Security is the load-bearing constraint**: the web renderer currently runs
**no `rehype-sanitize`** (plugin/markdown HTML is trust-based; only PlantUML
self-sanitizes). So image attributes must be a **closed whitelist of typed
values** that the renderer maps to a **constrained** set of classes / a
validated inline `width` — never a passthrough of arbitrary `style`/CSS. §5.

## §1 Background / Motivation

- Uploading an image inserts plain `![name](/api/v2/attachments/<id>)`
  (`packages/web/src/components/editor/upload-placeholder.ts:104-106`,
  `buildSuccessText`). There is **no way to size, place, or caption** it; large
  images dominate the page and there is no "small thumbnail floated right".
- Core markdown has no native image sizing. Every wiki/markdown tool that wants
  it adds an extension (§3 prior art). We want one that is **discoverable**
  (the user shouldn't have to memorize syntax) — hence the editor affordance.
- The user's framing: build the **generic** editor affordance (RFC-0013 §8)
  while we're here, so the image panel and future embed plugins share one surface
  rather than hard-coding image logic into the editor.

## §2 Goals / Non-Goals

### §2.1 Goals

- **Phase 1**: the attribute notation + renderer — block align, opt-in float,
  width (and optional height), alt-as-caption figure, parsed by the remark
  pipeline into typed attributes on the image node, rendered with whitelisted,
  validated styling. Works even when typed by hand.
- **Phase 2**: the **generic editor embed-affordance framework** + the **image
  built-in panel** (hover an image embed → set width/align/float/caption via a
  small GUI that rewrites the `{…}` block).
- **Phase 3**: plugins register their own affordances (the framework's payoff —
  RFC-0013 Phase E Slack embed consumes it).

### §2.2 Non-Goals

- **Grid / gallery (multiple images side-by-side)** — a separate "container"
  notation, deliberately out of scope; fix single-image display first (§3.4).
- **Arbitrary CSS / `style=` passthrough** — explicitly rejected for security (§5).
- **Per-image `height` as a layout driver** — supported but discouraged; default
  is width + intrinsic aspect ratio (`height: auto`).
- **Client-side image resizing / transforms** (server thumbnailing) — unrelated;
  this is display-only, the bytes are unchanged.
- **`#hash`-in-URL sizing** — evaluated and rejected (§3.2).

## §3 Notation design

### §3.1 Prior art (surveyed)

| Convention | Example | Used by |
|---|---|---|
| **Attribute block `{…}`** | `![beer](url){width=30% align=right}` | Pandoc, MyST, GitLab, kramdown |
| URL `#hash` | `![beer](url#w30:fright)` | Hugo (custom renderers) |
| alt-pipe | `![beer\|right\|30%](url)` | Obsidian, Discourse |
| `=WxH` | `![beer](url =300x200)` | HackMD, markdown-it-imsize |
| raw HTML `<img>` | `<img src=url width=…>` | GitHub (only option there) |

Captions: Pandoc renders an image **alone in a paragraph** as a `<figure>` with
the alt text as the caption; MyST has a `figure` directive; otherwise HTML
`<figure>/<figcaption>`.

### §3.2 Decision: attribute block (and why not the others)

**Chosen: `![alt](url){key=value …}`.** Reasons:

- **Extensible & uniform** — size, align, float, caption, and future flags all
  live in one place with one parser. The others special-case each concern.
- **alt preserved** — alt text (screen readers / SEO) stays the alt; it is *also*
  reused as the caption (§4.3) without being consumed by layout tokens (the
  alt-pipe's flaw).
- **Portable-ish** — Pandoc/MyST/GitLab interpret the same block; elsewhere it
  degrades to a literal `{…}` after the image (ugly but non-destructive). The
  `#hash` is Crowi-only.
- **Discoverability covers the cost** — "people won't memorize syntax" is real,
  but the §6 affordance writes the block for them; the syntax only needs to be
  *legible*, not *memorable*.

**Rejected — URL `#hash`** (the 素案): it has real prior art (Hugo) and the
fragment is a safe carrier (a browser drops `#…` before requesting an `<img>`
src, so it never reaches the server). But: (a) **Crowi-only / non-portable**;
(b) **collides with `#u=<uploadId>`**, which `upload-placeholder.ts:116-126`
already puts in the fragment to track the in-flight upload placeholder; (c)
caption-in-fragment (`…:c[beer]`) needs gnarly escaping for `]`/`:` inside the
URL. Rejected for (b)+(c) primarily.

**Rejected — alt-pipe** (`![beer|right|30%]`): consumes the alt text, so alt and
caption can't differ — an accessibility regression. **Rejected — `=WxH`**: only
expresses size; float/caption would need a *second* notation (the duplication we
want to avoid).

### §3.3 The attribute grammar (v1 whitelist)

A `{…}` block **immediately following** an image (no space, same paragraph):

```
![alt](url){ width=30% align=right }
![alt](url){ float=right width=200px }
![alt](url){ align=center width=50% }     ← alt becomes the caption (§4.3)
```

| Key | Values (whitelist) | Meaning |
|---|---|---|
| `width` | `<n>%` (1–100) or `<n>px` (≤ 4096) | display width; height defaults to `auto` |
| `height` | `<n>px` (≤ 4096) | optional; discouraged (breaks aspect ratio) |
| `align` | `left` \| `center` \| `right` | **block** placement, no text wrap |
| `float` | `left` \| `right` | opt-in text-wrap; degrades to block on narrow screens |

- **Whitespace-tolerant**, `key=value` separated by spaces. Unknown keys and
  out-of-range values are **dropped** (not an error) and the rest still applies.
- `align` and `float` are mutually exclusive; if both appear, `float` wins and a
  lint hint is surfaced in the editor.
- A future `caption="…"` and a future `.class` (from a *fixed* class allow-list)
  can extend this without changing the grammar.

### §3.4 Out of scope: grid (multi-image)

Side-by-side / gallery layout is a **container** concern (wrapping several
images), structurally different from per-image attributes. Deferred to a separate
RFC so single-image display ships first. The attribute block does not preclude it.

## §4 Renderer implementation (remark / mdast)

The pipeline is **remark-based** (`packages/api/src/renderer/pipeline.ts`:
`unified().use(remarkParse).use(remarkGfm)…`, `RENDERER_PIPELINE_VERSION`
`0.7.0` in `renderer/version.ts`). Images are standard mdast `image` nodes; core
transforms run in `renderer/core/index.ts` (headings → wikilinks → mentions →
code-blocks → syntax-highlight). No existing image hook.

### §4.1 Parse: a new core transform `core/image-attrs.ts`

remark-gfm does **not** parse `{…}`; the block lands as a `text` node right after
the `image` node. The transform walks the mdast and, for each `image` immediately
followed by a `text` starting with a `{…}` block:

1. Parse the block with a **strict, whitelist-only** parser (§3.3) → a typed bag.
2. Attach it to the image node as `data.imageDisplay = { width?, height?, align?, float?, caption? }` (validated/clamped values only).
3. **Strip** the consumed `{…}` from the following text node (leave any trailing text).
4. Malformed / non-attribute braces → leave the text untouched (no throw).

> A micromark *syntax extension* would be more robust than an mdast post-parse
> transform (it would tokenize `{…}` natively), but it is heavier and the
> post-parse transform is sufficient and localized. v1 uses the transform; the
> grammar is defined so a micromark extension could replace it later without a
> notation change. (Open Q1.)

Bumping `RENDERER_PIPELINE_VERSION` triggers the parse-on-read fallback
(RFC-0002) so existing pages re-render with the new transform.

### §4.2 Render: typed bag → constrained figure

The web tier renders mdast→hast→React (`render-mdast.ts`) with component
overrides; the `img` override is in `page-content.tsx:359-384` (today it spreads
props — see §5). New behaviour, keyed off `data.imageDisplay`:

- **block** (`align`, or no layout key): wrap in `<figure class="img-block img-align-{left|center|right}">` with the `<img>` carrying a **validated** `style={{ width, height }}` (only width/height, only the units in §3.3).
- **float** (`float`): `<figure class="img-float-{left|right}">`; CSS floats it and **a media query collapses it to block below a breakpoint** (no inline float style).
- **caption**: `<figcaption>` with the (escaped) caption text (§4.3).
- no `imageDisplay` → today's plain `<img>` (full back-compat).

All classes are **fixed, authored CSS** (Crowi theme), never user-derived.

### §4.3 Caption = alt-as-caption (figure)

When an attributed image **stands alone in a paragraph**, render `<figure>` +
`<figcaption>{alt}</figcaption>`; the alt stays the `<img alt>` too (caption and
alt coincide in v1). An inline image (mixed with text in a paragraph) keeps its
plain inline form with size/float but no figcaption. This matches Pandoc and
needs no new syntax. Explicit `caption="…"` (alt ≠ caption) is a future extension
(Open Q2).

## §5 Security (the load-bearing section)

The web renderer runs **no `rehype-sanitize`** — confirmed: `render-mdast.ts`
uses `toHast(allowDangerousHtml)` + `raw()` and trusts emitted HTML; only
`plugin-renderer-plantuml` self-sanitizes its SVG. And the current `img`
override **spreads `{...}` props** (`page-content.tsx:380`), which would forward
anything attached to the node.

Therefore:

- **Closed whitelist, typed values only.** `data.imageDisplay` holds *only*
  `width`/`height` (validated number + allowed unit, clamped), `align`/`float`
  (enum), `caption` (text). No `style`, no `class`, no `on*`, no arbitrary keys
  ever reach the node.
- **Validate at BOTH ends.** The api transform validates on parse; the web `img`/
  `figure` component **re-validates** before emitting `style`/className and
  **stops spreading arbitrary props** (reads the typed bag explicitly).
- **No inline float / arbitrary CSS** — float and align are *fixed classes*; only
  width/height become inline `style`, and only after numeric+unit validation.
- **Caption is text** — escaped, never HTML.

This keeps the attack surface to "a clamped width and an enum", even without a
global sanitizer (whose introduction is a larger, separate hardening — noted, not
required here).

## §6 Generic editor embed-affordance framework (RFC-0013 §8, realized)

Today the editor (`packages/web/src/components/editor/build-extensions.ts`) has
markdown + autocomplete + paste/drop, but **no hover/floating affordance and no
URL/notation matcher** (RFC-0013 §8 is RFC-only). This RFC builds it.

### §6.1 Surface

```ts
interface EditorAffordance {
  // Detect a target in the buffer (a matched range = where the tooltip anchors).
  match: (ctx: { doc: string; pos: number }) => { from: number; to: number } | null;
  // The floating UI shown for a match (image panel, "Embed this", …).
  render: (target: AffordanceTarget) => ReactNode;
}
function registerEditorAffordance(a: EditorAffordance): void;
```

- A CodeMirror extension scans the buffer / reacts to cursor-or-hover, runs the
  registered matchers, and mounts the winning affordance's `render()` in a
  floating tooltip anchored to the matched range.
- **Built-in consumers** are registered by the editor itself; **plugins** register
  through the plugin-api editor surface (new, mirrors the renderer SDK). The
  editor has **no per-feature (image / Slack) code** — only the registry + the
  floating host.

### §6.2 Image built-in consumer (the first one)

- `match`: an image embed with (or without) a `{…}` block.
- `render`: a small panel — **width** (slider / %/px toggle), **align** (L/C/R) /
  **float** (L/R) buttons, **caption** field — whose changes **rewrite the `{…}`
  block** in the document (an idempotent edit on the matched range). Setting
  nothing leaves a bare `![](…)`.
- This is what makes the notation **discoverable**: the user never types `{…}`.

### §6.3 Plugin consumers (the payoff)

A plugin declares `{ match: urlPattern, render: EmbedButton }` and the editor
shows it with zero editor changes — exactly RFC-0013 §8 / Phase E (paste a Slack
URL → "Embed this thread?" → rewrites to `@[slack](url)`). This RFC ships the
framework; RFC-0013 Phase E becomes a consumer.

## §7 Phasing

- **Phase 1** — notation + renderer: `core/image-attrs.ts` transform, typed
  `data.imageDisplay`, web `<figure>`/`<img>` constrained render, theme CSS
  (block align + float + figcaption + mobile degrade), `RENDERER_PIPELINE_VERSION`
  bump, tests (parse/validate/clamp/strip, render, security: no style/class
  leak). Ships hand-typed display control.
- **Phase 2** — editor framework + image panel: `registerEditorAffordance` +
  floating host CodeMirror extension; image consumer panel that rewrites `{…}`.
  Discoverability.
- **Phase 3** — plugin-api editor surface so plugins register affordances; first
  external consumer is RFC-0013 Phase E (Slack embed). (Can land independently.)

## §8 Compatibility / migration

- **Back-compat**: images without `{…}` render exactly as today (the transform
  is a no-op on them). The pipeline-version bump re-renders existing pages
  through the new (no-op-for-them) transform.
- **No fragment usage** — `#u=<uploadId>` (upload placeholder) is untouched.
- **Degrade elsewhere**: pasted into GitHub the `{…}` shows as literal text after
  the image (non-destructive); Pandoc/MyST/GitLab interpret it.
- **No data-loss surface** — this is render-time only; the markdown body is the
  source of truth (the `{…}` is plain text in the body).

## §9 Open questions

1. **Parser layer**: mdast post-parse transform (v1, simple) vs a micromark
   syntax extension (robust, heavier). Recommend transform for v1; grammar is
   stable either way.
2. **Explicit `caption="…"`** (alt ≠ caption): add now or defer? Recommend defer
   (alt-as-caption covers the common case; quoting/escaping inside `{…}` is the
   only cost).
3. **`.class` allow-list** (e.g. `{.rounded .shadow}` from a *fixed* set): nice
   extensibility, but every added class is theme + security surface. Defer.
4. **Float breakpoint** — the width below which `float` collapses to block
   (theme decision; e.g. < 480px).
5. **Affordance trigger** — hover vs cursor-in-range vs a gutter marker. Phase-2
   UX detail; affects how intrusive the panel feels.
6. **Plugin editor-SDK shape** (Phase 3) — how a plugin ships a React tooltip
   into the web editor (the renderer SDK ships transforms, not React) — the
   genuinely new plumbing, designed at Phase 3 start (ties to RFC-0013 §8 memo).

## §10 References

- Code: `packages/api/src/renderer/pipeline.ts` (remark pipeline),
  `packages/api/src/renderer/core/index.ts` (core transform order; where
  `image-attrs` slots in), `packages/api/src/renderer/version.ts`
  (`RENDERER_PIPELINE_VERSION`),
  `packages/web/src/components/editor/render-mdast.ts` (mdast→hast→React; no
  sanitize), `packages/web/src/components/page-view/page-content.tsx:359-384`
  (the `img` override that must stop spreading props),
  `packages/web/src/components/editor/build-extensions.ts` (where the affordance
  extension mounts), `packages/web/src/components/editor/upload-placeholder.ts`
  (`buildSuccessText`; `#u=` fragment use).
- RFCs: RFC-0002 (renderer/renderedAst), RFC-0004 (editor), RFC-0013 §8 + Phase E
  (the generic embed-affordance this RFC implements; Slack embed consumer),
  RFC-0009 (renderedAst storage).
- Prior art: [MyST images/figures](https://myst-parser.readthedocs.io/en/latest/syntax/images_and_figures.html),
  [URL-fragment sizing (Tek's Domain)](https://teknikaldomain.me/code/markdown-image-sizes/),
  [@mdit/plugin-img-size](https://mdit-plugins.github.io/img-size.html),
  [Markdown image alignment guide](https://blog.markdowntools.com/posts/markdown-image-alignment-positioning-complete-guide).
