# RFC-0015: Image Display Attributes and Editor Affordance

- **Status**: Draft
- **Author**: @sotarok
- **Created**: 2026-06-22
- **Depends on**:
  - RFC-0002 (Renderer Plugin Architecture) — Markdown is parsed and transformed
    in the API-side renderer pipeline, and the resulting mdast is persisted as
    `Revision.renderedAst`.
  - RFC-0003 (Realtime Collaborative Editing) — collaborative editing remains
    raw Markdown in CodeMirror/Y.Text; this RFC adds a source-editing
    affordance, not a WYSIWYG image surface.
  - RFC-0004 (Editor UX Enhancement) — the CodeMirror 6 editor, paste upload,
    drag-and-drop upload, autocomplete, and preview surfaces this RFC extends.
  - RFC-0013 (Slack Plugin) — Decision 8 defines a generic editor affordance
    direction for embeddable content. This RFC implements the image-specific
    version first and keeps the shape compatible with later plugin-registered
    affordances.
  - RFC-0008 (Migration Framework) — its `renderer:rebuild` command is a **hard
    release-sequencing dependency** for the `0.7.0`→`0.8.0` renderer-version bump:
    the bump makes cached `renderedAst` stale, and `renderer:rebuild` is the
    backfill path (§10). The bump must not ship before that rebuild is available.
- **Related**:
  - RFC-0009 (Revision Storage Compaction) — rendered mdast and revision storage
    behavior remain the persistence boundary.
  - RFC-0016 (Native Apple app) — native clients render raw Markdown and should
    understand the syntax over time, but are not part of v1.

## §0 Summary

Crowi should support a small, explicit Markdown extension for controlling image
display attributes:

```markdown
![Architecture diagram](/api/v2/attachments/abc){width=60% align=center}
![Screenshot](/api/v2/attachments/def){width=320px float=right}
```

The v1 syntax is a Pandoc-style attribute block immediately following a Markdown
image. The only supported keys are `width`, `height`, `align`, and `float`.
Existing plain images, such as `![alt](url)`, are unchanged. Existing literal
text that exactly matches the new adjacent syntax, such as
`![x](url){width=60%}`, is a syntax-level compatibility break: after this
renderer version, it is interpreted as image display metadata. Authors who need
literal text should make the block non-recognizable, for example by inserting a
space after `{` (`{ width=60%}`) or by writing the text as code.

The renderer implementation is a narrow Crowi core mdast transform. It parses an
adjacent `{...}` text node after an image, validates the allow-listed values, and
emits only renderer-owned properties that the web renderer interprets through a
shared image-layout helper. That helper does not trust the properties by name: it
**re-validates every display value at render time** and applies only well-formed
values, so a forged `data-crowi-image-*` attribute authored in raw HTML cannot
inject layout it did not earn. The transform does not emit generic HTML
`width` / `height` attributes for authored `%` / `px` values, and it does not
adopt a general third-party Markdown attribute plugin.

Standalone attributed images render as `<figure>` wrappers. v1 does **not**
auto-populate a `<figcaption>`; explicit `caption="..."` is deferred until the
parser and accessibility rules are mature enough (see §7 for the accessibility
rationale).

The scope of v1 is deliberately two changes: (a) the `{...}` mdast attribute
syntax, and (b) a shared img/figure render helper that re-validates display
props. v1 does **not** change existing raw-HTML `<img>` behaviour beyond that
re-validation, and it does **not** introduce renderer-version migration
infrastructure — the `0.8.0` renderer-version bump depends on RFC-0008's
`renderer:rebuild` (§10).

The editor adds a CodeMirror hover/focus affordance on image Markdown. The
affordance lets authors add and edit width, block alignment, and float without
memorizing the syntax. It follows the generic embed-affordance direction from
RFC-0013 but can ship first as the built-in image affordance.

## §1 Motivation

Crowi users frequently embed screenshots, diagrams, and photos. Attachment
insertion currently emits plain Markdown image syntax only:
`![label](url)` (`packages/web/src/components/page-edit/attachment-insert-button.tsx:80-88`).
That is portable and should remain the default, but it gives authors no
structured way to size, align, float, or caption the image without raw HTML.

Raw HTML is already possible in Crowi, but it is not discoverable, is awkward to
edit, and bypasses the mdast-centered renderer model. A wiki needs a durable,
readable source format that survives copy/paste and can be authored by hand or
through editor tooling.

Crowi's current renderer architecture is well suited to this feature. The API
pipeline parses Markdown with `remarkParse` and `remarkGfm`, runs core
transforms, then external renderer plugins (`packages/api/src/renderer/pipeline.ts:290-317`).
Saved revisions persist the transformed mdast in `Revision.renderedAst` and the
pipeline version in `Revision.rendererVersion`
(`packages/api/src/models/revision.ts:30-49`,
`packages/api/src/models/revision.ts:341-347`). The image attribute transform
therefore belongs in the API renderer, not as a client-only preview rewrite.

## §2 Goals

- Add a stable Crowi Markdown syntax:
  `![alt](url){width=60% height=240px align=center float=right}`.
- Preserve existing `![alt](url)` behavior exactly when no attribute block is
  present.
- Support width and height as validated numeric values with `%` or `px` units.
- Support block alignment with `align=left|center|right` on standalone images.
- Support opt-in text wrapping with `float=left|right`, separate from `align`,
  on standalone images.
- Render standalone attributed images as `<figure>` wrappers (without an
  auto-generated `<figcaption>`) in v1.
- Keep preview and saved page image-attribute interpretation identical by using
  the shared API renderer and a single shared web image-render helper, while
  preserving page-view-only attachment modal behavior.
- Make display-prop interpretation depend on a re-validated value, never on the
  presence of an attribute name, so raw-HTML-forged transport attributes cannot
  grant layout.
- Provide a CodeMirror hover/focus affordance for adding and editing the
  supported attributes.
- Keep the grammar deliberately small, allow-listed, and safe in the current
  no-sanitize web rendering environment.

## §3 Non-Goals

- A general Markdown attribute syntax for arbitrary nodes.
- Grid, gallery, masonry, or multi-image layout. Those require a container
  notation and should be designed in a separate RFC.
- Arbitrary CSS, `style=...`, event handlers, custom classes, or passthrough
  HTML attributes.
- WYSIWYG drag handles or client-side image manipulation.
- Server-side thumbnail generation or image byte transformation.
- Replacing raw HTML as an escape hatch for non-v1 layouts. Raw HTML remains the
  documented, unchanged escape hatch for layouts v1 does not cover.
- **Broader raw-HTML `<img>` hardening.** This RFC does not change how existing
  raw-HTML `<img>` elements forward `style` / `class` / event handlers / unknown
  attributes. Tightening raw-HTML image rendering to an allow-list is a separate
  concern (a raw-HTML hardening RFC), entangling a breaking change with this
  feature. The only raw-HTML `<img>` change here is that the shared render helper
  re-validates the four Crowi display props (§9); everything else about raw
  `<img>` prop-spread stays as it is today.
- Renderer-version migration infrastructure. Backfilling stale `renderedAst`
  after the `0.8.0` bump is RFC-0008's `renderer:rebuild` job, which this RFC
  depends on rather than reinventing (§10).
- Native iOS/macOS rendering support in v1.

## §4 Prior Art

### §4.1 Pandoc / MyST Attribute Blocks

Pandoc-style image attributes use a block directly after the image:

```markdown
![alt](url){width=30% align=right}
```

This is the strongest fit for Crowi. The notation is recognizable in Markdown
ecosystems, keeps layout metadata outside the alt text and URL, and maps cleanly
onto an mdast transform. Crowi does not need Pandoc's full general attribute
grammar; v1 only accepts a strict image-specific subset.

### §4.2 Hugo-Style URL Fragments

Some static-site renderers encode image options inside URL fragments, for
example `![alt](url#w60:fright)`. The browser does not send the fragment to the
image server, so it can work technically, but it is Crowi-specific, does not
degrade to readable text elsewhere, and overloads the URL fragment — a component
that already carries meaning (in-document anchors and legitimate media fragments
such as `#t=10,20`). §12.1 evaluates and rejects this on those grounds.

### §4.3 Obsidian Pipe Notation

Obsidian-style syntax places modifiers in the alt text, such as
`![caption|right|300](url)`. It is easy to parse, but it mixes accessibility
text, caption text, and layout tokens in one field. That creates semantic debt
and makes later alt-vs-caption separation harder.

### §4.4 HackMD / markdown-it-imsize

The `![alt](url =300x200)` family is compact and familiar for size-only use
cases, but it does not solve alignment, float, or caption. Crowi would still need
another notation for the rest of the feature.

### §4.5 Raw HTML

Raw HTML remains an escape hatch for layouts outside this v1 syntax, but it
should not be the primary authoring model for wiki images. It is less
discoverable, harder for CodeMirror tooling to rewrite safely, and not aligned
with persisted mdast semantics. v1 keeps raw-HTML `<img>` prop-spread behaviour
unchanged (§3): the shared render helper re-validates the four Crowi display
props whether they arrive from the mdast transform or from a hand-authored
`data-crowi-image-*` attribute, but it does not otherwise restrict raw `<img>`.
Because that re-validation ignores everything but well-formed Crowi display
values, raw-HTML `data-crowi-image-*` attributes are not a supported way to
smuggle other layout — they are simply re-checked like any other source.

## §5 Syntax

An image attribute block is recognized only when it follows an image node in the
same paragraph. The transform accepts zero or more ASCII spaces / tabs between
the image and `{`, and also accepts one soft line break followed by spaces /
tabs:

```markdown
![Alt text](/files/a.png){width=60% align=center}
![Alt text](/files/a.png){height=240px float=right}
![Alt text](/files/a.png)
{width=60% align=center}
```

The v1 grammar is intentionally small:

```text
image-attrs := "{" attr* "}"
attr        := key "=" value
key         := "width" | "height" | "align" | "float"
```

Attributes are separated by ASCII whitespace. Values are unquoted in v1.
Unknown keys are ignored rather than treated as parse errors, so Markdown is not
broken by unsupported or future attributes.

The scanner must not treat arbitrary leading text as part of the attribute
block. `{` may be preceded only by the whitespace described above. More than one
soft line break, any non-whitespace text before `{`, or a non-recognizable block
such as `{ width=60%}` leaves the text unchanged.

Supported values:

| Key | Values | Meaning |
| --- | --- | --- |
| `width` | positive number plus `%` or `px` | Display width. Percent values are capped to `1..100%`; pixel values are capped to an implementation-defined maximum such as `4096px`. |
| `height` | positive number plus `%` or `px` | Display height. Width plus intrinsic aspect ratio remains preferred; height exists for constrained diagrams. |
| `align` | `left`, `center`, `right` | Block placement without text wrapping. |
| `float` | `left`, `right` | Opt-in text wrapping. On narrow screens, float is disabled and the figure becomes a normal block. |

If both `align` and `float` are present, `float` wins for layout. The editor may
surface this as a lint-style hint, but the renderer should not fail the page.

The parser does not support `caption="..."` in v1. Quoted values introduce
escaping and accessibility questions that should be solved before accepting
author-provided caption text.

## §6 Rendering Design

### §6.1 Transform Placement

The feature is implemented as a bundled core renderer transform, for example
`packages/api/src/renderer/core/image-attrs.ts`, registered in
`buildCorePlugins` (`packages/api/src/renderer/core/index.ts:45-47`).

The current core order is headings, wikilinks, mentions, code-block language
collection, and syntax highlighting (`packages/api/src/renderer/core/index.ts:21-47`).
The image attribute transform should run after headings and before wikilinks and
mentions. That keeps the adjacent `{...}` text node intact before transforms
that split or rewrite text nodes.

The pipeline version should bump from `0.7.0` to `0.8.0`, because adding a
bundled transform is a minor renderer-version change under the documented policy
(`packages/api/src/renderer/version.ts:8-16`,
`packages/api/src/renderer/version.ts:30`). The *release* of that bump is gated on
RFC-0008's `renderer:rebuild` (§10): the transform can be built first, but
`RENDERER_PIPELINE_VERSION` flips to `0.8.0` only once stale `renderedAst` can be
backfilled.

### §6.2 Parser Behavior

`remarkParse` and `remarkGfm` do not parse Pandoc-style image attributes. For
Crowi v1, the core transform walks paragraphs and detects:

1. an mdast `image` node;
2. an immediately following mdast `text` node whose text begins with the
   permitted whitespace prefix from §5 followed by a valid `{...}` attribute
   block;
3. at least one recognized attribute with a valid value.

The transform consumes only the matched whitespace prefix plus attribute
substring and preserves any remaining text in the following text node. If no
valid attribute remains after validation, the image and following text node are
left unchanged; this avoids surprising data loss.

The parser must be a bounded, linear scanner over the following text node, not a
catastrophic regular expression. It should stop scanning the candidate block at
the first `}` or at a small implementation-defined maximum such as 1024
characters, whichever comes first. Unterminated blocks, huge malformed
`{...` sequences, nested braces, and invalid tokens must complete in O(n) time
relative to the inspected text node and leave the Markdown unchanged. Unit tests
must cover large malformed and unterminated blocks because live preview sends
raw bodies frequently and the preview API runs the full renderer per request.

The transform must not call external services or depend on browser state. It is
a pure Markdown-to-mdast transformation and runs for save, read fallback, and
preview.

### §6.3 mdast / hast Representation

Crowi's web renderer converts server-emitted mdast to hast and then to React
(`renderMdastToReactNode`, `packages/web/src/components/editor/render-mdast.ts:164-195`).
The supported transport from mdast to hast is `node.data.hName`,
`node.data.hProperties`, and `node.data.hChildren`; preview already uses
`data.hProperties` to carry source line anchors
(`packages/api/src/hono/handlers/page-preview.ts:57-65`).

#### The transport `data-*` properties are untrusted by name

The critical constraint: `data-crowi-image-*` is **not** a trust boundary, because
it is user-forgeable. Crowi's render path runs `hast-util-raw`
(`render-mdast.ts:180`), which parses author raw HTML such as
`<img data-crowi-image-align=center data-crowi-image-width=99%>` into a hast
`element` with those exact `properties`. That element reaches the *same* `img`
component override that Markdown images reach — `page-content.tsx:359-384` and
`MarkdownPreview.tsx:241-256` both `{...props}`-spread the remaining properties
onto `<img>`. If the helper reacted to the presence of a `data-crowi-image-*`
name, an author could inject any value the enum happens to allow by hand-writing
the attribute in raw HTML.

Therefore the trust boundary is the **re-validated value**, never the attribute
name:

- The shared web image helper (defined once, wired on every img/figure render
  path) re-parses each display property at render time:
  - `data-crowi-image-width` / `-height`: re-parsed as a bounded positive number
    followed by exactly `%` or `px`, applying the same caps as §5 (`1..100%`,
    `1..4096px`). Anything else is dropped.
  - `data-crowi-image-align`: accepted only if it is exactly `left`, `center`, or
    `right`.
  - `data-crowi-image-float`: accepted only if it is exactly `left` or `right`.
- Only a re-validated value produces style/class. Mere presence of the attribute
  grants nothing.
- The helper applies this **identically** whether the property came from the
  Crowi mdast transform or from a raw-HTML-authored `data-crowi-image-*`
  attribute — there is one code path, and it re-checks regardless of origin. A
  forged attribute is thus either well-formed (in which case it is exactly the
  layout a Markdown author could have written anyway) or ignored.
- The helper consumes the transport `data-crowi-image-*` properties and strips
  them, so they never leak raw to the DOM. Every img and figure render path
  (`page-content.tsx`, `MarkdownPreview.tsx`, and the `InlineAttachmentLink`
  image variant in §6.5) routes props through this one helper; no render path
  may `{...props}`-spread transport `data-*` straight onto an element.

This value-not-name re-validation is what makes it acceptable for the transport
to ride on `data-*` attributes at all. §9 lists the full invariant set.

#### The transform does not use HTML `width` / `height`

The transform must not use HTML `width` or `height` attributes as the carrier for
authored values. Values such as `60%` and `320px` are CSS sizes, not safe numeric
HTML image dimensions. The concrete v1 transport is:

| mdast / hast property | Values |
| --- | --- |
| `data-crowi-image-width` | normalized `%` or `px` value |
| `data-crowi-image-height` | normalized `%` or `px` value |
| `data-crowi-image-align` | `left`, `center`, `right` |
| `data-crowi-image-float` | `left`, `right` |

The web helper converts a re-validated `data-crowi-image-width` /
`data-crowi-image-height` into an allow-listed React `style` object such as
`{ width: '60%' }` or `{ width: '320px', height: '240px' }`, and chooses the fixed
renderer-owned layout classes. These values are never passed through from Markdown
(or raw HTML) as arbitrary `style`, `class`, `width`, or `height` props.

#### Inline (non-standalone) attributed images

For an attributed image that is *not* standalone (§"standalone predicate" below),
the transform keeps the node as an mdast `image` and adds only the re-validated
`data-crowi-image-width` / `-height` properties. **`align` and `float` are ignored
on non-standalone inline images**: they are block-level concepts (block placement,
text-wrap) that have no coherent meaning for an image sitting mid-sentence next to
other inline content. Only `width` / `height` apply inline. Inline images do not
become figures and do not get captions. This rule is chosen explicitly so
implementations do not diverge on whether `float` mid-paragraph is honoured — it
is not.

#### Standalone attributed images become a figure

For standalone attributed images, the transform replaces the containing
*paragraph* node (not just the image child) with a node that emits a fixed
`<figure>` shape:

```text
figure(class "crowi-figure", + layout classes)     // renderer-owned marker class
  img(src, alt, re-validated data-crowi-image-width/height properties)
```

The figure container must not inherit `src` or `alt` from the original image; only
the inner `<img>` carries image URL and alt text. v1 emits **no** `<figcaption>`
(see §7 for why alt-as-caption is dropped).

**Renderer-owned figure marker.** `figure` and `figcaption` are already known HTML
tags (`packages/web/src/components/editor/known-tags.ts:59-60`), so an author can
write a raw `<figure>` today and it passes through the renderer. The web component
must therefore style **only** transform-generated figures, identified by a
renderer-owned marker the transform stamps (a fixed class such as `crowi-figure`,
or a `data-` key). The figure component override allow-lists the props it honours
(the marker class, the renderer-owned layout classes) and ignores arbitrary props
on raw `<figure>`; a user raw `<figure>` without the marker renders as an ordinary
passthrough figure, unaffected by this feature's layout CSS.

**Preserve source position.** When the transform replaces a top-level `paragraph`
with the synthetic `figure` node, it must copy the original paragraph's `position`
onto the replacement. Preview scroll-sync anchors are derived from each top-level
node's `position.start.line`
(`injectSourceLineAnchors`, `packages/api/src/hono/handlers/page-preview.ts:57-66`);
a replacement without `position` would silently drop `data-source-line` for
standalone attributed images and break scroll-sync on exactly those blocks. A unit
test must assert the synthetic figure carries the source paragraph's `position`.

**Transport mechanism — verify or use the proven HAST-side path.** The RFC assumes
a synthesized block-level mdast node with `data.hName='figure'` / `hChildren`
emits correctly through `mdast-util-to-hast`. There is currently **no in-repo
precedent** for a *core API transform* synthesizing a block-level mdast node via
`hName` — the existing block-structure synthesis (`wrapSections`) is done on the
**HAST side**, after `toHast`, operating directly on hast elements
(`packages/web/src/components/editor/render-mdast.ts:103-127`, invoked at
`render-mdast.ts:173`). The implementation must therefore either (a) verify with a
test that `toHast` emits the `<figure>` and its `<img>` child correctly from the
mdast `hName`/`hChildren` transport, or (b) switch to the proven HAST-side
transport by emitting the figure structure the way `wrapSections` wraps sections.
The implementation must state which of (a)/(b) it uses; the default recommendation
is (a) with an explicit toHast-output test, falling back to (b) if the mdast
transport does not round-trip the `<img>` child cleanly.

#### Standalone predicate

The standalone predicate is exact:

1. The image appears inside a paragraph.
2. After consuming the permitted whitespace prefix and attribute block, that
   paragraph contains no non-whitespace text and no other inline nodes.
3. The paragraph's parent can accept flow children after replacement, such as
   root, blockquote, or list item.

If the paragraph has trailing non-whitespace text, multiple images, links, code,
emphasis, or any other inline content, the attributed image remains inline (with
only `width` / `height` applied per the inline rule above) and the consumed
trailing text is preserved after the image. This means
`![a](/x.png){width=60%} trailing text` becomes an inline attributed image plus
` trailing text`, not a block figure. The transform must update the containing
parent's child array so it never emits invalid `<p><figure>...`.

### §6.4 Layout Semantics

`align` and `float` are separate axes, and both apply only to standalone images
(the figure case); they are ignored on inline images (§6.3):

- `align=left|center|right` controls block placement only. It does not cause
  surrounding text to wrap.
- `float=left|right` opts into text wrapping and overrides `align` when both are
  present.

Mobile behavior is part of the specification. Below the web app's narrow-screen
breakpoint, floated figures render as normal blocks with `float: none`,
`max-width: 100%`, and margins that keep the image readable.

The web renderer must implement an explicit `figure` component override and the
shared image helper behavior in both page view and preview. `figure` is already a
known HTML tag, but this feature needs a component override plus CSS classes to
attach the layout contract rather than relying on unstyled passthrough, and the
override must key off the renderer-owned figure marker (§6.3) so it styles only
transform-generated figures, not user raw `<figure>`. v1 does not add a
`figcaption` override for this feature (no auto-caption is emitted).

The helper should use fixed classes or data attributes for layout, for example
`crowi-image`, `crowi-image-align-center`, and `crowi-image-float-right`. Width
and height are applied through a generated React `style` object or renderer-owned
CSS variables built only from re-validated numeric values and `%` / `px` units.

Current image renderers hard-code `h-auto`. That is correct for unconstrained
plain images, but it overrides authored `height`. The shared helper must keep
auto height only when no valid height was supplied, and must use a fixed class
or style that lets a validated height win when present. All image variants still
need `max-width: 100%` so pixel-sized images remain responsive.

### §6.5 Page View and Preview Parity

Page display and live preview currently have separate `img` component overrides,
each supplied as part of the `components` map that both surfaces pass to the
shared `renderMdastToReactNode`:

- page view: `packages/web/src/components/page-view/page-content.tsx:359-384`;
- preview: `packages/web/src/components/editor/MarkdownPreview.tsx:241-256`.

Both currently `{...props}`-spread remaining image props onto `<img>`. This RFC
requires the implementation to extract a single shared image-render helper that
performs the value-not-name re-validation from §6.3 and enforces identical
interpretation of `data-crowi-image-*` props in both places. The feature is not
complete if saved page rendering and preview rendering interpret the same image
attributes differently.

The shared helper is the one place that normalizes display props. It:

1. re-validates and strips the renderer-owned `data-crowi-image-*` props once
   (per §6.3 / §9);
2. returns the DOM-safe `className`, `style`, `loading`, `alt`, and `src` values,
   where `className` folds in the re-validated layout classes and `style` folds in
   the re-validated width/height;
3. is consumed by page view for attachment images (via `InlineAttachmentLink`),
   by page view for non-attachment images (plain `<img>`), and by preview (plain
   `<img>`), so no surface spreads raw transport `data-*` onto an element.

This parity is scoped to image-attribute interpretation, not to every image
interaction. Page view intentionally routes attachment image URLs such as
`/api/v2/attachments/<id>` through `InlineAttachmentLink` so a plain click opens
the attachment modal (`packages/web/src/components/page-view/page-content.tsx:377-379`,
`packages/web/src/components/page-view/inline-attachment-link.tsx:101-114`).
Preview intentionally renders a plain image and does not open that modal. This
behavior must remain.

#### `InlineAttachmentLink` merge contract

`InlineAttachmentLink` is part of the required implementation path. Its `image`
variant currently accepts only `attachmentId`, `variant`, `href`, `className`, and
`alt`, then renders a hard-coded `<img>` that already carries
`style={{ cursor: 'zoom-in' }}` and an `onClick` modal handler
(`packages/web/src/components/page-view/inline-attachment-link.tsx:101-114`). This
RFC extends the image variant to accept the normalized display props from the
shared helper, with an exact **merge** (not replace) contract so the existing
modal/cursor behavior is never clobbered:

- **style**: the helper's re-validated width/height `style` object is merged
  *into* the existing style object, i.e. `style={{ cursor: 'zoom-in', ...display }}`
  — the `cursor: zoom-in` affordance is preserved and width/height are added, not
  substituted for the whole object.
- **className**: the re-validated layout classes are merged with the incoming
  `className` (the `imgClassName` from `page-content.tsx:373`), not replaced.
- **modal handler + cursor**: the `onClick` handler and the `cursor: zoom-in`
  affordance remain, unchanged, page-view-only.
- The variant accepts only the normalized display props from the shared helper —
  never arbitrary Markdown / raw-HTML props.

The implementation must include a page-view test exercising an attachment image
with display attributes, plus a **parity assertion** that the attachment path
(page view via `InlineAttachmentLink`) and the plain-image path (preview) produce
the *same* final `style` / `className` for the same `data-crowi-image-*` input
(aside from the page-view-only `cursor: zoom-in` and modal handler).

The existing shared mdast-to-React helper already makes preview and page view use
the same conversion pipeline (`packages/web/src/components/editor/render-mdast.ts:164-195`).
The new image-specific prop handling should preserve that parity.

## §7 Caption Behavior

**v1 emits no caption at all.** A standalone attributed image becomes a
`<figure>` wrapper carrying the layout, but the transform does not synthesize a
`<figcaption>`:

```markdown
![Database topology](/files/topology.png){width=70% align=center}
```

This renders as a `<figure class="crowi-figure crowi-image-align-center">` whose
inner `<img>` has `alt="Database topology"` and the re-validated width — with no
visible caption text.

The earlier design derived the caption from the image `alt` text. That is dropped
because copying the same string into both `<img alt>` and `<figcaption>` is an
accessibility anti-pattern: a screen reader announces the image via its `alt`,
then encounters the identical `<figcaption>` text as figure content and announces
it a second time, so the user hears the caption twice. A genuine `<figcaption>`
should carry *different* information from `alt` (alt describes the image for users
who cannot see it; a caption adds context visible to everyone). Auto-duplicating
alt into figcaption produces exactly the wrong relationship, so v1 emits the
figure wrapper for layout only and leaves captions to a later version.

Plain images without attributes do not change. Inline attributed images do not
become figures, even when their width / height attributes are applied.

Explicit, author-provided captions are intentionally deferred:

```markdown
![Accessible alt](/files/a.png){caption="Visible caption"}
```

That form needs a quote-aware attribute parser, clear escaping rules, and an
accessibility rule for how `alt` and `caption` should intentionally differ. It is
a residual open question (§13) rather than smuggled into v1.

## §8 Editor Affordance

The editor should expose a CodeMirror hover/focus affordance for Markdown image
syntax. It is a source-editing helper: it rewrites the Markdown text, and the
server renderer remains the source of truth.

The image affordance should be a built-in editor extension registered by
`buildExtensions`, not a caller-supplied `extraExtensions` feature. Although
`MarkdownEditor` supports `extraExtensions`, the real edit page does not pass an
image extension into either the normal or collaborative branch
(`packages/web/src/app/(auth)/%5Fedit/edit-page-client.tsx:878-911`), and
`CollaborativeMarkdownEditor` currently owns `extraExtensions` for Yjs / keymap
composition before passing them to `MarkdownEditor`
(`packages/web/src/components/editor/CollaborativeMarkdownEditor.tsx:403-433`,
`packages/web/src/components/editor/CollaborativeMarkdownEditor.tsx:539-547`).
Putting the image affordance in `buildExtensions` makes normal and
collaborative editors use the same extension without threading a new prop
through `EditorPane` and `CollaborativeMarkdownEditor`.

The image affordance should:

- detect Markdown image spans using CodeMirror syntax context where possible,
  following the style of existing trigger/context detection
  (`packages/web/src/components/editor/autocomplete-extension.ts:53-107`);
- render a tooltip using the same design-token approach as existing CodeMirror
  tooltips (`packages/web/src/components/editor/autocomplete-extension.ts:269-285`);
- show controls for width, align, and float (with align / float presented as
  standalone-image options, matching §6.3);
- apply edits by re-locating the current image syntax in `view.state.doc`
  before dispatching, instead of trusting stale offsets.

The affordance shape should be compatible with RFC-0013 Decision 8, where embed
affordances are generic and plugin-registered (`docs/rfcs/0013-slack-plugin.md:394-400`).
Image attributes may ship first as a built-in affordance. General plugin
registration can follow without changing the Markdown syntax.

## §9 Security

Security is the most important constraint in this RFC.

Crowi's web renderer accepts dangerous HTML in the mdast-to-hast step
(`packages/web/src/components/editor/render-mdast.ts:158-166`) and parses raw
HTML with `hast-util-raw` (`packages/web/src/components/editor/render-mdast.ts:180`).
There is no `rehype-sanitize` step in that path. Therefore image attributes must
not become a general path for user-controlled DOM attributes or CSS.

The central invariant: **the transport `data-crowi-image-*` properties are
untrusted by name.** Because `hast-util-raw` parses author-written
`<img data-crowi-image-align=...>` into hast `properties` that reach the same
`img` override Markdown images use (§6.3), an attribute *name* can be forged in
raw HTML. The shared web image helper therefore re-validates every display value
at render time and grants layout only for a well-formed value — identically
whether the property came from the Crowi transform or from raw HTML. Presence of
the attribute name is worth nothing; only a re-validated value has effect.

The renderer must enforce these invariants:

- Only the keys `width`, `height`, `align`, and `float` are recognized in the
  `{...}` block.
- `width` and `height` accept only a positive numeric value plus `%` or `px`,
  within the §5 caps.
- `align` accepts only `left`, `center`, or `right`.
- `float` accepts only `left` or `right`.
- Unknown keys are ignored.
- Invalid values are ignored.
- `style`, `class`, `on*` event handlers, `srcdoc`, arbitrary `data-*`
  passthrough, and any other attributes are never accepted from the `{...}` block.
- Renderer-owned `data-crowi-image-*` properties are transport-only. The shared
  web helper **re-validates each value at render time** (a bounded number plus
  `%`|`px` for width/height, the fixed enums for align/float) and applies only
  well-formed values, then strips the transport properties. It does this the same
  way for values that came from the Crowi transform and for values authored in
  raw HTML, so a forged `data-crowi-image-*` cannot inject anything the enum /
  numeric grammar would not already allow a Markdown author to write. The helper
  never forwards transport `data-*` (or any unknown `data-*`) to the final
  `<img>`.
- Layout classes are chosen from fixed renderer-owned values, not from user
  input.
- Width/height React `style` is generated from fixed keys after re-validation,
  such as `{ width: '60%' }`, never copied from Markdown or raw HTML.
- Every img and figure render path routes props through the shared helper; no
  path blindly `{...props}`-spreads transport display props onto an element
  (`page-content.tsx`, `MarkdownPreview.tsx`, and the `InlineAttachmentLink` image
  variant).

Injection vectors this explicitly blocks (whether written in the `{...}` block or
forged as raw-HTML `data-crowi-image-*` attributes):

```markdown
![x](a.png){style=background:url(javascript:alert(1))}
![x](a.png){width=1px;position:fixed}
![x](a.png){onerror=alert(1)}
![x](a.png){class=prose fixed top-0}
<img src=a.png data-crowi-image-width="1px;position:fixed">
<img src=a.png data-crowi-image-align="center;--x:url(javascript:alert(1))">
```

Each of these is either an unrecognized key, or a value that fails re-validation,
so none produce style, class, or attributes.

**Scope of the raw-HTML change.** v1 does *not* broadly harden raw-HTML `<img>`.
Raw HTML remains the unchanged escape hatch (§3): existing raw-HTML `<img>`
`style` / `class` / event handlers / unknown attributes are forwarded exactly as
they are today, and tightening that is a separate raw-HTML hardening concern (its
own RFC). The only raw-HTML `<img>` change here is that the four Crowi display
props are re-validated by the shared helper regardless of origin — which cannot
*add* capability to raw HTML (raw HTML can already set inline `style`), it only
ensures Crowi's own display channel is not a forgeable bypass. Raw HTML for other
elements is entirely unchanged by this RFC.

## §10 Compatibility and Migration

Existing Markdown is compatible only outside the newly reserved syntax:

- `![alt](url)` renders exactly as it does today.
- Attachment insertion continues to produce plain image Markdown by default.
- Page bodies do not need migration.
- Images without an attribute block do not get figure wrappers, new classes, or
  changed margins.
- Existing text that intentionally placed a valid adjacent block after an image,
  for example `![x](url){width=60%}`, changes semantics once the revision is
  rendered by pipeline `0.8.0`. This is a syntax-level compatibility break, not
  only a historical-rendering concern. To preserve literal text, authors should
  make the block non-recognizable (`{ width=60%}`) or write it as code.

New attribute blocks degrade acceptably outside Crowi. Renderers that support
Pandoc-style attributes may interpret the block. Renderers that do not support
it will usually show `{...}` as literal text after the image.

Persisted `renderedAst` requires renderer-version handling, and this RFC resolves
it by **sequencing the `0.8.0` bump behind RFC-0008's `renderer:rebuild`**, not by
inventing new persistence machinery here.

Revisions saved with pipeline `0.7.0` carry a stored renderer version, so after
the bump to `0.8.0` they mismatch the running pipeline and the read path
recomputes the full rendered AST on every read
(`astIsFresh` at `packages/api/src/util/page-response.ts:155-162`; the recompute
via `runRender` at `packages/api/src/util/page-response.ts:183`). That existing
parse-on-read fallback does not persist the recomputed AST, so the parse /
transform / Shiki cost is paid on every read until the page is re-saved or a
rebuild job writes fresh artifacts. This recent `0.7.0` corpus is the main
performance cliff.

The resolution is a hard dependency, not a new mechanism invented in this RFC:

- `renderer:rebuild` is currently deferred to RFC-0008
  (`docs/rfcs/0002-renderer-plugin-architecture.md:100`;
  `packages/api/src/renderer/version.ts:25`). This RFC makes shipping that rebuild
  job a **release-sequencing gate**: the `0.8.0` renderer-version bump MUST NOT
  ship before RFC-0008's `renderer:rebuild` is available to backfill stale
  `renderedAst` / `rendererVersion`.
- Until rebuild ships, old revisions rely on the **existing** parse-on-read
  fallback (`page-response.ts:155-162,183`) with a documented one-time
  per-request CPU cost. This RFC does not add a persist-on-read write path,
  locking, or throttling — that would duplicate infrastructure RFC-0008 owns.
- Missing renderer versions remain trusted as fresh
  (`packages/api/src/util/page-response.ts:155-162`), so very old stored artifacts
  (saved before `rendererVersion` existed) still need explicit rebuild tooling or
  a re-save if operators want historical pages to pick up the new rendering.

Because the bump is gated on RFC-0008, the practical rollout is: land the
transform + web helper + tests on `0.7.0` behavior first if desired, and flip
`RENDERER_PIPELINE_VERSION` to `0.8.0` only once `renderer:rebuild` can run.

## §11 Phased Plan

### Phase 1: Renderer and Web Rendering

- Add `packages/api/src/renderer/core/image-attrs.ts`.
- Register it in `buildCorePlugins` after headings and before wikilinks.
- Add unit tests for: valid width/height, align, float, float-over-align
  precedence, unknown-key ignoring, invalid-value ignoring, partial text-node
  preservation, bounded malformed-block scanning, whitespace / soft-break
  handling, inline image behavior (width/height applied, align/float **ignored**),
  parent-level standalone paragraph replacement, `position` copied onto the
  synthetic figure node, and the `toHast` output for the synthetic figure
  (verifying the figure + inner `<img>` emit correctly, per §6.3 transport).
- Extract a single shared web image-render helper that performs the value-not-name
  re-validation (§6.3 / §9), plus the `figure` component override keyed off the
  renderer-owned figure marker and the CSS/class contract for align, float,
  responsive collapse, and re-validated width/height. v1 adds no `figcaption`
  override for this feature.
- Wire the shared helper on every img/figure render path: `page-content.tsx`,
  `MarkdownPreview.tsx`, and the `InlineAttachmentLink` image variant. No path may
  spread transport `data-*` onto an element.
- Extend `InlineAttachmentLink`'s image variant to accept normalized display props
  via the merge contract in §6.5 (style/className merged into the existing
  `cursor: zoom-in` + modal handler, not replacing them).
- Add web tests: a re-validation test proving a forged raw-HTML
  `<img data-crowi-image-*>` with a malformed value produces no style/class; a
  page-view attachment test with display attributes; and a parity assertion that
  the attachment path and the preview path yield the same final `style` /
  `className` for the same input (aside from the page-view-only cursor/modal).
- Ensure preview via `POST /api/v2/pages/preview` and saved page rendering match
  for image-attribute interpretation, including attachment image URLs.
- Bump `RENDERER_PIPELINE_VERSION` from `0.7.0` to `0.8.0` — gated on RFC-0008's
  `renderer:rebuild` per §10. The bump MUST NOT be released before that rebuild
  job is available; until then, land the transform + helper on current behavior
  and flip the version only once rebuild can backfill stale `renderedAst`.

### Phase 2: Editor Affordance

- Add a CodeMirror image affordance extension.
- Surface width presets, pixel input, block align controls, and float controls.
- Rewrite the source Markdown attribute block through transactions.
- Register through `buildExtensions` so normal and collaborative editors both
  use the same built-in extension.
- Keep the implementation compatible with the generic affordance direction from
  RFC-0013.

### Phase 3: User Documentation

- Update the Markdown guide with the new syntax and examples.
- Update attachment documentation to show how to add display attributes after
  inserting an image.
- Document the v1 caption rule and the mobile float fallback.

### Phase 4: Future Extensions

- Decide explicit caption syntax and accessibility semantics.
- Consider exposing a generic plugin affordance registry for non-image embeds.
- Design grid/gallery layout separately if the product needs multi-image
  containers.

## §12 Alternatives Considered

### §12.1 Hugo-Style URL Fragment

Rejected on its own merits, not by appeal to Crowi's upload placeholders. The
placeholder-fragment argument does not hold up as a v1 differentiator: the `#u=`
upload placeholders are transient and are replaced with fragment-free final
Markdown (`buildSuccessText` returns `![name](url)` with no fragment,
`packages/web/src/components/editor/upload-placeholder.ts:104-107`; the
placeholder is swapped out on success at
`packages/web/src/components/editor/upload-placeholder.ts:290-313`), so no
persisted image URL carries a `#u=` fragment for a display-fragment to collide
with. Likewise `caption=` is deferred (§7), so "hard to extend for captions" is
not a live v1 distinction either.

The real grounds for rejection are:

- **Non-portability.** A fragment such as `url#w60:fright` is meaningful only to
  Crowi. Pasted into GitHub, Obsidian, or any other Markdown tool it is a broken
  or ignored URL fragment, whereas a trailing `{...}` block degrades to visible
  literal text.
- **URL-fragment overloading.** The fragment identifier is a URL component with
  existing semantics (in-document anchors, and legitimate **media fragments**,
  e.g. `#t=10,20` / `#xywh=...` per the W3C Media Fragments spec). Encoding
  display options there overloads a channel that can have real meaning for the
  linked resource.
- **Escaping.** Packing `key:value` pairs into a fragment invents an ad-hoc
  mini-grammar with its own delimiter/escaping rules inside a URL, which is harder
  to validate safely than a small `{key=value}` block the transform scans
  linearly.

Attribute blocks avoid all three: they are portable-degrading, keep the URL a
plain URL, and are validated by a bounded scanner.

### §12.2 Obsidian Pipe Modifiers

Rejected because it stores layout metadata inside alt text. That makes
accessibility behavior harder to reason about and conflicts with future
alt-vs-caption separation.

### §12.3 `=WxH` Size Syntax

Rejected because it only solves size. Crowi also needs block alignment and float
semantics (and eventually captions), so adopting size-only syntax would require a
second notation.

### §12.4 GitLab / kramdown Inline Attribute Lists (`{: ...}`)

kramdown (and GitLab Flavored Markdown, which builds on it) supports Inline
Attribute Lists — `{: .class #id key="value" }` — applied to the preceding
element. This is the closest cousin to the chosen Pandoc-style `{...}` block and
deserves a direct comparison.

Rejected for v1 on these grounds:

- **No parser support in Crowi's pipeline.** Crowi's renderer is `unified` with
  exactly `remark-parse`, `remark-gfm`, and `remark-breaks`
  (`packages/api/src/renderer/pipeline.ts:290-317`;
  `packages/api/package.json` dependencies). Neither `remark-parse` nor
  `remark-gfm` understands kramdown IAL, so adopting `{: ...}` would mean either
  pulling in a general third-party attribute plugin (rejected in §12.5 for the
  same security/semantics reasons) or hand-writing an IAL parser — strictly more
  surface than the tiny image-only `{width= height= align= float=}` scanner this
  RFC specifies.
- **The leading `:` and general targeting is more than images need.** kramdown
  IAL targets arbitrary block/inline elements and carries arbitrary
  `class`/`id`/attributes. That is exactly the broad, security-sensitive
  attribute surface §3 and §9 rule out. The `.class` / `#id` / `key="value"`
  generality would have to be stripped down to the same four keys anyway, at
  which point the `:`-prefixed kramdown spelling only adds an unfamiliar sigil.
- **Portability is no better than Pandoc's.** Both degrade to visible literal
  text in non-supporting renderers; Pandoc-style `![alt](url){width=...}` is the
  more widely recognized spelling for *image* attributes specifically.

The chosen syntax is deliberately the image-scoped subset of the Pandoc form,
which needs no `:` sigil, no general element targeting, and no new parser
dependency.

### §12.5 Third-Party Remark Attribute Plugin

Rejected for v1. The supported grammar is small, security-sensitive, and tied to
Crowi's persisted mdast semantics. A general plugin (e.g. a remark IAL /
attributes plugin) would parse arbitrary `class` / `id` / `style` / attributes on
many node types — exactly the broad DOM-attribute surface §9 forbids in a
no-sanitize render path — and would couple Crowi to that plugin's grammar. A
general plugin can be reconsidered only if Crowi later adopts a broader attribute
grammar for more node types behind a sanitizer.

### §12.6 Raw HTML as the Main Solution

Rejected as the primary user-facing path. Raw HTML remains available and
unchanged for non-v1 layouts (§3): raw `<img>` prop-spread is not restricted by
this RFC beyond re-validating the four Crowi display props regardless of origin
(§9). Raw HTML is not discoverable, not editor-affordance friendly, and not a
structured Crowi Markdown extension, so it is a fallback, not the model.

### §12.7 Grid / Gallery in This RFC

Rejected as out of scope. Grid and gallery layout need a container model for
multiple images. Per-image attributes should not grow into an implicit layout
language.

## §13 Open Questions

1. **Explicit caption syntax and accessibility rule.** v1 emits a `<figure>`
   wrapper with no auto-`<figcaption>` (§7, to avoid duplicating `alt` into the
   caption). A future `caption="..."` attribute needs quote-aware parsing,
   escaping, and a rule for when `alt` and the visible caption intentionally
   differ. This is the residual caption question deferred out of v1.
2. **Generic affordance registration surface.** The image affordance can ship as
   a built-in CodeMirror extension first. The exact plugin SDK and runtime
   registration API for future embed affordances should be finalized with the
   RFC-0013 implementation work.
3. **`renderer:rebuild` availability (dependency, not an open mechanism).** §10
   resolves the renderer-version rollout by gating the `0.8.0` bump on RFC-0008's
   `renderer:rebuild`; this RFC does not invent a persist-on-read path. The
   residual item is purely sequencing: RFC-0008's rebuild job must land (or be
   confirmed available) before the `0.8.0` version bump is released.

## §14 References

- `packages/api/src/renderer/pipeline.ts:290-317` — API renderer pipeline order.
- `packages/api/src/renderer/core/index.ts:21-47` — core transform registration
  and current ordering.
- `packages/api/src/renderer/version.ts:8-16` — renderer version bump policy.
- `packages/api/src/models/revision.ts:30-49` — `renderedAst` and
  `rendererVersion` fields.
- `packages/api/src/models/revision.ts:341-347` — save-time renderer execution.
- `packages/api/src/util/page-response.ts:141-200` — read fallback and stale
  renderer handling (`astIsFresh` at 155-162, recompute `runRender` at 183).
- `packages/api/src/hono/handlers/page-preview.ts:57-66` — existing
  `data.hProperties` source-line transport (`position.start.line` at 59).
- `packages/web/src/components/editor/render-mdast.ts:164-195` — `renderMdastToReactNode`
  mdast to React conversion path (raw-HTML parse at 180).
- `packages/web/src/components/editor/render-mdast.ts:103-127` — `wrapSections`,
  the proven HAST-side block-synthesis precedent (invoked at 173).
- `packages/web/src/components/page-view/page-content.tsx:359-384` — page-view
  `img` override (prop-spread at 383; attachment routing at 377-379).
- `packages/web/src/components/page-view/inline-attachment-link.tsx:101-114` —
  page-view attachment image variant (hard-coded `cursor: zoom-in` + modal).
- `packages/web/src/components/editor/MarkdownPreview.tsx:241-256` — preview `img`
  override (prop-spread at 255).
- `packages/web/src/components/editor/upload-placeholder.ts:45-107` — transient
  `#u=` upload placeholder replaced with fragment-free `![name](url)` on success.
- `packages/web/src/components/editor/known-tags.ts:59-60` — `figure` and
  `figcaption` are known tags, so raw `<figure>` passes through and the transform
  needs a renderer-owned marker to style only its own figures.
- `packages/api/package.json` (`remark-parse` / `remark-gfm` / `remark-breaks`,
  `unified`) — the renderer's only Markdown-parse dependencies (no attribute
  plugin).
- `packages/web/src/app/(auth)/%5Fedit/edit-page-client.tsx:878-911` — real
  edit page branches for normal and collaborative editors.
- `packages/web/src/components/editor/MarkdownEditor.tsx:44` and
  `packages/web/src/components/editor/MarkdownEditor.tsx:217-241` —
  `extraExtensions` support.
- `packages/web/src/components/editor/build-extensions.ts:102-139` — CodeMirror
  extension composition.
- `packages/web/src/components/editor/CollaborativeMarkdownEditor.tsx:403-433`
  and `packages/web/src/components/editor/CollaborativeMarkdownEditor.tsx:546` —
  collaborative editor extension injection.
- `docs/rfcs/0013-slack-plugin.md:394-400` — generic embed-affordance decision.
