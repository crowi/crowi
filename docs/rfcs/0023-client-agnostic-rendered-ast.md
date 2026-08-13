# RFC-0023: Client-agnostic renderedAst (typed rendering AST for web, iOS, and future clients)

- **Status**: Draft
- **Author**: @sotarok
- **Created**: 2026-07-30
- **Depends on**:
  - RFC-0002 (Renderer Plugin Architecture) — revises its SSR-first commitment and completes its “Why mdast JSON instead of HTML” rationale.
  - RFC-0016 (Native Apple app for Crowi) — reverses its §6 renderedAst-not-consumed decision; its WKWebView rejection remains intact.
- **Related**:
  - RFC-0003 (Realtime Collaborative Editing) — the Y.Text collab invariant this RFC pins.
  - RFC-0008 (Migration Command Framework) — the rebuild framework for the new backfill task.

## §0 Summary

renderedAst MUST become a client-agnostic, typed rendering AST. The server is
already Crowi’s common renderer: packages/web has mdast-util-to-hast and
hast-util-to-jsx-runtime, while parsing and transformation occur in
packages/api/src/renderer/; the API returns transformed mdast as
revision.renderedAst (packages/api-contract/src/schemas/page.ts:94-105). iOS
alone has a second Markdown parser, making it the only parser-divergence source.

This RFC retains native SwiftUI page rendering but changes its input from the
raw Markdown body to server-rendered AST. Code, math, diagrams, link cards, and
renderer placeholders become typed nodes. HTML remains legitimate, but is
opaque on non-web clients and shown as a visible placeholder. The detailed wire
schema, negotiation syntax, validation limits, structured cache schema, and
backfill design are deliberately deferred to a reviewed Phase 1 design
deliverable.

## §1 Motivation

### §1.1 Two parsers cannot converge

The iOS raw-body renderer reproduces the server pipeline in a separate parser
(swift-markdown-ui / cmark-gfm). This includes core semantics: RFC-0002 Phase 5
made a single newline a line break, and iOS temporarily compensates with
.markdownSoftBreakMode(.lineBreak). Per-host renderer plugin sets make the
problem non-convergent. The current source has crowi-legacy, katex, mermaid,
and plantuml; the reference runner enables PlantUML, KaTeX, and Mermaid. Their
output is not fixed at Crowi build time, so a native reimplementation has a
moving target per host.

RFC-0016 §6 chose native raw-body Markdown because renderedAst was typed
unknown, web-coupled, and version-skew-sensitive
(docs/rfcs/0016-ios-native-app.md:706-735). This RFC reverses that decision:
the input is now a typed cross-client contract, while rendering remains native.

### §1.2 Web-shaped HTML in mdast clothing

Current producers destructively replace source nodes:

| Producer | Current result | Information lost |
| --- | --- | --- |
| Shiki (core/syntax-highlight.ts:54-68) | Replaces code with a pre.shiki span tree. | Language is entirely absent: there is neither lang nor a language- class (verified). Code text is recoverable only by concatenating span textContent. |
| KaTeX (plugin-renderer-katex/src/index.ts:109-127) | Changes the math node to html and deletes children and data. | TeX source is entirely lost. output: html supplies neither application/x-tex annotation nor MathML; the tree is aria-hidden with no alternative text (verified). |
| Code-block dispatch (core/code-block-dispatch.ts:459-471) | Replaces Mermaid or PlantUML code with img or div. | Original lang and diagram source. |
| Embed-tag card (core/link-card/render-card.ts:54-81) | Replaces it with inline html. | The original @[card](url) structure; OGP data is only in HTML. |

serialize.ts:36-46 recursively removes position. A client cannot map a node back
to the body fence; reparsing body and attempting to match nodes is not viable.

This completes RFC-0002’s rationale for mdast JSON
(docs/rfcs/0002-renderer-plugin-architecture.md:174-186): HTML freezes styling
at save time and blocks AST-level features such as search highlighting, comment
anchors, and AI annotations. Shiki theme CSS variables and saved-version KaTeX
markup are concrete frozen output.

### §1.3 Precedent and renderer ownership

GitLab uses shared fixtures: glfm_specification/example_snapshots/*.yml is a
golden master for its Ruby backend and JavaScript frontend, requiring changes on
both sides when a snapshot changes. Bluesky’s facets rationale is analogous:
Markdown lets a client’s new syntax be emitted verbatim by another; an AST can
safely ignore an unknown type.

The WebView/native divide follows ownership of the canonical renderer. Notion
(editor only), Obsidian, Logseq, Joplin, Wikipedia article view, and Confluence
bring web rendering to iOS. Bear, Craft, and Ulysses are native-first; Google
J2ObjC and Anytype share a non-UI core. Crowi owns its canonical renderer on the
server, a third position: share server output, not UI. Dropbox and Slack retired
shared C++ cores; Google explicitly shares non-UI code while writing iOS UI in
Objective-C or Swift.

## §2 Decision: typed nodes and uniformly opaque HTML

The enforceable invariant is:

> Content kinds for which Crowi guarantees rendering quality — code, math,
> diagrams, link cards, and placeholders — MUST be typed nodes. html nodes MAY
> remain. A non-web client MUST treat every html node as untrusted opaque content
> and show a visible placeholder.

| Producer | Target shape |
| --- | --- |
| Shiki | Preserve code with lang and value; put a token array in data. Web builds spans; iOS builds AttributedString. |
| Mermaid | Typed node with kind, diagram type, image: { mediaType, base64 }, and mandatory intrinsic dimensions. |
| PlantUML | Typed node with kind, svg or image: { mediaType, base64 }, and mandatory intrinsic dimensions (§7). |
| KaTeX | Typed node with TeX source and a web fast path (§8). |
| Link card | Typed node with url and structured OGP: title, description, image, siteName, domain; the image slot is fixed client-side (§3). |
| Error / limit placeholder | Typed node with fixed-enum kind, label, and reservation dimensions from cache/reservation.ts:98-127. |
| html | Remains html; non-web clients show a visible placeholder; web is unchanged. |

This admits a stable Shiki token structure to a golden corpus and lets future
Android, @crowi/cli, MCP, search highlighting, comment anchors, and AI
annotations consume the same AST.

### §2.1 Rejected: only author HTML remains

The stronger invariant “all remaining html is author HTML” is REJECTED, as is
distinguishing author HTML from plugin HTML. Both are unenforceable.
addUnifiedPlugin and addNodeRenderer are unrestricted AST mutation APIs
(packages/plugin-api/src/renderer.ts:552-561,
renderer/registry.ts:150-163); they run before serialization
(pipeline.ts:341-347,394-419). A plugin can inject html or a reserved type
without RenderResult, while serialize.ts:36-46 preserves every field except
position. After serialization both sources are indistinguishable as
{ type: 'html', value: … }; there is no provenance to enforce or validate the
stronger invariant.

Therefore iOS v1 renders every html node as a visible placeholder. A
safety-oriented iOS allow-list for author HTML is a future extension. Web
behavior does not change. Web known-tags.ts is a browser-known-tag list, not a
safety list: it includes script, iframe, object, embed, and style
(known-tags.ts:57,75,92,108,117) and only controls unknown-tag text fallback.
Its safety evaluation is an independent investigation, not a claimed
vulnerability; executability is unverified.

## §3 Revised SSR contract

This RFC revises RFC-0002’s first commitment — server HTML only, because
client-side rendering causes layout shift
(docs/rfcs/0002-renderer-plugin-architecture.md:19-21):

> The server MUST produce a complete rendering artifact that clients can render
> without asynchronous work or network fetches. It MAY be typed data rather than
> HTML. It MUST carry layout-determining dimensions the server can know; where it
> cannot know them, client reservation policy MUST absorb them.

Async rendering computation and rendering-dependent network fetches are
forbidden. Highlighting and diagram rendering remain server-side; Shiki and
Mermaid engines are not added to web. Synchronous native typesetting is allowed:
iOS may typeset TeX synchronously with SwiftMath. Media fetches remain allowed;
body images already use the iOS Bearer path
(WorkspaceMarkdownImageProvider.swift).

Dimensions are layered:

- Mermaid and PlantUML diagrams MUST carry intrinsic dimensions. Mermaid already
  derives width and height from SVG viewBox in
  plugin-renderer-mermaid/src/svg-dimensions.ts; this is landed prior art.
- Typed placeholders carry existing dimensions from cache/reservation.ts.
- OGP provides only an image URL (core/link-card/fetch-og.ts:12-19). The server
  does not add an image-probe fetch; a client uses a fixed card-image slot.
- Plain Markdown images are unchanged: use attributes if present, otherwise
  settle after load. Improving this is a separate feature.

## §4 Wire contract direction — deferred to Phase 1

renderedAst is currently z.unknown() (schemas/page.ts:94-105), Mixed in storage
(models/revision.ts:237-246), arbitrary beyond position in serialization
(serialize.ts:36-46), discarded by iOS lenient decoding
(PageLenient.swift:17-42), and emitted as a bare Root
(renderer/index.ts:154-159).

Phase 1 MUST produce and review a separate design document defining:

- An envelope with astVersion, the schema-contract generation, distinct from
  rendererVersion, the generated-artifact freshness key. Exact field names,
  nesting, and recursive schema syntax are deferred.
- A type-discriminated union; kind is subtype only. Crowi reserved prefixes,
  x-<pluginName>-* third-party names, and reserved-type collisions are deferred.
- A recursive opaque-node catch-all. A plugin node such as type: callout MUST
  become opaque at that node, never reject the entire page. Semantics and the
  distinction from malformed known nodes are deferred.
- Explicit block/phrasing placement, resolving Html as unknown as
  PhrasingContent (core/embed-tags.ts:170-171).
- Validation of tree depth, total bytes, mediaType allow-list, and base64
  length. Numerical limits are deferred. Invalid payloads become visible
  placeholders: never silent omission, decoding, or crash.
- Web typed handlers plus migration of every direct Root consumer in §6.

It must also answer negotiation syntax and legacy-emitter removal, structured
cache design, Revision backfill query/update/history/concurrent-write
verification, iOS cached-page and history policy, and web memo identity (§10).

### §4.1 Unknown core nodes unwrap; third-party nodes do not

The registry is closed, so every node type added later is unknown to clients
already in the field. iOS is the hard case: releases go through review and
users update on their own schedule, so an old build is not a transition state
but a permanent part of the population. A client cannot declare which types it
understands — `X-Crowi-Ast-Version` carries the envelope's schema version, and
`rendererVersion` is diagnostic and must not switch rendering (§5).

A client that meets an unknown type **with children** renders those children in
its place, re-validated under the same parent content model. Placement,
depth, and every other envelope rule still apply per child, so an unknown
wrapper grants its subtree no privileges its position did not already have.
An unknown type without children stays a visible placeholder, as before.

Two consequences bind the server side.

**A new core node type carries its content in `children`, not in fields.**
Content reachable only through a node's own fields is invisible to a client
that does not know the type — unwrapping yields nothing and the reader loses
the content outright. Content in children degrades to the pre-existing
rendering instead. `crowiAlert` is the shape to copy: it keeps the original
block quote children, literal marker included, so an unaware client shows
today's quote.

**Third-party `x-<plugin>-<type>` nodes are excluded from unwrapping.** They
are opaque-ised deliberately (`packages/api-contract/src/schemas/rendered-ast.ts`),
and this section's rule would otherwise have clients open exactly what the
server closed — contradicting the requirement above that a plugin node become
opaque at that node. The `x-` prefix is therefore not only a naming convention:
it is the sole signal separating "unknown, safe to unwrap" from "unknown,
deliberately sealed", and clients act on it.

## §5 SDK, cache, and version direction

RenderResult and EmbedFragment receive an additive structured-result variant.
Existing HTML results remain valid and mean opaque output. Bundled KaTeX,
Mermaid, and PlantUML migrate; third-party plugins remain unchanged.

Every migrated producer MUST bump cacheVersion. Cache keys include
pluginCacheVersion (renderer/cache/index.ts:103-111), and the SDK says a producer
bump invalidates immediately without operator action
(plugin-api/src/renderer.ts:160-166). Flushing is race-prone across shared-DB
rolling replicas: an old replica can repopulate an old shape under the same key.

The complete cache path is HTML-only: CacheEntry requires HTML
(plugin-api/src/renderer.ts:390-405), and normalization, persistence, quota,
stale-if-error, and error placeholders assume HTML
(renderer/cache/index.ts:283-338, cache/mongodb-cache.ts:98-170). Phase 1 MUST
design structured size measurement, stale-if-error, typed placeholders, and
dispatch propagation.

RENDERER_PIPELINE_VERSION is not a plugin-output-shape identifier. It is 0.10.0
(renderer/version.ts:43), describes core composition only, and intentionally
excludes plugin sets (version bump-policy comment,
plugin-renderer-plantuml/src/index.ts:55-73,
plugin-renderer-mermaid/src/index.ts:77-89). Clients MUST NOT branch on it.
It remains the AST freshness key used on reads
(util/page-response.ts:160-177).

## §6 Content-negotiated rollout

Clients declare supported astVersion values by header or query; exact syntax is
Phase 1 work. The server returns the highest mutually supported form. No
declaration receives the legacy bare Root. The old emitter remains for one
release window; Phase 1 defines its removal condition.

- An already-open old web tab makes no declaration and remains functional.
- An old replica returns old shape; a new client detects absent astVersion and
  falls back. iOS falls back to raw body when renderedAst is missing, astVersion
  is missing, or astVersion is unsupported.
- Tests cover new API × old web, old API × new web, and mixed replicas.

Phase 2 migrates all direct Root consumers:

- packages/web/src/components/page-list/page-list.tsx:44-49,204-207 — portal H1.
- packages/web/src/components/editor/link-card-preview-placeholder.ts:127-149.
- packages/web/src/lib/use-preview.ts:44-57 and
  components/editor/markdown-preview.tsx:112-124.
- iOS CachedPage (Persistence/CachedPage.swift), currently body/revisionId/counts
  only: Phase 1 chooses persisted AST plus WorkspaceReadCacheSchema version bump,
  or an explicit online-only AST policy.
- iOS RevisionHistoryView, currently body-only despite getRevision returning AST:
  Phase 1 chooses primary rendering or explicit body-only behavior.

Only getPage (handlers/page.ts:288-300), portal listPages documents, getRevision,
and POST /pages/preview provide renderedAst. iOS therefore fetches page detail
before drawing a list-row page. Preview stamps data-source-line and dispatches
only previewPolicy: server-render fences (currently Mermaid), skipping embed-tag
and URL expansion; its AST is not necessarily persisted-AST shaped.

## §7 Security

When allowSafeHref is true, the SVG sanitizer retains https: href/xlink:href
and permits image/a (packages/svg-sanitize/src/policy.ts:7-21). PlantUML returns
that permissively sanitized SVG as inline HTML
(plugin-renderer-plantuml/src/index.ts:110-132). Native SVG rendering could
therefore fetch external resources.

Typed SVG MUST be re-sanitized with allowSafeHref: false, retaining local
fragment references only. PlantUML external links are removed. The iOS SVG
renderer MUST explicitly disable resource loading and have a regression test:
these are defense in depth.

iOS v1 uses the uniform html placeholder policy. data-crowi-image-width, -height,
-align, and -float are untrusted channels (image-attrs.ts:28-39). iOS validates
each: percentages are closed 1..100 and pixels closed 1..4096; out-of-range
values are dropped, not clamped (image-attrs.ts:142-150). The corpus fixes this.

OGP image is an arbitrary external HTTP(S) URL, directly used by web img
(core/link-card/fetch-og.ts, render-card.ts:75-76). After scheme validation,
clients may fetch it into a fixed slot and omit it on failure. The request
reveals the viewer’s IP to the third-party host: parity with web, not a new
exposure. Server-side ingestion is open.

## §8 KaTeX

Typed KaTeX carries TeX source and server-generated HTML in data as the web fast
path. Web output does not regress. iOS synchronously typesets TeX with SwiftMath
or iosMath; its dimensions settle during layout, so no intrinsic value is needed.
output: mathml is deferred pending investigation of an iOS MathML renderer.

## §9 Normative collaboration invariant

**Collaboration MUST continue to synchronize Markdown source as Y.Text.**
Rendering and synchronization are independent.

yswift exposes YrsDoc, YrsTransaction, YrsMap, YrsArray, YrsText, and
YrsUndoManager, but no XML type; xml.rs does not exist. Y.Text permits a Swift
client. ProseMirror XmlFragment would structurally lock it out, forcing custom
Rust FFI or WebView. iOS collaboration itself is out of scope. yswift is also
the least actively maintained y-crdt binding (README WIP; last push 2024-07).

## §10 Shared golden corpus

A shared JSON golden corpus defines parity. It includes headings/anchor slugs,
wikilinks, mentions, break, emoji, image attributes, crowiFigure,
data-crowi-image-* validation, GFM tables/task lists, code fallback, Shiki token
shape, and typed-node schema. It excludes plugin-dispatch output bytes, which
packages/e2e/tests/renderer-plugins.spec.ts covers.

Shiki tokens are { content, light, dark }. The server produces both theme CSS
variables (pipeline.ts:205-228), and web selects by theme
(globals.css:496-511); a single color cannot represent current dark mode. The
corpus asserts token shape and color presence, not concrete colors. It follows
packages/web/src/lib/__fixtures__/page-display-name.json, consumed by web Vitest
and PageRowTitleLabelTests.swift:54; the Swift loader can be reused.

crowiFigure is the only shipped true custom type
(core/image-attrs.ts:96-107,307-317) and intentionally lacks data.hChildren
(image-attrs.ts:51-95). data.hProperties preserves heading id, link className
(wikilink-broken / mention), image attributes, figure marker, and preview
data-source-line; data.hName maps crowiFigure to figure and emoji text to span.

data.renderPending persists on code because serialization preserves non-position
data. Read retries deep-clone, so results are not persisted and can differ on
every read (page-response.ts:217-249). iOS MUST NOT use it as a cache key.
PageContent memoizes only revisionId (page-content.tsx:512-525), so a later retry
can fail to repaint; Phase 1 considers AST-content identity such as a hash.

## §11 Phasing and acceptance highlights

### Phase 1: detailed design

Produce a reviewed design document under .feature-state/specs/, not code. It
answers every Phase 1 question, including Revision.renderedAst backfill. The
backfill is not runRendererRebuild, which regenerates PluginRenderCache and does
not touch Revision (util/rebuild-renderer.ts:1-24). Acceptance: concrete answers
and a legacy-emitter removal condition.

### Phase 2: server and web atomically

Implement the schema, structured SDK and caches, typed core/bundled producers,
cacheVersion bumps, direct-consumer migration, pipeline-version bump, backfill,
negotiation, and mixed-version tests. Remove undefined === fresh
(page-response.ts:160-167). Acceptance highlights: non-unknown contract,
legacy response for old tabs, Shiki dual theme, mandatory diagram dimensions,
resanitized PlantUML SVG, preserved TeX, structured cards/placeholders, no new
async/network rendering calculation, and recorded real-corpus payload measures.

### Phase 3: corpus

Ship the JSON corpus, consumed by API Jest and CrowiKit XCTest. It fixes
dual-theme tokens, image-attribute validation, and newline-to-break.

### Phase 4: iOS core and fallback

Make AST the primary iOS path; missing or unsupported versions fall back to raw
body. Render core nodes through tableCell, preserve IDs and links/mentions, and
show html, unknown, and invalid nodes visibly. Implement the Phase 1 cache and
history decision.

### Phase 5: iOS typed extensions

Render Mermaid/PlantUML PNG and SVG with resource loading disabled, synchronously
typeset math, render structured cards and placeholders, and reserve diagram/card
space before load or decode.

## §12 Alternatives considered

- **WKWebView server HTML/AST.** Rejected. RFC-0016’s reasons stand: N-host
  renderer skew, web-only Shiki CSS, heavy per-cell views that break native
  scrolling/selection, and cookie-oriented web context conflicting with Bearer
  image loading (docs/rfcs/0016-ios-native-app.md:1273-1300).
- **On-device JS/WASM pipeline.** Rejected: third-party apps have no JIT, the
  measured result is approximately 7.5× slower, and there is no bytecode cache.
- **Compiled shared parser FFI (comrak/cmark-gfm).** Rejected: no Swift comrak
  binding, C-level extension work, and core grammar coverage only.
- **Strict no-generated-HTML invariant.** Rejected as unenforceable (§2.1).
- **Operator cache flush.** Rejected as race-prone across replicas (§5).
- **Deploy new web first.** Rejected: it cannot protect already-open tabs (§6).

## §13 Open questions

- RENDERER_PIPELINE_VERSION bump width: default major.
- astVersion and rendererVersion: default both; contract and freshness differ.
- Backfill load, operations, and history scope: default latest first, history
  delayed; design in Phase 1 and measure in Phase 2.
- Legacy emitter removal: default one release window; Phase 1 defines condition.
- PlantUML external links: default remove; restore only in a separate feature.
- OGP server ingestion: default do not ingest, for web parity; privacy is a
  separate feature if required.
- KaTeX output: mathml: default do not switch until iOS MathML research.
- iOS author-HTML safe subset: default future iOS-specific allow-list if needed.
- Web known-tags.ts safety evaluation: independent investigation.
- Web memo identity: Phase 1 consideration.
- iOS SVG renderer: choose in Phase 5, only if resource loading is disabled.
- iOS math renderer: choose SwiftMath/iosMath in Phase 5, only if synchronous.
- GFM footnote, definition, linkReference, and imageReference: repository tests
  do not exist; Phase 3 corpus fixes their behavior.

