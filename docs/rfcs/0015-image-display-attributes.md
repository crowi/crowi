# RFC-0015: Image display attributes (size / align / float / caption) + generic editor embed-affordance

- **Status**: Draft
- **Author**: @sotarok
- **Created**: 2026-06-22
- **Depends on**:
  - RFC-0002 (Renderer Plugin Architecture) — the markdown is parsed/rendered by
    the remark/mdast pipeline this RFC extends; `Revision.renderedAst` is where
    the typed image attributes persist.
  - RFC-0004 (Editor UX) — the CodeMirror editor the affordance tooltip mounts on.
  - RFC-0013 §12 Decision #8 + §7.5 + §11 Phase E (the "generic embed-affordance"
    — RFC-0013 calls it "the largest undesigned piece"). This RFC **implements
    that framework** and makes the image attribute panel its first built-in
    consumer, so the future Slack-embed affordance (RFC-0013 Phase E) plugs into
    the same surface.
- **Related**: RFC-0009 (renderedAst/yjsState storage; the persisted AST shape).

## §0 Summary

Add a markdown notation for controlling an embedded image's **display size,
alignment / float, and caption**, plus an **editor affordance** (a hover/inline
tooltip) that lets the user set those visually instead of memorizing syntax.

The key decisions are settled:

1. **Notation = Pandoc/MyST-style attribute block** `![alt](url){width=30% align=right}`.
   Rationale and alternatives considered in §3.
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
self-sanitizes), and the attributes have to travel as `data.hProperties` /
`data.hChildren` (the only mdast→hast channel `toHast` honours — §4.1), which
are spread straight onto the DOM. So the **API transform is the sole validator**:
it emits the figure as a **container node** (a fixed className `hProperties`, no
inherited `src`/`alt`) whose `hChildren` are the `<img>` (carrying `src`/`alt` +
a single clamped `width` declaration) and an optional `<figcaption>` — never a
raw `style`/CSS string — and the web side allow-lists exactly the props it
forwards rather than spreading them. §5.

## §1 Background / Motivation

- Uploading an image inserts plain `![name](/api/v2/attachments/<id>)`
  (`packages/web/src/components/editor/upload-placeholder.ts:104-106`,
  `buildSuccessText`). There is **no way to size, place, or caption** it; large
  images dominate the page and there is no "small thumbnail floated right".
- Core markdown has no native image sizing. Every wiki/markdown tool that wants
  it adds an extension (§3 prior art). We want one that is **discoverable**
  (the user shouldn't have to memorize syntax) — hence the editor affordance.
- Build the **generic** editor affordance (RFC-0013 §12 Decision #8) now,
  rather than hard-coding image logic into the editor, so the image panel and
  future embed plugins share one surface.

## §2 Goals / Non-Goals

### §2.1 Goals

- **Phase 1**: the attribute notation + renderer — block align, opt-in float,
  width (and optional height), alt-as-caption figure, parsed by a remark-pipeline
  transform that validates the attributes and **emits the figure directly as
  `hName`/`hProperties`/`hChildren`** (the only mdast→hast channel that survives,
  §4.1), rendered with whitelisted styling on the web. Works even when typed by
  hand.
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
- **Portable notation, non-portable parser** — the *notation* `![alt](url){…}`
  is shared with Pandoc / MyST / GitLab, so a body authored in Crowi reads
  correctly when pasted into those tools (and elsewhere degrades to a literal
  `{…}` after the image — ugly but non-destructive to the body); the `#hash`
  alternative is Crowi-only even at the notation level. **But Crowi's *parser* is
  not Pandoc's**: Crowi's pipeline ships only `remarkParse` + `remarkGfm` +
  `remarkBreaks` (`pipeline.ts:289-302`) with **no** bracketed-span / generic-
  attribute remark plugin, so image-attrs is a **bespoke adjacent-`text`-node
  heuristic** (§4.1.2). It deliberately diverges from Pandoc/MyST on the hard
  cases — split inline nodes, reference-style images, attributes after a non-text
  sibling — which those tools' real grammars handle. So **round-tripping is not
  guaranteed**: the *common* `{width=… align=…}` case is portable both ways, but
  Crowi may leave a block literal that Pandoc would have parsed (or vice-versa).
  We accept that: matching Pandoc's full attribute grammar is the micromark-
  extension upgrade (Open Q1), not a v1 goal.
- **Discoverability covers the cost** — "people won't memorize syntax" is real,
  but the §6 affordance writes the block for them; the syntax only needs to be
  *legible*, not *memorable*.

**Rejected — URL `#hash`**: it has real prior art (Hugo) and the
fragment is a safe carrier (a browser drops `#…` before requesting an `<img>`
src, so it never reaches the server). But: (a) **Crowi-only / non-portable**;
(b) a **transient** brush with `#u=<uploadId>` — `upload-placeholder.ts:116-126`
puts that in the fragment only while the upload is in flight, and on success
`buildSuccessText` (`upload-placeholder.ts:104-107`) replaces the placeholder
with a fragment-free `![name](url)`, so it is **not a steady-state conflict**
(a sizing-hash and an upload-id hash never coexist on a settled link); (c)
caption-in-fragment (`…:c[beer]`) needs gnarly escaping for `]`/`:` inside the
URL. **Rejected primarily on (a) non-portability + (c) caption-escaping**; (b)
is a minor, transient wrinkle, not the deciding factor.

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

The pipeline is **remark-based** (`packages/api/src/renderer/pipeline.ts:289-302`:
`unified().use(remarkParse).use(remarkGfm)…` + external plugins + `remarkBreaks`,
`RENDERER_PIPELINE_VERSION` `0.7.0` in `renderer/version.ts`). Images are standard
mdast `image` nodes; core transforms run in their fixed order in
`renderer/core/index.ts:46` (`buildCorePlugins`: headings → wikilinks → mentions →
code-blocks → syntax-highlight). No existing image hook.

**`core/image-attrs` is inserted into `buildCorePlugins` BEFORE wikilinks and
mentions** (placement requirement in §4.1.1 — it is load-bearing for the
matching predicate, not cosmetic).

### §4.1 Parse + emit: a new core transform `core/image-attrs.ts`

> **Render transport — read this first.** The persisted AST is replayed on the
> web by `render-mdast.ts`, which calls `toHast(renderedAst, {
> allowDangerousHtml: true })` → `raw()` → `toJsxRuntime(…, { passNode: false })`.
> `mdast-util-to-hast` honours **only** the standard mdast→hast hooks —
> `data.hName` (override the element tag), `data.hProperties` (its attributes),
> `data.hChildren` (its hast children) — and **drops every other `data.*`
> field**. A custom `data.imageDisplay` bag therefore **never reaches React**
> (and `passNode: false` means there is no `node` prop to recover it from
> either). This is exactly the channel headings (`data.hProperties.id`,
> `core/headings.ts:40-41`), mentions (`data.hProperties.className`,
> `core/mentions.ts:84`) and wikilinks (`core/wikilinks.ts:100-110`) already use.
> So the transform must **emit the rendered shape directly via `hName` /
> `hProperties` / `hChildren`**, not stash typed attributes for the web to
> interpret. (This corrects the earlier `data.imageDisplay` design, which would
> have rendered nothing.)

remark-gfm does **not** parse `{…}`; the block lands as a `text` node right after
the `image` node. The transform walks the mdast and, for each `image` whose
attribute block can be matched (predicate in §4.1.2):

1. **Parse + validate** the block with a **strict, whitelist-only** parser
   (§3.3): whitelist the `align`/`float` enums, clamp `width`/`height` to the
   allowed range + unit, take the caption as plain text. Unknown keys / out-of-
   range values are dropped. This step is the **sole validator** (§5).
2. **Rewrite the image into a figure container** by stamping the standard hooks.
   The values below are *only ever* the validated outputs of step 1.

   > **Node-shape pitfall (must avoid).** A node left as `type: 'image'` with
   > merely `data.hName = 'figure'` does **not** give the producer full control
   > of the figure's properties: `mdast-util-to-hast`'s `image` handler also
   > stamps the node's own `url`/`alt` onto the emitted element, so `hName`
   > only renames the tag and you get
   > `<figure src="/api/v2/attachments/…" alt="beer" class="…">` — stray `src`/
   > `alt` on the figure, and §5's "the transform emits ONLY a closed whitelist
   > of `hProperties`" would be literally false. To keep the producer in full
   > control, the transform **replaces the image node with a generic
   > container node that has no `url`/`alt` to inherit** — i.e. a node the
   > default hast conversion emits purely from `hName`/`hProperties`/`hChildren`
   > (the remark-directive / rehype `hName`-on-a-non-image convention). The
   > original image becomes an **`<img>` inside `hChildren`**, which is the only
   > element that should carry `src`/`alt`.

   - container node: `data.hName = 'figure'`, **no `url`/`alt`/image fields on
     the container** (so none are stamped onto `<figure>`).
   - `data.hProperties = { className: ['img-block', 'img-align-right'] }` — a
     **fixed** className array chosen from the §4.2 allow-list by the parsed
     `align`/`float`; never a user string. (The width does **not** go on the
     figure — see the `<img>` below.)
   - `data.hChildren = [ <img …>, <figcaption>…</figcaption>? ]` — the `<img>` is
     a hast element node carrying the original `src`/`alt` **plus** the single
     clamped width declaration `style: 'width:30%'` (built from the validated
     number+unit; see §5 for why this one inline `style` is safe), and the
     optional `<figcaption>` carries the **escaped** alt-as-caption text (§4.3).
   - When the image is **inline** (mixed with text, no caption — §4.3), the
     transform leaves the node a plain `image` and only adds the clamped width to
     its `hProperties` (so the inline `<img>` is sized but **not** figure-wrapped
     — also avoiding the §4.3 block-hoisting problem). In this inline case there
     is no figure, so the inherited-`src`/`alt` pitfall does not arise (an `<img>`
     *should* carry them).

   A **Phase-1 test asserts the emitted `<figure>` has no `src`/`alt` attribute**
   (only the fixed className), proving the container-node shape — so §5's
   whitelist claim is true at the producer, not merely patched by the web
   override.
3. **Strip** the consumed `{…}` substring from the following text node (leave any
   trailing text); if that empties the text node, drop it.
4. Malformed / non-attribute braces, or any unmatched predicate case (§4.1.2) →
   **leave the text untouched** (no throw), so the `{…}` renders as literal text.

> A micromark *syntax extension* would be more robust than an mdast post-parse
> transform (it would tokenize `{…}` natively, dissolving most of the §4.1.2
> risk cases), but it is heavier and the post-parse transform is sufficient and
> localized. v1 uses the transform; the grammar is defined so a micromark
> extension could replace it later without a notation change. (Open Q1.)

Bumping `RENDERER_PIPELINE_VERSION` (minor → `0.8.0`) makes **newly-saved /
re-saved** revisions carry the new transform's output; the read-path version
check re-renders a stored AST only when its stamped version *mismatches* — see
§8 for the exact (narrower-than-it-sounds) blast radius.

### §4.1.1 Core-order requirement (load-bearing): image-attrs runs FIRST

The §4.1.2 predicate keys on "the `{` at the **start of the immediately-following
single `text` node**". That invariant is destroyed if any *text-splitting*
transform runs on the brace text node **before** image-attrs:

- `remarkWikiLinks` and `remarkMentions` both walk `text` nodes and **split one
  `text` node into several** at a `[[…]]` / `@username` match (`core/mentions.ts:64-75`
  rebuilds `[before-text, link, after-text]`; wikilinks does the same at
  `core/wikilinks.ts:59-82`). If either fires on the brace text node first, the
  `{…}` substring is no longer a single leading-`{` text node and image-attrs
  silently fails to match.

Therefore `core/image-attrs` **MUST be inserted at the FRONT of the
`buildCorePlugins` list** (`renderer/core/index.ts:46`), running **before**
wikilinks/mentions — for the same class of reason headings runs first today (the
order rationale at `core/index.ts:27-38`: a transform that depends on *pristine*
text must precede the transforms that rewrite text). New core order:
`image-attrs → headings → wikilinks → mentions → code-blocks → syntax-highlight`.
(image-attrs before headings is harmless — they touch disjoint node types — and
keeps "all text-shape-sensitive passes up front" as a single rule.)

> **Why this matters even though v1 looks safe.** The v1 grammar (`{width=…
> align=… float=…}`) contains no `@` or `[[`, so a v1 brace block would *survive*
> a mention/wikilink pass unsplit by luck. But (a) relying on "the attribute
> payload never contains a mention/wikilink trigger" is fragile, and (b) the
> deferred `caption="@bob ships it"` (Open Q2) **would** contain `@bob` and be
> split by `remarkMentions` mid-caption if image-attrs ran later. Pinning the
> order now removes a latent footgun the caption extension would step on.

A test MUST assert image-attrs matches `![a](/x){width=30%}` even when the same
paragraph also contains a `@mention` and a `[[wikilink]]` (proving the order, not
just the happy path) — see §4.1.2 and §7.

### §4.1.2 Matching predicate — failure modes & test enumeration

The "image immediately followed by an adjacent-brace text node" shape is the
fragile part. The predicate must **only** fire on the precise mdast it
understands and **degrade to leaving the text literal** everywhere else. Risk
cases to handle (and to pin as tests):

| Case | mdast reality | Required behaviour |
|---|---|---|
| **Inline `![alt](url){…}`** | `image` then `text` beginning `{…}` (same paragraph) | match → rewrite (the happy path) |
| **Reference-style `![alt][ref]{…}`** | `imageReference`, *not* `image`; the `{…}` may attach after definition resolution | predicate keys on node `type === 'image'` only → reference images **do not match** in v1 (documented limitation, not a crash) |
| **Image is the LAST child** (`…![alt](url)` ends the paragraph) | `image` with **no following sibling** | no `text` node to read → **no match**, image renders bare (no throw, no index-out-of-bounds) |
| **`{…}` split across a boundary** — e.g. `![a](u){width=*30%*}` where `*30%*` is emphasis, or the `{` and `}` land in different inline nodes | the brace run is **not a single adjacent `text` node** | predicate requires the *opening* `{` at the start of the immediately-following `text` node **and** the closing `}` within that same node → a split block **does not match** (renders literally) rather than half-parsing |
| **Nested braces / quotes** inside a future `caption="…"` (e.g. `{caption="a {b} c"}` or `caption="he said \"hi\""`) | brace-balancing inside a quoted value | the v1 grammar (§3.3) has **no `caption=`**, so v1 scans to the first `}`; the *future* `caption="…"` extension (Open Q2) MUST switch to a quote-aware scan before it ships — flagged here so it is not retrofitted naively |
| **Multiple images in one paragraph** `![a](u){…} text ![b](v){…}` | two `image`+`text` pairs | each pair evaluated independently; stripping the first `{…}` must not disturb the offset of the second (operate per-text-node, not on a paragraph-wide string) |
| **Brace block adjacent to a mention / wikilink** `![a](/x){width=30%} cc @bob see [[/y]]` | one `image`+`text` pair, then later `@bob` / `[[/y]]` in the **same paragraph** | matches **only because image-attrs runs before** wikilinks/mentions (§4.1.1): the brace text node is still un-split when image-attrs sees it; the `@bob`/`[[/y]]` are rewritten *after*, untouched by image-attrs. This row exists to pin the **order** (§4.1.1), not just adjacency. |

Worked examples:

- `![beer](/x){width=30% align=right}` *(alone in paragraph)* → figure,
  `className=['img-block','img-align-right']`, `<img style="width:30%">`,
  `<figcaption>beer</figcaption>`.
- `see ![beer](/x){width=30%} on tap` *(inline)* → **no** figure; inline `<img
  style="width:30%">`, `{width=30%}` stripped, surrounding text preserved.
- `![logo](/x){width=20%} ping @bob in [[/team]]` *(order test)* → image-attrs
  runs **first**: it matches `{width=20%}` at the start of the trailing text node
  (still un-split) and strips it; the *later* mention/wikilink passes then turn
  `@bob`→mention link and `[[/team]]`→wikilink on the **remaining** text,
  untouched by image-attrs. This proves both directions of §4.1.1: image-attrs
  must precede the splitters, and the splitters still work on what's left. The
  *acute* failure the order prevents is the deferred `caption="@bob ships it"`
  case — there the trigger sits **inside** the brace block, so a mention pass
  running first would split the very text node image-attrs needs to read, leaving
  `{width=20%}` (and the caption) unmatched.
- `![beer](/x)` *(last child, no brace)* → unchanged bare `<img>` (no match).
- `![beer](/x){bogus}` → text left literal (`{bogus}` parses to zero valid keys
  → step 4, no rewrite).

### §4.2 Render: the figure/width arrive as hast; the web only styles known props

Because §4.1 already emitted `hName='figure'` + `hProperties` + `hChildren`, the
hast that reaches `render-mdast.ts` **is** the figure — the web tier does not
re-derive layout from a typed bag (there is none to read). What the web side
provides is the **component overrides** that turn that hast into themed React
and, critically, the **allow-list of props each override forwards** (§5).

> **Two web render surfaces, not one — both must be updated.** The same
> transform output is rendered by **(a)** the show page (`page-content.tsx`'s
> `components` map) **and (b)** the live edit preview (`MarkdownPreview.tsx`'s
> separate `previewComponents` map, `MarkdownPreview.tsx:143`), which fetches the
> identical mdast via `POST /api/v2/pages/preview` (`MarkdownPreview.tsx:28-32`).
> Today **both** `img` overrides spread `{...props}` (`page-content.tsx:383`,
> `MarkdownPreview.tsx:255`) and **neither** has a `figure` override or
> attachment routing. Every §4.2 / §4.2.1 / §5 change below therefore applies to
> **both maps** — otherwise the figure renders unstyled in preview and the §5
> "no `{...props}` leak" hardening is only half-applied. (Preview has no
> click-to-open modal context, so its inner attachment image renders as a plain
> styled `<img>`, not `InlineAttachmentLink` — see §4.2.1.)

The overrides each map needs:

- **`figure` override** (new): renders `<figure>` with the validated
  className(s) the transform supplied, and the inner `<img>` / `<figcaption>`
  from `hChildren`. It forwards **only** `className` and (for the `<img>`) `src`
  / `alt` / the single clamped `width` style — it does **not** spread arbitrary
  props.
- **`img` override** (`page-content.tsx:359-384`, `MarkdownPreview.tsx:241-257`;
  both spread `{...props}` today): for an inline image with a width, forwards
  `src` / `alt` / className / the clamped width style, allow-listed (no
  `{...props}`).

The class semantics (all **fixed, authored CSS** in the Crowi theme, never
user-derived):

- **block** (`align`, or no layout key) → `figure.img-block.img-align-{left|center|right}`; the `<img>` carries the **validated** `width` (only width/height, only the §3.3 units), no float.
- **float** (`float`) → `figure.img-float-{left|right}`; CSS floats it and **a media query collapses it to block below a breakpoint** (no inline float style — only the width is ever inline).
- **caption** → `<figcaption>` with the (escaped) caption text (§4.3).
- image with no attribute block → today's plain `<img>` (full back-compat; the transform never touched its `data`).

### §4.2.1 Uploaded (attachment) images — the primary target — go through `InlineAttachmentLink`

The feature's main use case is the image the user just **uploaded**, which is
`![name](/api/v2/attachments/<id>)`. That does **not** hit the plain `<img>`
branch: `page-content.tsx:377-379` matches the attachment URL
(`extractAttachmentId`) and routes it into
`<InlineAttachmentLink variant="image" …>`, which renders its **own** `<img>`
(`inline-attachment-link.tsx:101-115`) with a fixed `className`, a hardcoded
`style={{ cursor: 'zoom-in' }}`, and a props interface (`…:60-69`) that has
**no width / align / caption / figure channel**. Left as-is, the entire feature
**does nothing for uploaded images** — the exact images it exists to size.

**Where the attachment branch happens — in the API transform, not the web
override.** The naive plan ("the `figure` override inspects `extractAttachmentId`
on the inner `<img>` `src`") **cannot work**: `mdast-util-to-hast` copies
`hChildren` verbatim into the hast tree, and by the time a React component
override runs, `toJsxRuntime(…, { passNode: false })` has **already converted the
inner `<img>` into rendered React children** — the override receives opaque
`children`, not an inspectable `{ tagName:'img', properties:{ src } }` node, and
`passNode:false` means there is no original node to read either. So the override
has nothing to branch on.

The decision is therefore made **in the API transform**, where the `src` string
is in hand:

- The transform calls the **same attachment matcher** `extractAttachmentId` uses
  today. The web copy lives in a `'use client'` module
  (`inline-attachment-link.tsx:1`) and cannot be imported server-side, so the
  bare URL→id matcher (`ATTACHMENT_URL_RE`, `inline-attachment-link.tsx:17`) is
  **lifted into a shared, framework-free helper** that both the transform and
  `extractAttachmentId` consume.
  - **This would be the FIRST framework-free *renderer* helper shared by api +
    web** — there is **no existing precedent to cite** (`@crowi/api-contract`
    today is schemas / contracts / errors only; anchor-id slugging is server-only
    in `core/headings.ts:23-41`, and the HTML strip lives web-side in
    `render-mdast.ts:78` — neither is a shared runtime helper). So this is a
    small new piece of shared surface, not "the established pattern".
  - **Default home (decided): a new runtime module in `@crowi/api-contract`.**
    Its tsup build already emits framework-free CJS + ESM runtime JS
    (`packages/api-contract/tsup.config.ts`), it is already a dependency of both
    api and web, and the matcher is pure string logic with no React/Mongoose
    coupling — so it fits without a new package. (Open Q7: confirm this vs (b) a
    web-importable module under `api/renderer` exported for web consumption, vs
    (c) a tiny dedicated shared pkg — chosen only if api-contract should stay
    contracts-pure. Default is (a).)
  - **The shared matcher MUST recognise BOTH attachment URL forms** that
    `ATTACHMENT_URL_RE` matches today — the current `/api/v2/attachments/<id>`
    **and the legacy `/files/<id>`** form still present in bodies saved before
    the migration. Lifting only the `/api/v2` arm would make legacy `/files/<id>`
    images **fall through to the plain-`<img>` branch and silently lose
    click-to-open-modal** when an existing page re-renders under `0.8.0` — a
    regression on old pages. A **Phase-1 test pins the legacy `/files/<id>` form**
    routes to `InlineAttachmentLink` exactly like the `/api/v2` form (§7).
- When the `src` is an attachment, the transform **emits a marker on the inner
  `<img>` hProperties** that survives to React as an ordinary prop:
  `data-attachment-id="<id>"` (a `data-*` attr — `passNode:false` explicitly
  keeps `data-*` flowing through the rest-props bag, `render-mdast.ts:191-193`).
  It is the *validated* id, not free-form.
- The web `figure` / `img` overrides then branch on **that prop** (which they
  *do* receive): if `data-attachment-id` is present, render
  `<InlineAttachmentLink variant="image" attachmentId={…} …>` for the inner
  image; otherwise a plain `<img>`. No `src`-reparsing in React.
- `InlineAttachmentLink`'s props are **extended** with an allow-listed display
  channel — `widthStyle?: string` (the single clamped `width:NN%`/`NNpx`
  declaration, already validated by the transform) — merged into its existing
  fixed className + `cursor: zoom-in` style. No new free-form `style`/`className`
  prop is added (§5): it accepts the *clamped width value*, not arbitrary CSS.
- The `<figcaption>` and the `img-block`/`img-float-*` wrapper come from the
  **figure** the transform emitted, so an attachment image gets the *same*
  figure / width / caption treatment as a plain-URL image; only the inner
  `<img>` element differs (it is the click-to-open attachment image). In the
  **preview** surface there is no `InlineAttachmentProvider` / modal, so the
  preview `figure`/`img` overrides ignore the marker and render the inner image
  as a plain styled `<img>` (the figure/width/caption still apply).

Net: width / align / float / caption **and the attachment-vs-plain decision** are
produced **once, in the API transform**. The web-side attachment-specific code is
reduced to "if the inner `<img>` carries `data-attachment-id`, render it as
`InlineAttachmentLink` (show page) / a plain styled `<img>` (preview), threading
the clamped width through" — a prop check, not a `src` re-parse across the
hast→React boundary.

### §4.3 Caption = alt-as-caption (figure)

When an attributed image **stands alone in a paragraph**, render `<figure>` +
`<figcaption>{alt}</figcaption>`; the alt stays the `<img alt>` too (caption and
alt coincide in v1). An inline image (mixed with text in a paragraph) keeps its
plain inline form with size/float but no figcaption. This matches Pandoc and
needs no new syntax. Explicit `caption="…"` (alt ≠ caption) is a future extension
(Open Q2).

**Block-hoisting artifact (`<p></p>` around the figure).** An image alone in a
paragraph is wrapped by remark in a `paragraph` → so the persisted AST is
`paragraph[ figure-container ]`. When `render-mdast.ts:180` runs `raw()`
(parse5), parse5 enforces the HTML content model: `<figure>` is **flow content,
not phrasing**, so it is **hoisted out of the `<p>`**, leaving
`<p></p><figure>…</figure>` (an empty paragraph before — and, if there was
trailing text, after). This is the same class of artifact any block element
(PlantUML's `<div>`) hits today. Two parts to the handling:

- It is **another reason the inline branch (§4.1.2) does not emit a figure**: an
  inline image stays an `<img>` (phrasing content), so it is *not* hoisted and
  leaves no orphan `<p>`. Only the stands-alone case wraps a figure, and there
  the surrounding paragraph held only the image anyway.
- The remaining **empty `<p></p>`** is cleaned: the figure-container transform
  (or a tiny hast pass alongside the existing `stripUnknownElements` /
  `escapeUnknownRawHtml` walkers in `render-mdast.ts:78-91`) drops a `paragraph`
  that became empty after its only child hoisted out. A **Phase-1 render test
  asserts no orphan empty `<p>` brackets the emitted `<figure>`** (§7).

## §5 Security (the load-bearing section)

The web renderer runs **no `rehype-sanitize`** — confirmed: `render-mdast.ts`
uses `toHast(…, { allowDangerousHtml: true })` + `raw()` and trusts the emitted
HTML; only `plugin-renderer-plantuml` self-sanitizes its SVG. **And the
attributes now travel as `hProperties` / `hChildren`** (§4.1, the only channel
`toHast` keeps), which `toJsxRuntime` spreads straight onto the DOM. The current
`img` override **spreads `{...props}`** in **both** render surfaces
(`page-content.tsx:383` *and* the edit preview `MarkdownPreview.tsx:255`, §4.2),
forwarding *anything* on the node. Worse for `style`: `hast-util-to-jsx-runtime`
does not pass a `style` *string* through — it **re-parses it via `style-to-js`
into a React style object** client-side, so a `properties.style` of
`"width:30%;display:none"` becomes `{ width:'30%', display:'none' }` and is
applied. So "the web re-validates" is **not possible** (once a value is in
`hProperties` it is already a render instruction), and the *only* defense against
a multi-declaration `style` is that **the producer never emits one**. The trust
boundary moves entirely to the API transform.

**The API transform is the SOLE validator.** It is the only place that sees the
raw `{…}` text, and it must emit **only known-good `hProperties` + `hChildren`**.
For that claim to be *literally* true the figure must be a **container node with
no `url`/`alt` to inherit** (§4.1 step 2) — otherwise `toHast` would stamp the
image's own `src`/`alt` onto the `<figure>` and the producer would **not** fully
control the figure's properties. With the container-node shape, the only
properties on the `<figure>` are the fixed className; the `src`/`alt` live on the
inner `<img>` where they belong. (The web override dropping unknown props, below,
is therefore defense-in-depth, not the thing that makes the figure correct.) The
producer emits:

- **Parse → whitelist → clamp → escape, then emit nothing else.**
  - `align` / `float` → matched against the fixed enum; the output is a **fixed
    className token** from the §4.2 allow-list (`img-align-left|center|right`,
    `img-float-left|right`, `img-block`) — *never* the user's string.
  - `width` / `height` → parsed to `number + unit`, unit ∈ {`%`,`px`}, range
    clamped (`%` 1–100, `px` ≤ 4096), then re-serialised by the transform via a
    **fixed template** — literally `` `${kind}:${clampedNumber}${literalUnit}` ``
    — yielding exactly **one declaration** (`width:30%`). The number is a parsed
    `number` (so it can only stringify as digits, never `;`/`}`/`url(`) and the
    unit is one of two literals; there is **no path** by which a second property,
    a `;`-chained declaration, `url(...)`, or `expression(...)` can appear in the
    output, even though the raw input string is attacker-controlled. **This is a
    REQUIRED Phase-1 unit test (§7): assert that no input — `width=30%;display:none`,
    `width=30%}` , `width=url(x)`, `width=10px;width=99px` — can make the
    serializer emit a string containing `;`, a second `:`, `url(`, or any second
    declaration; the parser must reject the malformed value and emit either a
    clean single declaration or nothing.** Because `style-to-js` re-parses this
    string client-side (see above), the single-declaration guarantee is the
    whole defense and must be pinned by test, not asserted.
  - caption → taken as **plain text**, HTML-escaped, emitted as the `<figcaption>`
    `hChildren` text node — never as markup.
  - **No `style` passthrough, no `class` passthrough, no `on*`, no arbitrary
    keys** ever enter `hProperties`. A raw `style`/CSS string never crosses the
    boundary in either direction.
- **The web side stops spreading and allow-lists explicitly — in BOTH component
  maps.** The hardening MUST be applied to the show page (`page-content.tsx`) and
  the edit-preview map (`MarkdownPreview.tsx`, §4.2) identically; fixing only one
  leaves the leak §5 claims is impossible. In each map the `img` override, the
  new `figure` override, and (show page only) `InlineAttachmentLink` must **drop
  `{...props}`** and forward a *closed set* of props only:
  - `figure` override: `className` (the transform's fixed tokens) + the inner
    `<img>`'s `src` / `alt` / clamped `width` style + the `<figcaption>` text
    (+ the `data-attachment-id` marker, §4.2.1).
  - `img` override: `src` / `alt` / `className` / clamped `width` style
    (+ `data-attachment-id`).
  - `InlineAttachmentLink` (show page): its existing
    `attachmentId`/`variant`/`href`/`alt`/ fixed `className` **plus** the new
    `widthStyle?: string` — which is *only* the already-clamped `width:NN%`/`NNpx`
    value, not free-form CSS.
  Anything the transform did not intend (a stray `hProperties` key, an
  unexpected attribute) is simply **not in the forwarded set**, so it cannot
  reach the DOM even though the global sanitizer is absent. **A required test
  asserts neither map forwards an unexpected prop onto the DOM** (e.g. inject a
  bogus `hProperties` key and assert it does not appear in the rendered output).
- **No inline float / arbitrary CSS** — float and align are *fixed classes*;
  only the clamped `width` is ever inline.

This keeps the attack surface to "one transform-constructed `width:` declaration
and a fixed enum className", with the web overrides reduced to allow-list
forwarders — safe even without a global sanitizer (whose introduction is a
larger, separate hardening — noted, not required here).

## §6 Generic editor embed-affordance framework (RFC-0013 §12 Decision #8, realized)

Today the editor (`packages/web/src/components/editor/build-extensions.ts`) has
markdown + autocomplete + paste/drop, but **no hover/floating affordance and no
URL/notation matcher** (RFC-0013's framework — §12 Decision #8, with the SDK
surface sketched in §7.5 and scheduled as §11 Phase E — is RFC-only). This RFC
builds it.

### §6.1 Surface

```ts
// A re-findable handle for a matched target. `token` is the literal
// substring to search for; `ordinal` disambiguates identical tokens (the
// Nth, 0-based, occurrence of `token` in the doc) — REQUIRED because a
// bare text search is unsound when the same embed appears twice.
interface AffordanceKey { token: string; ordinal: number }

interface EditorAffordance {
  // Detect a target in the buffer. The matched range positions the tooltip,
  // but `key` is what apply() re-locates from at dispatch time — it does NOT
  // trust the match-time offsets.
  match: (ctx: { doc: string; pos: number }) => { from: number; to: number; key: AffordanceKey } | null;
  // The floating UI shown for a match (image panel, "Embed this", …).
  render: (target: AffordanceTarget) => ReactNode;
  // Apply an edit. MUST re-locate the target from `key` against the LIVE doc
  // (find the `key.ordinal`-th occurrence of `key.token`), not the match-time
  // `from`/`to` — see the collab-concurrency requirement below.
  apply: (view: EditorView, key: AffordanceKey, edit: AffordanceEdit) => void;
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
- **Collab-concurrency requirement (edit contract).** The match-time `{from,to}`
  is valid only at the instant of the match. Under realtime collaboration
  (RFC-0003) a *remote* collaborator can insert/delete text between the panel
  opening and the user clicking a control, shifting every offset after their
  edit — so dispatching on the stored `{from,to}` would corrupt the wrong span.
  The affordance framework therefore **mandates the same re-locate-at-dispatch
  contract `upload-placeholder.ts` already uses**: that module deliberately does
  not track offsets across collaborator edits — `replacePlaceholder` /
  `removePlaceholder` (`upload-placeholder.ts:162-186`) call `findPlaceholderRange`
  on the **live** `view.state.doc` at dispatch time and key off a stable token,
  not stored positions (see the contract note at `:145-149`). `apply()` must do
  the same: re-find the target from its `key` against the current document and
  dispatch on the freshly-found range; if the target is gone (a collaborator
  deleted the image), it is a no-op. Stored offsets are for *anchoring the
  tooltip* only, never for editing.
- **The re-locate key must disambiguate identical tokens.** A bare
  text-search on the token alone is **unsound**: a repeated logo/icon —
  `![logo](/api/v2/attachments/abc)` appearing twice — shares the same span text,
  so a naive `doc.indexOf(token)` re-locate would edit the **first** occurrence
  and corrupt the wrong image under the exact concurrent-edit scenario this
  contract defends against (`upload-placeholder.ts` dodges this because the
  `#u=<id>` upload id is unique per placeholder — `:46-55,116-126` — but a
  *settled* image token has no such id). The key is therefore
  `{ token, ordinal }`: at match time the editor records **which occurrence**
  (0-based index among equal `token`s in the current doc) the tooltip is on; at
  dispatch `apply()` re-finds the `ordinal`-th occurrence in the **live** doc.
  - A "synthesised id not present in the document text" is **not** an option —
    it can't be re-found by a text search, defeating the contract. The ordinal is
    derivable purely from the live document, so it survives reload/reconnect.
  - Residual edge (Open Q8): if a remote collaborator **inserts another identical
    token before** this one between open and dispatch, the ordinal shifts and the
    edit could still target the wrong twin. v1 accepts this narrow case (two
    identical image embeds *and* a concurrent insertion of a third identical one
    *between* panel-open and click) and mitigates by **re-deriving the ordinal on
    the panel's own edits** and closing the panel on a detected external doc
    change near the target; a fully robust handle would need a Yjs
    `RelativePosition` (RFC-0003), deferred.

### §6.2 Image built-in consumer (the first one)

- `match`: an image embed with (or without) a `{…}` block. The `key.token` is
  the matched image markdown span (`![alt](url){…}?` including any existing
  attribute block, so a re-locate finds the whole rewritable region); `key.ordinal`
  is which occurrence of that exact span this is in the current doc — so two
  identical `![logo](/x)` embeds get `ordinal` 0 and 1 and never collide (§6.1).
- `render`: a small panel — **width** (slider / %/px toggle), **align** (L/C/R) /
  **float** (L/R) buttons, **caption** field.
- `apply`: rewrites (or inserts/removes) the `{…}` block as an **idempotent**
  edit. Per §6.1 it re-locates the `key.ordinal`-th occurrence of `key.token`
  against the **live** document at dispatch time (not the match-time range), so a
  concurrent remote edit cannot make it overwrite the wrong span; if the image is
  gone it no-ops. Setting nothing leaves a bare `![](…)`.
- This is what makes the notation **discoverable**: the user never types `{…}`.

### §6.3 Plugin consumers (the payoff)

A plugin declares `{ match: urlPattern, render: EmbedButton, apply }` and the
editor shows it with zero editor changes — exactly RFC-0013 §12 Decision #8 /
§11 Phase E (paste a Slack URL → "Embed this thread?" → rewrites to
`@[slack](url)`). This RFC ships the framework; RFC-0013 Phase E becomes a
consumer.

## §7 Phasing

- **Phase 1** — notation + renderer:
  - `core/image-attrs.ts` transform that parses + validates `{…}` and emits a
    **`hName='figure'` container node (no inherited `url`/`alt`)** + whitelisted
    `hProperties` + `hChildren` (the inner `<img>` carrying `src`/`alt`/clamped
    width, §4.1 step 2), **inserted at the FRONT of `buildCorePlugins`** before
    wikilinks/mentions (§4.1.1), and making the **attachment-vs-plain decision
    server-side** via the shared attachment-URL matcher (both `/api/v2/attachments`
    + legacy `/files/` forms, §4.2.1), emitting the `data-attachment-id` marker.
  - Web overrides in **BOTH** component maps — `page-content.tsx` *and*
    `MarkdownPreview.tsx` (§4.2) — reduced to allow-list forwarders (drop
    `{...props}`), each gaining a `figure` override; the show-page map routes a
    marked inner image to **`InlineAttachmentLink`** (extended with the clamped
    `widthStyle` channel, §4.2.1), the preview map renders it as a plain styled
    `<img>`.
  - Theme CSS (block align + float + figcaption + mobile degrade);
    `RENDERER_PIPELINE_VERSION` minor bump (`0.7.0`→`0.8.0`).
  - **Required tests**: the §4.1.2 predicate enumeration (inline / reference-style
    / last-child / split-brace / multi-image / **mention+wikilink adjacency =
    the core-order proof** / bogus); **the emitted `<figure>` has no `src`/`alt`
    attribute** (container-node shape, §4.1 step 2); **no orphan empty `<p>`
    brackets the figure** after `raw()` block-hoisting (§4.3); render in **both**
    maps (plain-URL **and** attachment image, show **and** preview) **including
    the legacy `/files/<id>` form routing to `InlineAttachmentLink`** (§4.2.1
    regression guard); **security — the width serializer cannot emit a
    multi-declaration `style`** (`width=30%;display:none` &c. → §5), and **neither
    component map forwards an unexpected prop** onto the DOM. Ships hand-typed
    display control.
- **Phase 2** — editor framework + image panel: `registerEditorAffordance` +
  floating host CodeMirror extension; image consumer panel whose `apply()`
  rewrites `{…}` via the **re-locate-at-dispatch** contract with the
  `{token, ordinal}` key (§6.1, identical-embed disambiguation). Discoverability.
- **Phase 3** — plugin-api editor surface so plugins register affordances; first
  external consumer is RFC-0013 §11 Phase E (Slack embed). (Can land independently.)

## §8 Compatibility / migration

- **The markdown body is never rewritten.** This feature is render-time only; the
  `{…}` lives as plain text in the body, which remains the source of truth. No
  migration mutates stored bodies (consistent with the memory note "表示専用HTML
  はmigrationでなくstrip" — display concerns are handled at render, not by
  rewriting stored data).
- **Re-render blast radius (NOT a pure no-op).** The transform changes what *some
  pre-existing bodies render to*, even though their text is unchanged:
  - A body with **no `{…}` after any image** renders exactly as today — the
    transform never touches those image nodes.
  - A body that already contains literal `![x](u){…}`-shaped text — written
    before this RFC and meant to display as "image, then a literal `{…}`" — will
    now have the brace block **consumed/stripped and reinterpreted** as display
    attributes on re-render. The displayed output **silently changes** for that
    text. This is the deliberate cost of choosing adjacent-brace notation; it is
    judged acceptable because (a) `![img](url){…}` immediately-adjacent to an
    image is a vanishingly rare thing to have typed *intending* the braces as
    visible text, (b) when it does happen the braces were already rendering as
    odd literal noise, and (c) only a `{…}` that actually parses to ≥1 valid
    whitelisted key is consumed — `{bogus}` / prose braces are left literal
    (§4.1 step 4 / §4.1.2).
- **Which revisions actually re-render, and when (corrects an earlier
  over-claim).** Bumping `RENDERER_PIPELINE_VERSION` does **not** force every
  existing page to re-render on read. The read-path fallback
  (`computeRevisionRenderArtifactsAsync`, `util/page-response.ts:155-162`) only
  re-renders when a revision's **stored `rendererVersion` *mismatches*** the
  running version; a revision with an **`undefined`/legacy `rendererVersion` is
  treated as fresh and its stored AST is returned verbatim** (re-rendering every
  legacy revision on every read is explicitly called unaffordable there). So the
  new display behaviour appears on:
  - **newly saved / re-saved** revisions (stamped `0.8.0`), and
  - revisions previously stamped with a *different* version (e.g. `0.7.0`), which
    mismatch `0.8.0` and so re-render on next read.
  Revisions with **no** stored version (saved before `rendererVersion` existed)
  are **not** re-rendered until an operator backfills via `renderer:rebuild` /
  RFC-0008. Practical effect: legacy pages keep their current output (including
  any literal `{…}`) until they are edited or explicitly rebuilt — which also
  *bounds* the §8 silent-change blast radius to freshly-saved + same-feature-era
  pages rather than the whole corpus on deploy day.
- **No fragment usage** — `#u=<uploadId>` (upload placeholder) is untouched (and
  per §3.2 it is transient anyway).
- **Degrade elsewhere**: pasted into GitHub the `{…}` shows as literal text after
  the image (non-destructive *to the body*); Pandoc/MyST/GitLab interpret it.

## §9 Open questions

1. **Parser layer**: mdast post-parse transform (v1, simple) vs a micromark
   syntax extension (robust, heavier). Recommend transform for v1; grammar is
   stable either way.
2. **Explicit `caption="…"`** (alt ≠ caption): add now or defer? Recommend defer.
   Beyond the obvious cost (alt-as-caption covers the common case), the
   quoting/escaping inside `{…}` is a **parser change, not just a key add**: the
   v1 scan stops at the first `}` (§4.1.2), which breaks on `caption="a {b} c"`
   or escaped quotes, so the `caption=` extension MUST land a quote-aware,
   brace-balancing scan at the same time. Defer until that is designed.
3. **`.class` allow-list** (e.g. `{.rounded .shadow}` from a *fixed* set): nice
   extensibility, but every added class is theme + security surface. Defer.
4. **Float breakpoint** — the width below which `float` collapses to block
   (theme decision; e.g. < 480px).
5. **Affordance trigger** — hover vs cursor-in-range vs a gutter marker. Phase-2
   UX detail; affects how intrusive the panel feels.
6. **Plugin editor-SDK shape** (Phase 3) — how a plugin ships a React tooltip
   into the web editor (the renderer SDK ships transforms, not React) — the
   genuinely new plumbing, designed at Phase 3 start (ties to the RFC-0013 §12
   Decision #8 / §11 Phase E "generic embed-affordance SDK surface" memo, listed
   there as the largest undesigned piece).
7. **Shared attachment-URL matcher location** (§4.2.1) — the bare URL→id matcher
   (`ATTACHMENT_URL_RE`, `inline-attachment-link.tsx:17`, matching **both**
   `/api/v2/attachments/<id>` and legacy `/files/<id>`) is lifted into a
   framework-free helper so the API transform makes the attachment-vs-plain
   decision server-side and `extractAttachmentId` re-consumes it. **No existing
   precedent**: this is the **first** framework-free renderer helper shared by api
   + web (api-contract is schemas/contracts/errors only; slugging is server-only
   in `core/headings.ts:23-41`; HTML strip is web-only in `render-mdast.ts:78`).
   **Default (decided): a new runtime module in `@crowi/api-contract`** — its tsup
   build already emits framework-free CJS+ESM (`api-contract/tsup.config.ts`) and
   it is a dependency of both sides. Open part: confirm (a) api-contract vs (b) a
   web-importable module under `api/renderer` vs (c) a tiny dedicated shared pkg
   (only if api-contract should stay contracts-pure). The exact export name and
   the both-forms test are Phase-1 details.
8. **Affordance re-locate under a concurrent identical-token insertion**
   (§6.1) — `{token, ordinal}` is sound for the common repeated-embed case, but a
   remote collaborator inserting *another* identical token *before* the target
   between panel-open and dispatch shifts the ordinal. v1 mitigates (re-derive on
   own edits; close panel on external change near target); a fully robust handle
   is a Yjs `RelativePosition` (RFC-0003), deferred — decide at Phase 2 whether
   the mitigation suffices or the relative-position binding is pulled forward.

## §10 References

- Code: `packages/api/src/renderer/pipeline.ts:289-302` (remark chain:
  `remarkParse`+`remarkGfm`+`remarkBreaks` only — no attr plugin, §3.2/§6 fix),
  `packages/api/src/renderer/core/index.ts:27-38,46` (core order rationale +
  `buildCorePlugins`; `image-attrs` is prepended FRONT, §4.1.1),
  `packages/api/src/renderer/core/headings.ts:40-41` /
  `core/mentions.ts:64-75,84` / `core/wikilinks.ts:59-82,100-110` (the
  `data.hProperties` emit pattern this transform copies + the text-node *splitting*
  §4.1.1 must run after), `packages/api/src/renderer/version.ts`
  (`RENDERER_PIPELINE_VERSION`),
  `packages/web/src/components/editor/render-mdast.ts:78,180,191-193`
  (mdast→hast→React; `toHast` keeps only `hName`/`hProperties`/`hChildren`;
  `raw()`/parse5 at `:180` block-hoists `<figure>` out of `<p>` → §4.3; the
  `escapeUnknownRawHtml`/`stripUnknownElements` hast walkers at `:78-91` are the
  precedent for the empty-`<p>` cleanup pass; the HTML strip lives here, web-only
  — **not** in api-contract, §4.2.1/Q7; `passNode:false` keeps `data-*` flowing;
  no sanitize),
  `packages/web/src/components/page-view/page-content.tsx:359-384` (show-page
  `img`/attachment branch — stop spreading props + gain a `figure` override),
  `packages/web/src/components/editor/MarkdownPreview.tsx:143,241-257` (the
  **second** render surface — separate `previewComponents` map whose `img` also
  spreads `{...props}` and has no `figure`/attachment handling; same transform
  output via `POST /api/v2/pages/preview` at `:28-32` — §4.2/§5 fix #3),
  `packages/web/src/components/page-view/inline-attachment-link.tsx:1,17,19,60-69,101-115`
  (`'use client'` at `:1` — module is client-only, so the matcher must be lifted;
  `ATTACHMENT_URL_RE` at `:17` matches **both** `/api/v2/attachments/<id>` **and
  legacy `/files/<id>`** — §4.2.1 both-forms requirement; `extractAttachmentId` at
  `:19`; uploaded-image render; props interface to extend with the clamped-width
  channel — §4.2.1),
  `packages/api-contract/src/` (schemas / contracts / errors **only** — no shared
  renderer helper exists yet; `tsup.config.ts` emits framework-free CJS+ESM, the
  basis for the *first* such helper, §4.2.1/Q7),
  `packages/api/src/util/page-response.ts:155-162`
  (`computeRevisionRenderArtifactsAsync` — the version-mismatch-only re-render
  condition scoped in §8),
  `packages/web/src/components/editor/build-extensions.ts` (where the affordance
  extension mounts), `packages/web/src/components/editor/upload-placeholder.ts:46-55,104-126,145-186`
  (`buildSuccessText` / unique `#u=<id>` fragment — why placeholders re-locate
  uniquely and settled tokens need the §6.1 `ordinal`; `findPlaceholderRange`
  re-locate-at-dispatch contract reused by §6.1).
- RFCs: RFC-0002 (renderer/renderedAst), RFC-0003 (realtime collab — the
  concurrency the §6.1 edit contract guards against), RFC-0004 (editor),
  RFC-0013 §12 Decision #8 + §7.5 + §11 Phase E (the generic embed-affordance
  this RFC implements; Slack embed consumer), RFC-0008 (`renderer:rebuild`
  backfill for legacy revisions — §8), RFC-0009 (renderedAst storage).
- Prior art: [MyST images/figures](https://myst-parser.readthedocs.io/en/latest/syntax/images_and_figures.html),
  [URL-fragment sizing (Tek's Domain)](https://teknikaldomain.me/code/markdown-image-sizes/),
  [@mdit/plugin-img-size](https://mdit-plugins.github.io/img-size.html),
  [Markdown image alignment guide](https://blog.markdowntools.com/posts/markdown-image-alignment-positioning-complete-guide).
