# RFC-0018: Revision-aware quoted page comments

- **Status**: Draft
- **Created**: 2026-07-16
- **Depends on**:
  - RFC-0002 (Renderer Plugin Architecture) — quoted ranges target the final rendered page body produced by the shared `mdast → hast → raw → stripUnknownElements` pipeline (`packages/web/src/components/editor/render-mdast.ts:164-184`); they do not introduce Markdown syntax or another renderer pipeline.
  - RFC-0003 (Realtime Collaborative Editing) — comments and their anchors
    remain outside the Yjs document. A saved revision is the immutable source
    snapshot for an anchor.
  - RFC-0005 (Page Presence) — live comment changes continue to use the
    authenticated page-presence channel as an identity-only invalidation
    signal followed by an authorized HTTP refetch.
  - RFC-0009 (Revision Storage Compaction) — `renderedAst` is persisted only on snapshot revisions; incrementals regenerate a display AST on read (`docs/rfcs/0009-revision-storage-compaction.md:289-331`). This RFC does not require every revision to retain its own AST; it lazily persists a small, immutable text-only projection the first time a revision is anchored (§5.6), which is compatible with RFC-0009's storage lever exactly as designed.
- **Related**:
  - RFC-0017 (Live Collab Editor Invalidation) — both designs treat the
    persisted revision as authoritative and keep best-effort live messages out
    of the durable correctness boundary.

## §0 Summary

Crowi will let a reader select text in the rendered page body and attach a
normal page comment to that quote. The comment stores the revision on which it
was created plus a versioned selector containing:

- the exact selected text;
- bounded text immediately before and after it;
- its start and end offsets in a canonical rendered-text stream; and
- the source stream length.

The selector is modelled after the W3C Web Annotation `TextQuoteSelector` plus `TextPositionSelector`. A pure, versioned projection of the revision's rendered output — walked over the same shared hast pipeline the page show route already runs (§5) — defines its text surface; the browser uses the mounted `.crowi-prose` only to map an already-resolved interval to a `Range` and to position inline UI. Resolution is conservative:

1. find occurrences whose text is exactly equal to the stored quote;
2. when more than one occurrence exists, keep only those whose stored prefix/suffix context agreement meets a minimum threshold (§7.2); a below-threshold occurrence never attaches, even if it is the only one;
3. among threshold-passing candidates, use the nearest enclosing heading section and then source-offset-derived relative location only to break a tie; and
4. attach only if one candidate is uniquely supported after those tie-breaks; otherwise return the visible, non-inline `ambiguous` state.

There is no fuzzy, case-insensitive, normalized, or edit-distance match in v1.
If the exact quote no longer occurs, the comment is an orphan. It remains in
the complete footer comment list, retains its original quote and source
revision, and is labelled as a comment on a past revision. An orphan is never
deleted, hidden, or attached to merely similar prose.

An inline icon represents all comments that resolve to the same range. Opening
it shows a new anchored-comment modal: a filtered, flat, newest-first view of
those existing `Comment` rows and, on a writable current revision, a composer
for another comment at the same range. The modal is not a reply or thread
model. The footer remains the complete newest-first page conversation. Quoted
footer items can navigate back to their resolved body range.

The existing Comment persistence, authorization, activity, notification,
comment-count, auto-watch, deletion, React Query, and `comment-changed` live
sync lifecycles remain authoritative. Anchoring is optional metadata on a
normal Comment, not a second annotation resource.

## §1 Background / Motivation

Page comments currently provide a page-level discussion below the body. A
comment records a page, creator, revision, body, and the legacy numeric
`commentPosition`; page and revision lists are sorted newest-first
(`packages/api/src/models/comment.ts:5-40`). The web submits the displayed
revision id and maps the returned array directly into the footer list
(`packages/web/src/components/page-comments/page-comments.tsx:27-35,127-159,193-210`).

That model preserves discussion history but cannot express what sentence or
paragraph prompted a comment. A raw absolute character offset is not enough:
inserting text before the quote shifts the offset even if the quote itself is
unchanged. A DOM or mdast path is also unstable because the show page converts
`mdast → hast → raw → React`, and the only persistent wrappers are coarse
heading sections (`packages/web/src/components/editor/render-mdast.ts:93-126,147-194`).

Crowi does have the right durable identity boundary. Every comment already stores a `revision`, and every revision stores the Markdown body (`packages/api/src/models/revision.ts:23-49,320-347`). RFC-0009 persists `renderedAst` only on snapshot revisions and regenerates a display AST for incrementals on read (`docs/rfcs/0009-revision-storage-compaction.md:289-331`); either way, a display AST for the exact revision being shown is always available at read time. The show page remounts the entire `.crowi-prose` subtree when the displayed revision id changes (`packages/web/src/components/page-view/page-content.tsx:491-509,595-612`). A selector can therefore retain its immutable source revision while the client derives where, if anywhere, it appears on the revision currently being read.

The principal correctness risk is false attachment. A wiki can repeat the same
sentence, table cell, label, or code fragment many times. Attaching a comment
to the wrong occurrence silently misrepresents its author. This RFC therefore
freezes a conservative exact-only resolver and makes failure visible as an
orphan.

## §2 Goals / Non-Goals

### §2.1 Goals

- Let a reader select eligible rendered page text and create a normal Comment
  with a quote anchor and the displayed revision id.
- Make the anchor survive insertions or deletions elsewhere when the exact
  selected text remains present.
- Define a complete, versioned canonical text stream projected from the shared rendering pipeline's hast output, implemented once and shared by capture, server validation, resolution, offsets, tests, and DOM `Range` mapping.
- Refuse to attach repeated text unless context and locality uniquely support
  one occurrence; show an explicit ambiguous state instead of guessing.
- Preserve every anchored comment in the footer even when it cannot resolve on
  the displayed revision.
- Show an anchored-comment modal from the body icon without adding replies,
  nesting, or another comment store.
- Show existing comments and anchors read-only when a historical revision is
  displayed, while preserving the existing prohibition on historical-revision
  actions.
- Keep existing authorization, comment lifecycle hooks, React Query fetching,
  and identity-only live invalidation.
- Preserve old API clients and old Comment rows that have no anchor.
- Validate that every submitted `revision_id` belongs to the submitted
  `page_id`, for anchored and unanchored comment creation alike.

### §2.2 Non-Goals (v1)

- Fuzzy matching, edit distance, stemming, case folding, Unicode
  normalization, or whitespace-insensitive matching.
- Maintaining comment ranges inside Yjs or updating them continuously during
  collaborative editing.
- Replies, nested threads, resolved discussions, comment editing, or a new
  discussion model.
- Multiple disjoint selected ranges in one comment.
- General-purpose Web Annotation interchange or annotations on external pages.
- Stable block or inline ids embedded in Markdown or persisted in page bodies.
- Server-side resolution on every list/read or a persisted per-revision *resolution* cache (resolved offsets/attachment state for a comment). One-time server validation of the submitted source snapshot is required. This is distinct from the immutable, lazily-persisted `CanonicalTextProjection` text record introduced in §5.6: that record stores an unresolved text surface for re-validation, never a resolved interval or attachment decision.
- Cursor-paginated comment listing. `GET /comments` keeps returning the complete, unpaged array (§9, §11.5); pagination is deferred to a future, explicitly versioned contract change (§17).
- Adding anchor data to presence/WebSocket frames.
- New administrator configuration.
- Changing comment bodies from their current plain-text rendering
  (`packages/web/src/components/page-comments/comment-item.tsx:24-29,56`).

## §3 Existing Contracts That Remain Authoritative

### §3.1 Comment lifecycle and atomicity

Crowi's supported Mongo topology is standalone `mongod` — dev infra (`docker-compose.yml:19-44`) and the documented connection string (`.env.example:3`) have no replica set, and existing code already documents that `session.withTransaction` is unavailable in that topology (`packages/collab/src/compaction.ts:71-78`). This RFC therefore does not use a Mongo transaction and does not add a `Page` lifecycle/fencing field. Comment creation, anchored or not, keeps its current shape: load and grant-check the Page (`Page.findPageByIdAndGrantedUser`, `packages/api/src/hono/handlers/comment.ts:140-148`), then — only when an `anchor` is present — load the Revision and verify `Revision.page` equals that Page's id (§3.2) and verify the projection (§6.2), then `Comment.create`. Each step is a plain, unfenced read/write; there is no shared write or compare-and-swap between comment creation and page deletion.

This means a create can race a concurrent hard delete and, in the rare interleaving where `Comment.create` runs after `completelyDeletePage`'s own `Comment.removeCommentsByPageId` step (`packages/api/src/models/page.ts:1648`) but before or after the Page row itself is removed (`packages/api/src/models/page.ts:1680`), leave one dangling Comment referencing a now-deleted page id. This is accepted, not prevented — the same idempotent, order-tolerant philosophy the codebase already applies to cross-collection consistency under standalone Mongo (`.feature-state/specs/feature-multidoc-write-atomicity.md`'s (B) direction; the tombstone-plus-plain-unique precedent recorded for Postgres portability). It is harmless in practice: every comment read path resolves through the owning Page's grant check first (§3.2), so a comment whose page no longer exists is never returned, and the existing hard-delete cascade already removes every Comment row for a given page id — it is not extended with a new anchor-specific step, because an anchor is plain fields on the existing Comment document, not a separate collection. The lazily-persisted `CanonicalTextProjection` record (§5.6) is keyed by revision id, not page id; an orphaned record left behind after a page/revision hard-delete is small, immutable, and unreachable (its revision id can never be read again), so it requires no delete-time cascade of its own.

Activity, count reconciliation, auto-watch, notification, and `Comment:add`/remove invalidation continue to run from the existing Comment model hooks, unchanged by this RFC. There is no separate `CommentAnchor` collection, create event, or delete cascade.

### §3.2 Authorization and existence hiding

All comment routes retain JWT authentication and the `comments:read` or
`comments:write` scope (`packages/api/src/hono/handlers/comment.ts:80-92`). A
page grant is still required before listing or creating comments, and read
failures continue to collapse missing and inaccessible pages to the existing
not-found response (`packages/api/src/hono/handlers/comment.ts:95-133,140-154`).
Selectors never grant access and never affect which comments are returned.

The current create handler checks the page but writes the client-supplied revision id without loading that revision (`packages/api/src/hono/handlers/comment.ts:140-162`). This RFC closes that integrity gap. Before any anchored Comment is created, the create path must load the revision, verify its immutable `Revision.page` reference equals the authorized page, and use the same not-found-style response for missing, inaccessible, or mismatched revisions. A path-based `Revision.path → Page.path` join is not acceptable at create time: a rename can change paths, while the source identity is the page id.

The deployable `Revision.page` migration is owned by `.feature-state/specs/feature-revision-page-ref.md` (§12.1 depends on, rather than re-derives, its mechanics). Until its cutover completes, anchored creation is disabled rather than trusting a path join. Anchorless creation is unaffected — it keeps accepting the client-supplied revision id exactly as it does today, whether or not `Revision.page` backfill has completed.

### §3.3 Query and live-sync lifecycle

The page comment query is keyed by page id, and add/delete mutations invalidate
the whole list (`packages/web/src/lib/use-page-comments.ts:16-32,44-73,76-116`).
Remote changes already arrive as identity-only `comment-changed` messages; the
client invalidates the same query and refetches the authorized list
(`packages/web/src/components/page-view/page-view.tsx:310-320`). The wire schema
explicitly avoids shipping comment text through presence
(`packages/api-contract/src/schemas/presence.ts:128-141`).

This remains the complete consistency model. A live frame carries no selector,
quote, position, modal state, or derived attachment state. Duplicate or dropped
frames are harmless because the subsequent authorized list is authoritative.

## §4 Stored Selector and Comment Data Model

### §4.1 API shape

The comment contract gains this versioned object:

```ts
type CommentTextAnchorV1 = {
  type: 'text-quote';
  textStreamVersion: 1;
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  sourceLength: number;
  sourceSurfaceFingerprint: string;
  sectionId: string | null;
};
```

`CommentSchema` returns `anchor: CommentTextAnchorV1 | null`.
`AddCommentRequestSchema` accepts `anchor?: CommentTextAnchorV1`. The request
continues to require `page_id`, `revision_id`, and `comment`; the submitted
`revision_id` is the anchor's source revision. An anchor has no separate
revision field, preventing two source identities from disagreeing.

`sourceSurfaceFingerprint` is the lowercase SHA-256 hex digest of the revision's `CanonicalTextProjection` text (§5.6) — the lazily-persisted, immutable v1 projection of that revision's rendered output. It binds the selector to one frozen source surface, not merely to a revision id whose display AST might otherwise be recomputed differently after a renderer upgrade (RFC-0009 regenerates an incremental's display AST on every read).

`sectionId` is the nearest enclosing `data-section-id` (§5.1) at capture time, or `null` when the selection falls outside any wrapped heading section (e.g. before the first heading, or on a page rendered without section wrapping). It is optional, non-authoritative metadata: §7.2 consults it only to break a tie among otherwise-equal candidates, never to filter, attach, or reject on its own.

`CommentTextAnchorV1` is a versioned API-union branch. Its literal `type` and
`textStreamVersion` identify both the selector shape and the canonical stream
semantics; a future selector format must add another explicitly discriminated
branch rather than reinterpret any v1 field.

The current contract exposes `revision`, `commentPosition`, and the plain
comment body (`packages/api-contract/src/schemas/comment.ts:4-14,31-38`). The
new field is additive. `comment_position` remains accepted for wire
compatibility, and `commentPosition` remains returned, but both are deprecated.
New web writes do not set `comment_position`, and the server never derives an
anchor from it or mirrors `anchor.start` into it.

### §4.2 Persistence

The Mongo Comment document owns nullable typed scalar fields:

```ts
anchorType: 'text-quote' | null;
anchorTextStreamVersion: number | null;
anchorExact: string | null;
anchorPrefix: string | null;
anchorSuffix: string | null;
anchorStart: number | null;
anchorEnd: number | null;
anchorSourceLength: number | null;
anchorSourceSurfaceFingerprint: string | null;
anchorSectionId: string | null;
```

All ten fields are written together with the Comment. All absent or null means `anchor: null`; all present and valid maps to the nested API object. A partial persisted tuple is corrupt data: the API logs it, returns the Comment with `anchor: null`, and does not hide the comment or fail the entire list.

Flat typed fields avoid a Mongo-specific nested-document contract and map directly to ordinary nullable columns in a future relational store. Client-side resolution does not need a resolution index. The enforceable admission rules (§11.5) are **not** implemented as a count-then-insert query against `Comment` — under standalone Mongo (§3.1) that would be racy — but as atomic single-document counters in a small dedicated `AnchoredCommentCount` collection, updated with `findOneAndUpdate` + `$inc` + an admission filter, which is atomic without a multi-document transaction. The existing page/revision listing indexes continue to supply the newest-first query (`packages/api/src/models/comment.ts:26-40`).

### §4.3 Immutability and derived state

The source selector never changes after creation. Re-resolution against a new
revision does not rewrite offsets, context, quote, source revision, or stream
version. These client states are derived and never persisted:

- `unanchored`: `anchor === null`;
- `pending`: content, comments, or DOM index is not ready;
- `attached`: the selector resolved to a current stream interval and DOM Range;
- `ambiguous`: exact text occurs but no candidate uniquely satisfies the v1
  confidence rule; it is footer-visible and has no inline icon or jump target;
- `orphaned`: the exact quote does not occur, or a settled DOM cannot map the
  selected interval;
- `unsupported`: the client does not implement the stored stream version.
- `source-surface-unavailable`: the revision's `CanonicalTextProjection` cannot be computed (its Markdown/AST cannot be reconstructed) or its fingerprint cannot be reproduced;
- `not-inline-capacity`: a grandfathered anchor is footer-visible but is beyond
  the 200-anchor per-tab inline admission limit.
- `stream-too-large`: the displayed revision's projection exceeds the v1
  2,000,000-code-unit support limit; the footer remains available without
  attempting inline resolution.

A Comment can be attached on revision N, orphaned on N+1, and attached again
on N+2 after a rollback or reintroduction of the exact text. None of those
transitions writes to the database.

## §5 Canonical Rendered-Text Stream v1

This section is normative. Capture, server validation, and resolution must call the same pure `CanonicalTextProjectionV1` function. It is implemented once, in a package shared by the API and the web app (§5.1a), and is defined over the same hast the show page already renders from — NOT over the raw persisted `renderedAst` mdast blob directly (`packages/api/src/renderer/serialize.ts:1-29` confirms `renderedAst` is serialized mdast, one stage before `toHast`). DOM traversal is a separate, non-authoritative mapping adapter used only after an interval has been resolved. `Selection.toString()`, raw `HTMLElement.textContent`, Markdown source, and serialized HTML are non-conforming inputs to selector semantics; only this shared function's output is.

### §5.1 Source hast and traversal

The v1 root is the hast produced by the exact pipeline the show page already runs: `toHast(mdast, { allowDangerousHtml: true })` → `escapeUnknownRawHtml` → `hast-util-raw`'s `raw()` → `stripUnknownElements()` (`packages/web/src/components/editor/render-mdast.ts:164-184`) — the tree `renderMdastToReactNode` hands to `toJsxRuntime` before any Crowi component override runs. Plugin-rendered HTML participates identically to hand-authored raw HTML: a plugin returns already-sanitised HTML strings (`packages/plugin-api/src/renderer.ts:169-171`) that core stores as an opaque mdast `html` node (`packages/api/src/renderer/core/code-block-dispatch.ts:196-206`); by the time either reaches this pipeline's `raw()` stage they are the same kind of hast node as any other raw HTML, and the projection makes no attempt to distinguish their provenance. There is no typed "renderer artifact" AST node kind, and this RFC withdraws the earlier claim that one exists.

The projection performs a depth-first walk of that hast in document order and emits text per §5.2-§5.4. It never reads the live DOM, CSS, `alt`/`title` attributes, or browser UI — those are not part of the hast and therefore cannot be part of the stream. A separate, non-authoritative DOM mapping adapter produces a one-way map from a *resolved* interval to current DOM text nodes only after resolution; it is invalidated whenever the prose subtree or fullscreen state changes, and no DOM index, `Range`, or DOM-derived offset is retained as durable state.

The following hast subtrees are excluded in v1 (structural, applies to the complete descendant subtree, independent of viewport position, opacity, animation, transient layout, or author-controlled attributes):

- `script`, `style`, `template`, `noscript`, `svg`, and `canvas`;
- `button`, `input`, `textarea`, `select`, and `option`.

These are ordinary hast element types that authored or plugin-supplied raw HTML can legitimately produce; excluding them is a content-type rule, not a provenance rule, and applies identically regardless of who authored the tag. Raw HTML that is not one of these tag names is otherwise ordinary authored content: its text is projected, and its `hidden`, `aria-hidden`, and `data-comment-anchor-exclude` attributes have no selector effect.

When the show page's `sectionWrap: true` option is used (`packages/web/src/components/editor/render-mdast.ts:131-146`; the editor preview omits it), each heading and its following siblings are already wrapped in a `<section data-section-id="…">` hast element by `wrapSections` (`render-mdast.ts:103-126`), run before `raw()`. This `section` element is an ordinary block boundary per §5.3, and its `data-section-id` (sourced from the persisted heading anchor id, `packages/api/src/renderer/core/headings.ts:74-79`) gives the projection a free, already-existing structural discriminator: the nearest enclosing `data-section-id` for any stream offset. §7.2 uses it only as an optional, non-authoritative resolver tie-break, never to filter or attach on its own.

Crowi's own UI chrome — the code-copy button, the heading-anchor link icon, the inline comment badge, and the anchored-comment modal portal — is added by React component overrides passed to `toJsxRuntime` (`packages/web/src/components/page-view/page-content.tsx:103-140` `Heading`/`HeadingAnchor`, `:187-215` `CodeBlock`'s copy button) and therefore never exists in the hast this projection walks; it is excluded by construction, with no rule required. The web's DOM-walking implementation — used only for selection capture and for live-DOM re-anchoring against the CURRENT revision (§7), never for the canonical projection itself — separately walks the actual mounted DOM, which *does* contain this chrome, and must skip the same class of Crowi-mounted elements to keep its output equivalent (§5.1a). It does so via an in-memory `WeakSet<Element>` populated by Crowi's own component code at mount time, which authored or plugin-supplied content cannot register into. This registry is a DOM-walk implementation detail confined to the web side; it is not part of the normative hast-level projection and makes no claim that hast/mdast nodes carry distinguishable authored-vs-application provenance.

### §5.1a Shared implementation and invariant

`CanonicalTextProjectionV1` (the text-extraction rules in §5.1-§5.4) is implemented exactly once, in a package importable by both `@crowi/api` and `packages/web` (the Phase 2 executable spec picks the concrete package). The server calls it over a hast it builds server-side from a revision's mdast (its stored `renderedAst` for a snapshot, or its RFC-0009-regenerated display AST for an incremental); the web calls it over either (a) the same hast, computed client-side from the same mdast for a non-live historical/source revision view (revision reads already carry the mdast needed to render it — `packages/api-contract/src/schemas/page.ts:86-105`, `renderedAst` is emitted on single-revision detail), or (b) a DOM-walk equivalent for the currently-mounted `.crowi-prose` (§7). `projectionVersion` is bumped whenever the extraction rules in §5.1-§5.4 change, or whenever the upstream `escapeUnknownRawHtml`/`raw()`/`stripUnknownElements` sanitisation semantics change in a way that alters which text this pipeline emits.

**Invariant test (required, §13.1):** for a corpus of representative pages — including plugin-rendered output, raw HTML, tables, and code blocks — the server's projection of a revision's hast must equal the web's projection of that same revision's rendered DOM (with Crowi's own UI chrome walked past per the registry above). A projection-version bump must not ship without this corpus passing.

### §5.2 Text and whitespace normalization

Projection is a state machine over UTF-16 code units. It does not apply Unicode
normalization, case folding, locale transforms, smart punctuation, or entity
re-encoding.

For ordinary text nodes:

1. A maximal run of HTML ASCII whitespace — U+0009 TAB, U+000A LF, U+000C
   FF, U+000D CR, or U+0020 SPACE — emits one U+0020 SPACE.
2. The run collapses across adjacent inline element and text-node boundaries.
3. A pending U+0020 is discarded at stream start, stream end, and immediately
   before or after a canonical block newline.
4. Other code units, including U+00A0 NO-BREAK SPACE, are preserved exactly.

Inside `pre` elements (including shiki-highlighted fences, which arrive as raw HTML parsed by `raw()` into real `pre`/`code` elements — `render-mdast.ts:166-184`), text contents are emitted exactly as stored. An author-controlled `data-comment-anchor-whitespace` attribute has no effect. `<br>` emits U+000A LF in both ordinary and preserved modes.

This rule makes authored prose match its rendered whitespace rather than its
Markdown or raw-HTML source whitespace, while preserving code blocks. It is
stable under inline markup boundaries: for example, `hello <strong>wide</strong>
world` produces `hello wide world` regardless of how React split the text
nodes.

### §5.3 Block boundaries

Entering or leaving any corresponding hast block requests one canonical U+000A LF:

```text
ADDRESS ARTICLE ASIDE BLOCKQUOTE DETAILS DIALOG DIV DL DT DD
FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV
OL P PRE SECTION SUMMARY TABLE THEAD TBODY TFOOT TR TD TH UL
```

Boundary requests coalesce: there is never more than one consecutive canonical
LF solely because of element boundaries. Leading and trailing boundary LFs are
removed. Preserved text inside `pre` may itself contain consecutive LFs; those
are retained and are not boundary-generated. Table cell boundaries therefore
separate cells by one LF, and list-marker glyphs remain absent.

When a DOM selection crosses blocks, internally generated LFs are included in
`exact`. Generated LFs at the outer edge of a captured selection are removed
so selector endpoints map to real eligible text positions. A resolved interval
containing internal generated LFs maps to a DOM Range from its first to last
real text position.

### §5.4 Offset units and Unicode boundaries

`start`, `end`, `sourceLength`, context lengths, and match distances use
JavaScript/DOM UTF-16 code units. Intervals are half-open: `[start, end)`. This
matches JavaScript string slicing and DOM Range offsets. Capture endpoints and
context truncation must not split a UTF-16 surrogate pair; no normalization is
performed for combining sequences or grapheme clusters.

The stored `exact` is exactly `stream.slice(start, end)`. `prefix` is the
immediately preceding at-most-64-code-unit suffix of the source stream, and
`suffix` is the immediately following at-most-64-code-unit prefix. If a
64-code-unit cut would split a surrogate pair, the context is shortened by one
code unit.

### §5.5 Selection eligibility

#### Endpoint canonicalization

The DOM adapter maps each browser endpoint to a projection boundary with an
explicit affinity. A boundary within a collapsed ordinary-whitespace run maps
to the single emitted space: a start endpoint is **after** that space and an
end endpoint is **before** it; a selection wholly within one collapsed run is
therefore ineligible. At an inline-node boundary, start uses right affinity and
end uses left affinity, so equivalent browser boundary containers produce the
same half-open interval. A boundary adjacent to a generated block LF uses the
same inward affinity: leading/trailing generated LFs are removed, while a
cross-block selection retains an internal LF. Endpoints inside excluded UI, at
an unmappable raw/component boundary, or in a surrogate pair are ineligible;
they are not rounded. Capture verifies that mapping the resulting interval
back through the current adapter yields the selected eligible prose. These
rules intentionally make the DOM-to-stream relation many-to-one, but make the
captured interval unique.

The comment action is shown only when all of the following hold:

- the browser selection has exactly one non-collapsed Range;
- both endpoints are inside the same registered `.crowi-prose` root;
- every selected part maps to one contiguous canonical interval and does not
  enter an excluded subtree;
- after removal of outer generated block LFs, `exact` contains at least one
  non-whitespace code unit and is no longer than 4,096 UTF-16 code units;
- the canonical source stream is no longer than 2,000,000 UTF-16 code units,
  matching the server-side `sourceLength` resource bound; and
- the displayed page is a writable current, published revision.

Selections that include the footer, modal, browser chrome, another page root,
or a mixture of eligible and excluded content do not show the action. Draft,
trash, and historical-revision views do not show it.

### §5.6 Lazy persistence, versioning, and immutable source surfaces

The hast rules, whitespace state machine, block set, newline coalescing, offset unit, context size, and endpoint rules together define `textStreamVersion: 1`. A renderer or upstream sanitisation change must not silently alter these rules. A semantic change requires a new stream version and a resolver that can continue interpreting version 1.

A revision does **not** persist its own rendered AST or a projection at save time — that would force every revision, including the incrementals RFC-0009 deliberately keeps AST-less, to retain one. Instead, `CanonicalTextProjection` is a small, dedicated collection populated lazily: the first time any Comment is anchored against revision R (at create-time server validation, §6.2), the server computes R's hast (from R's stored `renderedAst` if it is a snapshot, or from R's RFC-0009-regenerated display AST if it is an incremental — a display AST is available at read time either way), runs `CanonicalTextProjectionV1` over it, and persists `{ revisionId: R, projectionVersion, text, computedAt }`. The record is immutable thereafter: every later anchor creation or resolution against R — by this Comment or any other — reuses it rather than recomputing it. This is what "freezes" R's selector semantics without RFC-0009 ever having to persist R's AST: whichever render happened to run at first-anchor time is locked in, and a later renderer upgrade cannot retroactively change what R's existing anchors resolve against.

`sourceSurfaceFingerprint` is the SHA-256 digest of that persisted `text`. If a revision's rendered output cannot be reconstructed at all (a corrupted or otherwise unsupported row) or a projection cannot be produced from it, the revision is `source-surface-unavailable`: it may still be read normally, but it cannot accept new v1 anchors and existing anchors show that explicit non-inline state. A fullscreen table or any React wrapper change only invalidates the ephemeral DOM mapper; it cannot alter selector offsets or the persisted projection.

The client never fetches this persisted record over the wire (§9): it independently computes an equivalent projection — from the same hast, for a non-live historical/source revision view, or via the DOM-walk equivalent for the currently-mounted `.crowi-prose` (§7) — using the same shared `CanonicalTextProjectionV1` implementation (§5.1a), and compares its own computed fingerprint to the anchor's stored `sourceSurfaceFingerprint`. The persisted `CanonicalTextProjection` collection exists purely so the *server* has a stable surface to re-validate a second or third anchor against the same revision without re-deriving it, and without trusting a client-submitted string; it is never exposed as a page/comment read payload field or a new endpoint (§9).

The 2,000,000-code-unit limit is the supported maximum for both source capture and displayed inline resolution. A larger displayed revision is `stream-too-large`: it remains readable and its footer remains complete, but v1 builds no projection index or inline badges for it. It may become inline-resolvable again on a later smaller revision.

Unknown versions degrade to `unsupported`: the comment and safely escaped quote
remain visible, but no body icon or jump target is produced. A future version
must be additive in the API union and must define its own capture, projection,
and migration policy.

## §6 Capture and Create Path

### §6.1 Browser capture

On an eligible selection, the page annotation controller:

1. builds or reuses the v1 `CanonicalTextProjectionV1` and current DOM mapper for the displayed revision;
2. maps the DOM Range into `[start, end)` and derives `exact`, `prefix`, `suffix`, `sourceLength`, and the nearest enclosing `data-section-id` (§5.1) as `sectionId` (or `null`) from that one stream;
3. shows a selection-adjacent comment action;
4. opens an anchored composer that renders `exact` as escaped plain text; and
5. submits the current page id, displayed revision id, plain comment body, and
   complete anchor object through the existing `useAddComment` mutation.

The existing hook currently accepts `revisionId`, `comment`, and optional
`commentPosition` (`packages/web/src/lib/use-page-comments.ts:76-90`). It is
extended with optional `anchor`; there is no second mutation or endpoint.

If the DOM revision changes, the selection collapses, or the mapped text no
longer equals `exact` before submit, the composer refuses submission and asks
the reader to select again. This prevents a delayed composer from pairing a
comment with a different revision or range.

### §6.2 Server validation

The API accepts anchorless comments unchanged. When `anchor` is present, it
enforces all of these conditions before `Comment.create`:

- `type === 'text-quote'` and `textStreamVersion === 1`;
- every field is present and of the declared type;
- `exact` is 1–4,096 UTF-16 code units and is not all whitespace;
- `prefix` and `suffix` are each at most 64 UTF-16 code units;
- `start`, `end`, and `sourceLength` are safe non-negative integers;
- `0 <= start < end <= sourceLength <= 2,000,000`;
- `end - start === exact.length` in UTF-16 code units;
- the strings contain no unpaired UTF-16 surrogate; and
- `sourceSurfaceFingerprint` is a 64-character lowercase SHA-256 hex digest;
- the loaded revision exists and belongs to the authorized page (§3.2); and
- the revision's `CanonicalTextProjection` (computed and persisted now if this is the first anchor against it, §5.6) has the submitted fingerprint, length, `[start, end)` exact text, and the submitted bounded prefix and suffix.

The server deliberately does not recreate the rendered DOM. It verifies the immutable text projection, which makes an anchor a verified statement about a source snapshot rather than arbitrary user-supplied quote metadata. It still does not prove the user personally made the selection. The server does not resolve anchors against every later revision or return a cached attachment.

A malformed, mismatching, or source-surface-unavailable anchor returns the existing structured invalid-request response and creates nothing. The entire validation runs before the plain, non-transactional (§3.1) `Comment.create` call. If `CanonicalTextProjection` needed to be computed for this revision, it is persisted before the Comment insert; that write is independently idempotent — if a racing second anchor against the same brand-new revision computes it too, both computations are byte-identical for the same revision by definition, so whichever write lands first (an upsert keyed by `revisionId`) wins harmlessly. A missing or mismatched revision returns the same not-found-style response used to hide page existence. Neither case creates a Comment, activity, watch change, count update, notification, or live event.

## §7 Deterministic Client Resolver v1

### §7.1 Inputs and output

The resolver takes one stored v1 selector, its source revision id, the displayed revision id, and the displayed revision's projection — computed by the client itself via the shared `CanonicalTextProjectionV1` (§5.1a), never fetched from the server (§5.6). It returns one of `pending`, `attached`, `ambiguous`, `orphaned`, `unsupported`, or `source-surface-unavailable`. An attached result contains the current `[start, end)` and a freshly mapped DOM `Range`; it never modifies the selector.

The page builds one projection per revision and one ephemeral mapper per mounted prose root. Occurrence scans are shared for selectors with the same `exact` string. The bounded scheduler in §11.5 resolves only admitted anchored comments and yields between batches. The footer is the complete, unpaged comment array (§9); it is not silently truncated to meet a performance target.

### §7.2 Resolution algorithm

For each selector:

1. If its stream version is not implemented, return `unsupported`.
2. If the displayed revision is the source revision, its verified fingerprint
   equals `sourceSurfaceFingerprint`, and `stream.slice(start, end) === exact`,
   return that interval. A source-revision fast path is unavailable when the
   immutable surface is missing or differs.
3. Enumerate every (including overlapping) current-stream occurrence for which
   `stream.slice(candidateStart, candidateStart + exact.length) === exact`.
4. With zero occurrences, return `orphaned`.
5. With one occurrence, select it — a unique exact match attaches without a context check.
6. With multiple occurrences, compute for each candidate:
   - `prefixAgreement`: the UTF-16 length of the longest suffix of stored
     `prefix` equal to text immediately before the candidate;
   - `suffixAgreement`: the UTF-16 length of the longest prefix of stored
     `suffix` equal to text immediately after the candidate;
   - `contextScore = prefixAgreement + suffixAgreement`;
   - `storedContextLength = prefix.length + suffix.length`;
   - `projectedStart = round((start / sourceLength) * currentLength)`; and
   - `localityDistance = abs(candidateStart - projectedStart)`.
7. Discard any candidate whose `contextScore` is below the v1 minimum-context threshold: `min(4, storedContextLength)` UTF-16 code units — at least 4 code units of combined agreement, or full agreement when the stored context itself was shorter than 4 code units (a quote at the very start/end of the stream never had more to agree with). Locality is never sufficient on its own: a candidate with zero context agreement is discarded even if it is the only remaining one and even if it sits closest to `projectedStart`. If no candidate meets the threshold, return `ambiguous`.
8. Retain the threshold-passing candidates with the highest `contextScore`. If more than one remains and the stored anchor recorded a nearest-enclosing `sectionId` (§4.1, §5.1), retain only the candidates whose own nearest enclosing section matches it, when at least one does — this is consulted purely as a tie-break, never as a primary filter, and is skipped entirely when the anchor has no recorded `sectionId` or no candidate's section matches. If more than one still remains, retain those with the lowest `localityDistance`. Attach only if exactly one candidate remains after all three tie-breaks; otherwise return `ambiguous`. There is no lowest-offset correctness tie-break.
9. Map the selected interval to a DOM Range. If the tree is changing or unmounted, remain `pending` and retry after it settles. If mapping still fails against the settled index, return `orphaned` and isolate the failure to that Comment.

Checking whether `exact` exists at the old absolute offset may optimize the occurrence scan on a different revision, but it must not short-circuit the context/section/locality ordering. Only the verified source-revision fast path in step 2 can do so.

`ambiguous` is never drawn at an arbitrary occurrence or at multiple
occurrences. The footer displays the original quote, source revision link, and
an explicit "multiple matching passages" label. It has no body icon or jump
target.

### §7.3 Deliberately absent matching

The resolver does not use case folding, locale comparison, Unicode
normalization, whitespace normalization beyond the canonical stream, regular
expressions, stemming, edit distance, semantic similarity, Markdown-source
search, or a fuzzy fallback. If the selected text itself changes by one code
unit, that selector is orphaned until an exact copy reappears.

## §8 Web Interaction and Presentation

### §8.1 Page-level controller

`PageView` is the coordination boundary because it already renders `PageContent`
immediately before the footer comment surfaces
(`packages/web/src/components/page-view/page-view.tsx:733-773`). A page-level
annotation controller owns:

- the `.crowi-prose` root registration and revision-keyed text index;
- selection capture;
- the page comment query result;
- `Map<commentId, AnchorResolution>`;
- grouping attached comments by resolved `[start, end)`; and
- overlay geometry and anchored-modal state.

The overlay must not wrap, split, or rewrite prose text nodes. Doing so would
change the very stream being indexed. Icons are positioned outside the prose
subtree from DOM Range rectangles and recomputed on resize, font load, image
load, and other layout changes. Geometry changes do not trigger selector
resolution unless the text index changed.

### §8.2 Inline icon and anchored-comment modal

Comments resolving to the same `[start, end)` share one accessible icon/badge
with a count. Overlapping but non-identical ranges remain distinct groups.

Activating the icon opens an anchored-comment modal containing exactly the
normal Comment rows in that resolved-range group. It is a filtered projection
of the same page query, not separately fetched or persisted data. It remains
flat and preserves the existing newest-first order. Existing ownership-based
delete behavior may be offered inside the modal on a writable current page.

On a writable current revision the modal includes a composer for another
comment at that anchor. Submission recaptures a fresh selector from the current
resolved Range and saves the currently displayed revision id as the new
Comment's source revision. It does not copy an older Comment's source offset or
revision. This keeps each Comment an independent immutable statement about the
revision on which it was authored.

The modal does not add a parent id, reply id, thread id, nesting level, resolved
state, or thread-specific API. Closing it returns focus to the icon. Live list
refetches update its filtered contents; if deletion removes its final Comment,
the modal closes and the icon disappears.

### §8.3 Footer list

The footer remains the complete logical newest-first list for the page, served as the complete unpaged array (§9, §11.5). Legacy comments render exactly as before. Each anchored comment additionally shows:

- the original `exact` quote as escaped plain text;
- whether it is attached to the displayed revision, ambiguous, orphaned,
  unsupported, source-surface-unavailable, stream-too-large, or capacity-limited;
- a link to the authorized source revision; and
- when attached, a control that scrolls to and focuses/highlights the body
  range.

An orphan, ambiguous, or source-surface-unavailable label explains why no
inline target is shown. It never implies deletion or low confidence. Clicking
its quote does not jump to a similar string; the source-revision link is the
recovery path.

### §8.4 Historical, deleted, and draft views

The current `PageView` suppresses all footer comments while a stale revision is
shown (`packages/web/src/components/page-view/page-view.tsx:737-773`). This RFC
changes that behavior: a historical revision shows the complete page comment
list and resolves all supported anchors against the displayed historical body.
Inline icons and the anchored modal are read-only. There is no selection action,
composer, or delete operation in the historical view.

This can attach a Comment on its source revision, orphan it on an intervening
revision, and attach it again on a later revision without rewriting history.
Comments created after the displayed revision still appear because the footer
is page history, not a revision-filtered alternate store; their source revision
label makes the chronology explicit.

Trash pages retain their existing read-only comment policy
(`packages/web/src/components/page-comments/page-comments.tsx:21-35,156-160`):
anchors may resolve and open read-only, but selection, creation, and deletion
are unavailable. Drafts retain the existing no-comments policy.

## §9 API Contract / OpenAPI Effects

The implementation changes the typed contract in these additive ways:

- add `CommentTextAnchorV1Schema` (including the optional `sectionId`) and its inferred type;
- add `anchor: CommentTextAnchorV1 | null` to `CommentSchema`;
- add optional `anchor` to `AddCommentRequestSchema`;
- document validation bounds, capacity/rate errors, and the revision/page
  ownership failure; and
- preserve add/delete/list endpoints, wire shape, and `commentPosition` unchanged — `GET /comments` keeps returning the complete, unpaged `{ comments: [...] }` array (§11.5, §17); this RFC ships no cursor pagination and no compatibility-window envelope.

The route definitions currently expose one GET/POST/DELETE comment resource (`packages/api-contract/src/contracts/comment.ts:29-122`, `packages/api-contract/src/schemas/comment.ts:17-27`). No new route is introduced for modal filtering, resolution, or the `CanonicalTextProjection` record — it is a server-internal persistence detail (§5.6), never a response field or a separate endpoint. The CLI continues to add anchorless comments because the request field is optional; its existing add path obtains the required revision id from the current page (`packages/cli/src/commands/comment.ts:72-76`). It may display anchor metadata later but is not required to resolve DOM ranges.

Contract work must regenerate and commit the OpenAPI JSON, YAML, and generated
TypeScript artifacts with `pnpm check:openapi` in the implementation change.

## §10 Failure Handling

- **Invalid selector:** reject the create request; do not partially create a
  Comment.
- **Revision missing or belongs to another page:** return the existing
  not-found-style error and create nothing.
- **Unknown stream version:** preserve the Comment and quote, render
  `unsupported`, and produce no inline icon.
- **Exact text absent:** derive `orphaned`; retain the footer item and source
  link.
- **Multiple equally supported exact matches:** derive `ambiguous`; retain the
  footer item and source link, with no inline icon or jump target.
- **Missing or fingerprint-mismatched immutable surface:** derive
  `source-surface-unavailable`; never reinterpret the anchor using a newly
  rendered AST.
- **Displayed projection exceeds 2,000,000 code units:** derive `stream-too-large`; retain full footer visibility but do not build inline state.
- **Resolver exception:** isolate it per Comment, report it through normal
  client diagnostics, and degrade to `orphaned` only after pending DOM work has
  settled. Never suppress the footer or other anchors.
- **DOM revision, fullscreen, or wrapper change:** discard the old DOM mapper,
  range objects, overlay groups, and modal selection, then map the already
  resolved AST interval against the current root.
- **Layout-only change:** recompute icon rectangles without changing resolution.
- **Missing/corrupt source revision:** retain the page-owned Comment, label the
  source unavailable, and preserve existing authorized deletion behavior.
- **Live-frame loss or duplication:** the next full query result remains
  authoritative; no incremental selector mutation is inferred.

## §11 Security, Privacy, Correctness, and Resource Bounds

### §11.1 Authorization and integrity

- Page grants and comment scopes remain mandatory on every route.
- The API verifies revision/page ownership from immutable ids and verifies every submitted selector against the revision's `CanonicalTextProjection` (§5.6, computed and persisted lazily on first use). It does not trust the submitted pair or selector strings.
- A source-revision link uses the existing authorized revision read; it does not
  expose a body after page access is lost.
- Not-found-style failures continue to hide whether an inaccessible page or
  revision exists.
- An accepted anchor is proof only that its quote and positions occur in the
  stored source surface; it is not proof that the commenter personally selected
  or saw it. UI labels it "quoted from revision", never "verified selection".

### §11.2 XSS and DOM safety

The page render path accepts raw HTML into the HAST/React conversion
(`packages/web/src/components/editor/render-mdast.ts:158-194`). Therefore
`exact`, `prefix`, `suffix`, and comment bodies are always untrusted strings.
They must be rendered through React text nodes only. Selector content must
never be passed to `dangerouslySetInnerHTML`, `querySelector`, an element id,
CSS, a URL fragment, or executable markup. DOM mapping uses stored numeric
segments and actual text nodes, not selector interpolation.

The overlay is outside `.crowi-prose` and marked excluded from anchoring. It
must never mutate prose text nodes or insert its own label into the canonical
stream.

The renderer's existing raw-HTML allowance is broader than the selector-string threat modelled above: `known-tags.ts` treats `script`, `style`, `iframe`, and `form` as *known* (not stripped) tags (`packages/web/src/components/editor/known-tags.ts:62,75,108,117`), and at least one component override forwards a raw element's remaining props verbatim onto its rendered DOM node (`packages/web/src/components/page-view/page-content.tsx:447`, the `div` override). This is pre-existing renderer behaviour, not something this RFC introduces, but the selection action, inline badges, and modal are a new interactive surface layered on the same page — Phase 3/4 must confirm active or styled raw content already accepted by the renderer cannot spoof, obscure, or intercept the selection action or badge overlay, with adversarial tests (§13.4, §16 OQ2); this RFC does not redesign the renderer's raw-HTML sanitisation boundary itself.

### §11.3 Privacy and live transport

`exact`, `prefix`, and `suffix` may contain private page text. They are returned
only wherever the normal Comment is returned, under the owning page's grant.
Notifications, activity payloads, logs, analytics, and `comment-changed` frames
must not newly copy quote or context text. The existing identity-only live
payload is preserved (`packages/api/src/events/presence-broadcast.ts:121-152`).

Client caches must be invalidated under the same grant-revocation behavior as
the page and normal comments. An inline icon or stale modal must disappear when
the authorized refetch no longer returns the Comment.

### §11.4 False attachment

False attachment is a correctness and trust problem, not cosmetic placement. The exact-only requirement, minimum-context threshold, section discriminator, and locality rule (§7.2) are normative only as evidence for a unique candidate, applied in that strict order — locality alone never attaches repeated text that fails the context threshold. A tie produces `ambiguous`, not a deterministic attachment. UI must not describe a resolved candidate as approximate. Any future fuzzy policy requires a separate design with confidence semantics and explicit false-positive handling.

### §11.5 Resource bounds

- Request limits cap `exact` at 4,096, context at 64 code units per side, and
  `sourceLength` at 2,000,000.
- A page admits at most 200 anchored Comments, and at most 10 anchored creates per author/page per rolling hour. Because comment creation is not transactional (§3.1), these are enforced as single-document atomic counters, not a racy count-then-insert check: a per-page `AnchoredCommentCount` document is updated with `findOneAndUpdate({ page, count: { $lt: 200 } }, { $inc: { count: 1 } }, { upsert: true })` — atomic on standalone Mongo without a multi-document transaction — and the 201st concurrent create fails that filter and is rejected with a structured capacity error; deleting an anchored Comment decrements the same counter. The rolling-hour per-author limit uses the equivalent pattern keyed by `{ page, author, hourBucket }`, with a TTL index expiring stale buckets. This makes both limits exact under concurrency, unlike a plain count query.
- `GET /comments` keeps returning the complete, unpaged array (§9); it is not cursor-paginated in v1. The per-page volume this RFC assumes in practice is bounded primarily by the 200-anchored-Comment admission cap above, not by the endpoint itself — an unbounded number of anchorless legacy Comments can still exist on one page, exactly as today. Cursor pagination for the general case is future work (§17), gated behind an explicit, versioned contract change rather than shipped as a "legacy compatibility window."
- The client resolves anchors from the complete fetched array, but stops at the 200 admitted-anchor ceiling; legacy and over-limit grandfathered anchors remain footer-visible as `not-inline-capacity` and have no icon until an admitted anchor is deleted. Thus one tab never attempts unbounded inline work.
- The page builds one canonical projection and one ephemeral DOM mapper per
  mounted revision. Equal exact strings share occurrence scans.
- Resolution uses batches of at most 10 unique quotes and yields with `scheduler.postTask({ priority: 'user-visible' })` (or `setTimeout(0)` when unavailable) after at most 8 ms of synchronous work. A single quote's occurrence scan over the full stream is itself synchronous work the batch boundary cannot preempt; Phase 2 must make the per-quote scan chunkable (yielding mid-scan, not only between quotes) or move it off the main thread (a Worker), and must define cancellation when the displayed revision or prose root changes mid-scan (§16 OQ3) — this is an implementation gate, not a design choice this RFC needs to pre-select.
- The supported fixture is a 2,000,000-code-unit stream with 200 anchored comments / 200 unique quotes (including repeated and 4,096-unit quotes). It must build plus resolve within 750 ms total, produce no task over 16 ms, and keep first 10 badge results available within 100 ms after the prose root commits, measured on a benchmark environment the Phase 2 implementation spec pins concretely (machine class, browser + flags, warm-up runs, and variance tolerance, §16 OQ4) so the gate is reproducible outside the original implementation's machine — an unspecified "project reference Chromium hardware" is not sufficient on its own.
- Fuzzy or regex matching is absent.
- One malformed selector cannot block other comments.
- The footer is never truncated or hidden as a resource-control shortcut.

### §11.6 Accessibility

- Selection actions and inline badges are keyboard reachable and have labels
  that include the quote summary and comment count.
- Range highlights are not the only indicator; the complete footer remains
  usable without pointer selection or overlay positioning.
- Modal focus is trapped while open and returns to its triggering badge.
- Quote-to-body navigation moves focus as well as scroll position and respects
  reduced-motion preferences.
- Attached, orphaned, unsupported, and read-only states are conveyed in text,
  not color alone.

## §12 Migration and Backward Compatibility

### §12.1 Revision ownership migration

`Revision.page` — the immutable ObjectId reference this RFC's create-time ownership check (§3.2) depends on — does not yet exist on `Revision` (`packages/api/src/models/revision.ts:23-49`; ownership today is carried only by the mutable `path` string). Adding it, backfilling existing rows, and cutting authorization over to it is a full expand/backfill/verify/cutover migration in its own right, and is already owned end-to-end by `.feature-state/specs/feature-revision-page-ref.md` (TRIAGE #19): that spec's AC-1/AC-2 add and backfill the field (by matching each legacy revision's current `path` to the one live Page currently holding that path — `Page` has no separate revision-history collection to cross-check against, so this current-path match, valid for the standard rename/delete code paths, is the real provenance source, not a "revision history" lookup); its AC-3/AC-4 switch `Revision`-to-`Page` resolution off `path` and onto the id; and its own open question governs how a non-standard orphaned revision (one whose path matches no live Page) is logged and left for manual repair rather than guessed at.

This RFC does not re-derive that migration. It depends on it: anchored comment creation (§3.2) must not be enabled until that spec's cutover has completed and `Revision.page` is populated and trustworthy for live pages. Anchorless comment creation is unaffected and requires no gate — it keeps accepting the client-supplied revision id exactly as it does today, independent of this migration's state.

Distinct from that Revision→Page migration (which *does* backfill existing rows, per the dependency above), the Comment schema addition in this RFC is itself additive and needs no backfill:

- existing Comment rows have all anchor fields absent and serialize as
  `anchor: null`;
- old and new anchorless comments remain listable, creatable, deletable,
  counted, notified, auto-watched, and live-synced;
- `commentPosition` remains stored and returned, with its current `-1` default,
  but is deprecated and never reinterpreted;
- old clients omit `anchor` and continue to work;
- clients that do not implement inline resolution can ignore `anchor` and keep
  showing the normal comment body;
- no separate `CommentAnchor` collection or anchor-specific delete cascade exists; the admission-control counters (§11.5) are a small dedicated collection keyed by page/author, not a `Comment`-schema migration; and page deletion removes page-owned Comments through the existing cascade (§3.1); and
- resolution state has no migration because it is never stored, and the lazily-persisted `CanonicalTextProjection` (§5.6) has no legacy rows to migrate — it does not exist before this RFC ships.

## §13 Tests and Acceptance Criteria

### §13.1 Canonical stream fixtures

Golden fixtures freeze the v1 stream, segment map, and capture result for:

- inline emphasis, strong text, links, inline code, and text split across React
  nodes;
- paragraphs, headings, blockquotes, lists, nested lists, details/summary,
  tables, and `<br>`;
- fenced/preformatted code with repeated spaces and newlines;
- ordinary HTML whitespace collapse, NBSP, CR/LF/TAB input, and block-newline
  coalescing;
- Unicode surrogate pairs, combining characters, and context truncation beside
  a surrogate pair;
- raw HTML and unknown-tag handling;
- plugin-rendered prose, participating as ordinary text (§5.1), alongside Crowi's own UI chrome (copy button, heading-anchor link, comment badge) and forged `data-comment-anchor-exclude`/`hidden`/`aria-hidden` attributes, confirming none of the latter affect the stream;
- section-id capture and tie-break behaviour (§5.1, §7.2) across wrapped and unwrapped heading sections; and
- selections spanning inline nodes and block boundaries.

The same corpus backs the required server-vs-web invariant test (§5.1a): the server's projection of a revision's hast must equal the web's projection of that revision's rendered DOM.

Any intended fixture change requires either proof that the v1 normative rules
were previously implemented incorrectly or a new `textStreamVersion`.

### §13.2 Pure resolver tests

- The verified source offset resolves immediately on the source revision.
- Insertion/deletion before an unchanged quote re-anchors it.
- Context above the minimum threshold chooses among repeated exact strings.
- All candidates below the minimum-context threshold resolve to `ambiguous`, even when one candidate is closest to the projected locality — locality alone never attaches.
- Equal above-threshold context, differing section id, chooses the same-section candidate.
- Equal above-threshold context and section (or no recorded section) chooses projected locality.
- Equal context, section, and locality is `ambiguous` and produces no inline target.
- Overlapping exact occurrences are enumerated.
- Changed or deleted exact text becomes orphaned and never fuzzy-matches.
- Reintroduction/rollback changes orphaned back to attached without a write.
- Unknown versions and malformed persisted tuples do not affect other comments.
- An unmounted/changing DOM remains pending rather than flashing orphaned.

### §13.3 API/model tests

- A valid anchor round-trips through Mongo, the typed contract, and OpenAPI.
- Anchorless old and new comments preserve current responses and side effects.
- Partial, oversized, whitespace-only, unsafe-integer, inconsistent-offset, and
  unpaired-surrogate anchors are rejected.
- A revision belonging to another page cannot be submitted even if the caller
  can comment on the requested page.
- A selector whose quote, contexts, offsets, length, or fingerprint do not match the revision's `CanonicalTextProjection` is rejected; a valid source projection passes, whether newly computed on this create or reused from a prior anchor against the same revision.
- The same revision ownership validation applies without an anchor.
- Missing/grant-denied/mismatched identities preserve existence hiding.
- Create/delete still preserve activity, notifications, comment count,
  auto-watch, post-durability events, and page-delete behavior.
- Concurrent create versus hard delete is **not** assumed serializable (§3.1): the accepted rare interleaving can leave one dangling Comment referencing a deleted page id, and a test confirms it is invisible through the existing grant-boundary read path (§3.2) rather than asserting it cannot exist. Create versus rename retains immutable ownership because `Revision.page` never changes on rename.
- A concurrent burst of creates at the 200-anchor or 10-per-hour boundary rejects exactly the excess requests — never more, never fewer — via the atomic counter update (§11.5), not a racy count-then-insert check.
- Anchored comment creation is rejected before the `feature-revision-page-ref` cutover completes (§12.1) and accepted after, without re-testing that migration's own expand/backfill/verify/cutover mechanics here.
- CLI add/list remains compatible when it omits `anchor`.

### §13.4 UI and integration tests

- Only an eligible selection on a writable current revision exposes the action.
- Saving creates one normal footer Comment, one quote display, and one body
  badge.
- Same-range Comments group in one badge and one flat modal but remain separate
  footer rows.
- Posting from the modal captures the current revision and current selector.
- No reply/thread fields or nested presentation appear.
- Footer order remains newest-first across the complete unpaged array and includes anchored, ambiguous, orphaned, capacity-limited, and legacy comments.
- Footer quote navigation and modal focus behavior are keyboard accessible.
- A new revision with unchanged text retains the anchor; changed text displays
  the explicit past-revision/orphan state and source link.
- Historical and trash views show anchors/read-only modal without create or
  delete actions; drafts show no comments.
- A second browser's add/delete updates footer, badge grouping, and open modal
  through the existing full refetch without duplicate rows.
- Selector strings cannot inject HTML, selectors, ids, or URL fragments.
- Active raw content already accepted by the renderer (`script`/`style`/`iframe`/`form`, §11.2) cannot spoof, obscure, or intercept the selection action, badge overlay, or modal.

### §13.5 Performance tests

Benchmarks use the exact §11.5 supported fixture: a 2,000,000-code-unit stream, 200 anchored Comments / 200 unique quotes, repeated and 4,096-unit quotes, run against the reproducible benchmark environment §11.5 requires the Phase 2 spec to pin. They measure the 750 ms total, 16 ms longest task, 100 ms first-10-badge budgets, the chunkable/cancellable scan behaviour (§11.5), projection reuse, and overlay reflow. Failure of any numeric budget rejects the resolver implementation.

## §14 Alternatives Considered

### §14.1 Raw absolute offset or legacy `commentPosition` only

An absolute position is cheap and can resolve the source snapshot, but any
insertion before the selection shifts it. Reusing `commentPosition` would also
silently change a legacy wire field without a version, context, source length,
or selector semantics. Rejected. Position remains only a locality hint inside
the versioned hybrid selector.

### §14.2 Markdown-source offsets

Markdown offsets are stable to store and easy for the server to inspect, but
the reader selects rendered text, not link syntax, emphasis delimiters, HTML,
or plugin source. Mapping source offsets through transforms back to the final
DOM would duplicate renderer logic and still fail for generated output.
Rejected.

### §14.3 mdast paths or DOM node paths

The render tree has no durable paragraph/inline identity; headings provide only
coarse sections. Ordinary insertions and renderer/plugin changes shift child
indexes. A node path is useful only as a snapshot optimization, not a durable
cross-revision anchor. Rejected.

### §14.4 Server-side resolution on every list/read

The API could rebuild a text stream for every target revision and return resolved offsets. That adds CPU to every comment refetch, turns an individual tab failure into an API availability risk, and still leaves the web to map the interval to a live DOM `Range`. Rejected. The server instead validates the submitted source snapshot once, at create time; the client independently projects each revision's rendered output (§5.1a) and resolves later revision surfaces locally.

### §14.5 DOM-derived stream versus hast-based projection

A live DOM stream would make browser mapping convenient, but it is not a revision snapshot: fullscreen table presentation can reparent content, and renderer components can add wrappers or controls without changing a revision. It cannot therefore keep v1 offsets durable. A pure projection over the shared hast pipeline (§5.1), lazily frozen per revision at first anchor rather than persisted for every revision (§5.6), plus DOM traversal only for post-resolution Range mapping, keeps browser-owned positioning while freezing selector semantics. Chosen. The server shares that pure projection only for create-time validation; it does not resolve list reads.

### §14.6 Save-time or per-revision materialization

Precomputing every Comment's position for every new revision makes reads cheap
but multiplies writes by comments × revisions and requires jobs, retries,
partial-state UI, cache invalidation, new storage, and delete cascades. Crowi
does not have stable block identities to make that materialization reliable.
Rejected.

### §14.7 Yjs `RelativePosition`

`Y.RelativePosition` is appropriate for locations inside one evolving Yjs
document, but comments remain outside the Yjs document under RFC-0003 and Crowi
stores durable full revisions. A relative position does not define the rendered
DOM text after Markdown/plugin transforms and does not survive compaction as a
self-contained revision selector. Rejected as durable storage.

### §14.8 Fuzzy matching in v1

Fuzzy anchoring could keep a Comment attached after the quote itself is edited,
but it introduces false positives, confidence thresholds, ambiguous UI,
dependency choices, and potentially expensive worst-case matching. Those are
distinct product and correctness decisions. Rejected for v1; recorded as
future work (§17).

### §14.9 In-band Markdown markers or stable block annotations

Embedding markers in Markdown, or introducing Notion-style stable block/rich
text ids, would make anchors durable but changes page syntax, collaboration,
copy/paste, renderer plugins, exports, and merge behavior for a feature that can
be additive to Comments. Rejected unless Crowi later adopts a stable block model
for broader reasons.

### §14.10 Separate annotation/thread resource

A dedicated annotation with child replies could model a richer discussion
system, but it duplicates current Comment authorization, activity,
notifications, count, deletion, queries, and live events. The required UI is a
filtered view of flat Comments, not a new thread lifecycle. Rejected. Nested
threads remain future work.

### §14.11 Persisting the canonical projection (or the AST) on every revision

The projection could instead be computed and persisted once per revision at save time — mirroring how `renderedAst` itself used to be stored on every revision before RFC-0009. This was this RFC's original design and directly conflicts with RFC-0009's storage lever: RFC-0009 deliberately keeps incremental revisions AST-less and regenerates a display AST on read specifically to avoid persisting a redundant near-duplicate artifact on every save in an active editing burst (`docs/rfcs/0009-revision-storage-compaction.md:27-31,289-331`). Forcing every revision to retain a projection would reintroduce exactly the storage cost RFC-0009 removed, and would require re-opening a design RFC-0009 already marked design-complete. Rejected. Lazily persisting the projection only the first time a revision is actually anchored (§5.6) gets the same "frozen surface" property without touching RFC-0009 at all: unanchored revisions — the overwhelming majority in any active editing burst — never pay this cost.

## §15 Phased Plan

The RFC is implemented through phase-specific executable specs after this
document is approved and committed.

### §15.1 Phase 1 — Shared projection, contract, persistence, and ownership integrity

- Implement `CanonicalTextProjectionV1` (§5.1-§5.4) once, in the package both `@crowi/api` and `packages/web` import (§5.1a) — this phase's server-side validation work below depends on it existing first, not on a later phase.
- Add the `CanonicalTextProjection` collection and its lazy-persist-on-first-anchor write path (§5.6).
- Depend on (do not re-derive) the `.feature-state/specs/feature-revision-page-ref.md` `Revision.page` migration; gate anchored comment creation on its cutover completing (§12.1). Anchorless creation is ungated.
- Add the v1 selector schemas (including `sectionId`) and optional request/nullable response field.
- Add flat nullable Comment fields (including `anchorSectionId`) and response mapping.
- Validate selector bounds, `CanonicalTextProjection` fingerprint/content, revision/page ownership, and the atomic per-page/per-author admission counters (§11.5) for every creation — all as plain, non-transactional reads/writes (§3.1); no `Page` lifecycle field is introduced.
- Preserve `commentPosition`, CLI compatibility, hooks, auto-watch, counts, notifications, activity, deletion, and identity-only events. `GET /comments` keeps its existing complete, unpaged response shape.
- Regenerate OpenAPI artifacts and add focused API/model tests, including the server-side half of the §5.1a invariant test.

This phase integrates semantically with concurrent comment-count atomicity and
page-delete-cascade work: anchor persistence must not replace Comment hooks or
introduce another page-owned collection. It integrates with any presence-bus
refactor only through the public `comment-changed` refetch semantics.

### §15.2 Phase 2 — Client-side projection, DOM mapper, and resolver

- Wire the web side of `CanonicalTextProjectionV1` (§5.1a): a hast-based path for historical/source revision views, and a DOM-walk equivalent (with the Crowi-UI-chrome `WeakSet` registry, §5.1) for the live current revision.
- Implement the deterministic resolver (§7), including the minimum-context threshold and section-id tie-break (§7.2), and a separate ephemeral DOM mapper with the exact endpoint-affinity contracts.
- Make the per-quote occurrence scan chunkable/cancellable (§11.5) so the 10-quote batch/yield policy can actually hold its per-task budget.
- Add golden hast fixtures (§13.1), the client half of the §5.1a invariant test, DOM-mapping fixtures (including fullscreen reparenting), ambiguous-repeat and section-tie-break tests, malformed-data isolation, and the fixed §11.5 performance benchmarks against a pinned, reproducible benchmark environment.

### §15.3 Phase 3 — Page selection, overlay, modal, and footer

- Register the `.crowi-prose` root with a page-level annotation controller.
- Add the accessible selection action and anchored composer.
- Add non-mutating range overlays and same-range grouping.
- Add the flat anchored-comment modal and same-anchor creation.
- Extend footer items with quotes, state, source links, and reverse navigation.
- Enable complete read-only comments/anchors on historical revisions and retain
  trash/draft restrictions.
- Decide and test the remaining overlapping-icon collision presentation (§16).

### §15.4 Phase 4 — End-to-end behavior, docs, and hardening

- Cover current, historical, trash, draft, permission, repeated-text, orphan,
  rollback, live add/delete, accessibility, and injection scenarios in E2E.
- Verify long-page responsiveness and layout recomputation in real browsers.
- Update English and Japanese comment/revision user documentation.
- Document `commentPosition` deprecation and selector versioning for API
  consumers.

## §16 Open Questions

No blocking persistence, matching, revision, or resolution-semantics questions remain. The following are implementation-scoped gates for later phases; none may alter the stored selector, exact-plus-threshold resolution rule, flat Comment model, complete unpaged footer, or modal-without-threads decisions:

1. **Overlapping-icon collision presentation.** Same-range Comments are grouped,
   but non-identical overlapping ranges can produce badges with the same visual
   rectangle. The Phase 3 spec must choose the exact stacking/gutter layout and
   narrow-viewport behavior while preserving one deterministic badge per
   resolved range and keyboard reachability.
2. **Raw-HTML containment for the new interactive surface (§11.2).** The renderer already accepts `script`/`style`/`iframe`/`form` as known tags; Phase 3/4 must confirm the selection action, badges, and modal cannot be spoofed or obscured by content already permitted today, with adversarial tests. This RFC does not redesign the renderer's sanitisation boundary itself.
3. **Chunkable/cancellable occurrence scanning (§11.5).** The 10-quote batch/yield policy cannot preempt a single quote's full-stream scan as specified; Phase 2 must make the scan itself chunkable or move it to a Worker, with defined cancellation on revision/root change.
4. **Reproducible performance benchmark environment (§11.5, §13.5).** The 750 ms/16 ms/100 ms budgets need a pinned machine class, browser + flags, warm-up policy, and variance tolerance so the gate is reproducible outside the original implementation's machine.

## §17 Future Work

- A separately reviewed bounded fuzzy matcher with explicit confidence and
  false-positive UI.
- Nested replies/threads, resolution state, and discussion workflows.
- Multiple disjoint ranges per Comment.
- Non-web resolver libraries if another rich client can reproduce the same
  versioned rendered surface.
- A later canonical stream version if renderer requirements outgrow v1.
- Stable block identities only as part of a broader page/block architecture.
- Cursor-paginated comment listing, as an explicit versioned contract change (not a "legacy compatibility window"), if per-page comment volume ever outgrows the complete-array contract (§11.5).

## §18 References

- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
- [W3C Web Annotation Vocabulary](https://www.w3.org/TR/annotation-vocab/)
- [Hypothesis: Fuzzy Anchoring](https://web.hypothes.is/blog/fuzzy-anchoring/)
- [Yjs Relative Positions](https://docs.yjs.dev/api/relative-positions)
- `packages/api/src/models/comment.ts`
- `packages/api/src/models/revision.ts`
- `packages/api/src/models/page.ts`
- `packages/api/src/hono/handlers/comment.ts`
- `packages/api/src/events/presence-broadcast.ts`
- `packages/api/src/renderer/serialize.ts`
- `packages/api/src/renderer/core/headings.ts`
- `packages/api/src/renderer/core/code-block-dispatch.ts`
- `packages/plugin-api/src/renderer.ts`
- `packages/collab/src/compaction.ts`
- `packages/api-contract/src/schemas/comment.ts`
- `packages/api-contract/src/schemas/presence.ts`
- `packages/api-contract/src/schemas/page.ts`
- `packages/api-contract/src/contracts/comment.ts`
- `packages/web/src/lib/use-page-comments.ts`
- `packages/web/src/components/page-comments/page-comments.tsx`
- `packages/web/src/components/page-comments/comment-item.tsx`
- `packages/web/src/components/page-view/page-view.tsx`
- `packages/web/src/components/page-view/page-content.tsx`
- `packages/web/src/components/editor/render-mdast.ts`
- `packages/web/src/components/editor/known-tags.ts`
- `packages/cli/src/commands/comment.ts`
- `docker-compose.yml`
- `docs/rfcs/0002-renderer-plugin-architecture.md`
- `docs/rfcs/0003-realtime-collaborative-editing.md`
- `docs/rfcs/0005-page-presence.md`
- `docs/rfcs/0009-revision-storage-compaction.md`
- `.feature-state/specs/feature-revision-page-ref.md`
- `.feature-state/specs/feature-multidoc-write-atomicity.md`
- `docs/rfcs/0017-collab-invalidate-on-rename-delete.md`

