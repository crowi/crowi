# RFC-0003: Real-time Collaborative Editing

- **Status**: Draft (round 2 — integrated with RFC-0002 round 3 contracts)
- **Target**: Crowi 2.1 release
- **Owner**: TBD
- **Last updated**: 2026-05-12
- **Depends on**: RFC-0001 (Plugin Architecture), RFC-0002 (Renderer Plugin Architecture, round 3)
- **Related**: RFC-0004 (Editor UX Enhancement, future), RFC-0005 (Page Presence, future), RFC-0008 (Migration Command Framework, future)

## Summary

Add real-time collaborative editing to Crowi 2.1, using Yjs as the
synchronisation engine and Hocuspocus as the WebSocket backend. Multiple
users can edit the same page simultaneously; their changes converge
deterministically via CRDT semantics; the canonical Markdown source is
periodically materialised to a `Revision` document on explicit save,
which simultaneously invokes the renderer pipeline from RFC-0002.

This RFC covers the **synchronisation layer**, the **persistence
strategy**, the **editor stack**, and **save semantics**. It deliberately
excludes editor UX enhancements — autocomplete and paste/D&D upload are
deferred to RFC-0004, while toolbar and slash commands are not owned by
any RFC — and page-level presence (avatar stack, viewer count) which is
deferred to RFC-0005.

## Round 2 changes

- Persistence model aligned with **RFC-0002 round 3**: `Revision.body`
  is the per-save Markdown snapshot, `Revision.renderedAst` is the
  per-save mdast JSON output. `Page.body` remains the canonical
  pointer-to-current-content.
- **Save transaction contract** explicitly defers to RFC-0002's
  `Revision.prepareRevision()` helper; this RFC documents *when* save
  is triggered, not *what* save does internally.
- **`mode: 'edit'` semantic** clarified: the editor never invokes the
  renderer pipeline for embeds; placeholders only. Aligned with
  RFC-0002 round 3's mode enum.
- **`pageEvent` contract** referenced for RFC-0005 coordination.
- **Hocuspocus → presence service** integration call (`markEditing`)
  documented.
- **Keybindings** language clarified: deferred indefinitely, not
  parked in RFC-0004.
- **Slash commands** reference corrected: not RFC-0004.
- **`PageYjsUpdate` TTL** tightened from 1 day to 1 hour.
- **`bodyAtSave`** in incremental revisions removed; `Revision.body`
  already provides the resolved snapshot.
- **Migration framework** reference added: revision schema upgrade
  goes through RFC-0008's framework.

## Goals

- **Real-time multi-user editing** with sub-second sync latency on a
  local network and acceptable latency over WAN.
- **No data loss during transient network failures**. Offline edits
  are buffered locally and synced on reconnect.
- **Deterministic convergence**. Two users editing simultaneously
  always end up seeing the same document state (CRDT property).
- **Markdown source as the canonical record**. The Yjs document is the
  live edit state; `Revision.body` is the durable record updated on
  save.
- **Revision history preserved**. Explicit "save" creates revisions,
  with significantly reduced storage cost compared to v1.x.
- **Operates on existing Crowi infrastructure**. MongoDB for
  persistence, Redis for cross-server coordination — no new datastores.
- **Scales to 20 simultaneous editors per page**. Beyond that,
  additional users get a read-only view.
- **Honours RFC-0002's contracts**: the save flow invokes the renderer
  pipeline synchronously in the same transaction; the editor never
  triggers renders for async embeds.

## Non-goals (this RFC)

- **Editor UX features**: toolbar (no RFC owns this), keyboard shortcuts
  (deferred indefinitely; see below), slash commands (no RFC owns this),
  autocomplete `@user` / `[[Page` (RFC-0004), paste-image upload
  (RFC-0004), drag-and-drop upload (RFC-0004), Vim mode (deferred).
- **Keyboard shortcuts**. Cross-platform binding design (Mac
  `Ctrl+B` conflict, etc.) is deferred indefinitely; no specific RFC
  owns this. CodeMirror's platform-aware defaults remain.
- **Markdown source "decoration" rendering** (e.g. showing `**bold**`
  as inline-styled but with the asterisks preserved, Zenn-style).
  Explicit decision: Crowi shows raw Markdown source in the editor,
  period. Non-engineer support is provided via a future toolbar
  (no RFC owns this), not by hiding/styling the source.
- **Page-level presence UI**: viewer avatar stack on the read page,
  "editing now" indicators. Deferred to RFC-0005.
- **Explicit merge resolution UI** for conflicting edits. Real-time
  cursor visibility (this RFC) covers most cases; explicit merge UI
  is a future possibility (see Open Question 2).
- **Per-page-tree permissions for editing**. v2.1 inherits Crowi's
  existing page-level permission model unchanged.
- **Hot-reload of editor plugins**. The editor is a single fixed
  configuration in v2.1.
- **Generic migration command framework**. The revision schema
  evolution is handled by the framework defined in RFC-0008; this
  RFC only describes *what* changes, not *how* migrations are
  registered or orchestrated.

## Overview

```
┌─────────── Browser (Editor) ──────────────┐
│  CodeMirror 6                             │
│  + @codemirror/lang-markdown              │
│  + y-codemirror.next  ◀──┐                │
│                          │                │
│  Y.Doc { content: Y.Text }                │
└──────────────────────────┼────────────────┘
                           │ Yjs sync messages
                           │ (binary, over WebSocket)
                           ▼
┌─────────── Hocuspocus server ─────────────┐
│  - Auth hook (verify wsToken)             │
│  - Load/persist Y.Doc                     │
│  - Awareness routing                      │
│  - Save trigger → Revision.prepareRevision│ ──┐ invokes RFC-0002
│    (renderer pipeline runs synchronously) │   │  pipeline in the
│  - presence.markEditing on connect        │   │  same transaction
│  - Multi-server pub/sub via Redis ────┐   │   │
└──────────────────────┬────────────────┼───┘   │
                       │                │       │
                       ▼                ▼       ▼
              ┌──────────────┐  ┌──────────────┐
              │  MongoDB     │  │  Redis       │
              │  - Page      │  │  - pub/sub   │
              │  - Revision  │  │  - wsTokens  │
              │  - PageYjsUpd│  │  - editor    │
              │  - PluginRen │  │    counter   │
              │    derCache  │  └──────────────┘
              └──────────────┘
```

Two transport paths:

1. **HTTP** for everything that already exists: page CRUD, search, etc.
2. **WebSocket** for Yjs sync + awareness, terminated at Hocuspocus.

The HTTP layer remains the source of truth for `Page.body` (which
points to the current revision's content). Yjs state is supplementary:
it captures in-progress edits and converges them; on save, the result
is materialised to a new `Revision` and `Page.body` updated.

## Y.Doc structure

Deliberately minimal:

```ts
// One Y.Doc per page
{
  content: Y.Text;  // Markdown source
}
```

Awareness (cursor positions, selections, user identity) uses Yjs's
standard awareness protocol — a separate channel, not stored in the
Y.Doc itself. No persistence; awareness is ephemeral per session.

We considered storing title, tags, and inline comments as additional
Y.Map/Y.Array fields in the same doc. **Rejected for v2.1**:

- **Title/tags**: edited rarely and from outside the editor (page
  metadata form). HTTP API is sufficient.
- **Inline comments**: not implemented in Crowi v1 either; out of
  scope.

## WebSocket server: Hocuspocus

We adopt Hocuspocus (the production-grade Yjs server from the Tiptap
team) over `y-websocket` (the reference implementation).

**Rationale:**
- Built-in auth hooks (`onAuthenticate`, `onConnect`, `onLoadDocument`)
  that match our short-lived-token model directly.
- Built-in persistence hooks for loading from / writing to MongoDB.
- Built-in Redis extension for multi-server pub/sub.
- Built-in webhooks for save events (useful for triggering the
  renderer pipeline — see "Save semantics").
- Active maintenance, broad production use in the Tiptap ecosystem.

We do not adopt Hocuspocus's commercial features (Hocuspocus Pro);
the open-source core is sufficient.

### Deployment

> **Implementation note (Phase 8.5 + 9, v2.1 final):** The initial design
> ran Hocuspocus as a separate Node.js process behind a reverse proxy.
> The shipped v2.1 implementation **attaches Hocuspocus as a library to
> the api process** via `@crowi/collab` (`packages/api/src/collab/attach.ts`),
> reusing the api's `http.Server` in `ws noServer` mode. Single-instance
> and multi-instance deployments are documented in
> `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx`.
> The wire format and `/collab/` WebSocket endpoint are unchanged.

Hocuspocus runs **in the api process** as a library, sharing the api's
HTTP server, MongoDB connection and (optionally) Redis client. No
separate process or reverse-proxy hop is required. The api binary is
the only collab runtime; horizontal scaling is achieved by spinning
up multiple api replicas (Phase 9 wires `@hocuspocus/extension-redis`
for cross-instance pub/sub automatically when `REDIS_URL` is set).

WebSocket endpoint: `wss://<crowi-host>/collab/`. The api's HTTP
server forwards `upgrade` requests for `/collab/*` directly to
the embedded Hocuspocus engine.

## Persistence strategy

Three persistence layers, each with different update cadence:

```
┌──────────────────────────────────────────────────────┐
│  Page                                                 │
│    body              ← canonical Markdown (pointer)   │
│    currentRevision   ← _id of latest Revision         │
│    yjsState          ← current Y.Doc state            │
│    yjsCheckpointAt                                    │
├──────────────────────────────────────────────────────┤
│  Revision (per save)                                  │
│    body              ← Markdown snapshot              │
│    renderedAst       ← mdast JSON (from RFC-0002)     │
│    metadata          ← TOC, mentions, etc. (RFC-0002) │
│    rendererVersion   ← (RFC-0002)                     │
│    type              ← 'snapshot' | 'incremental'     │
│    yjsUpdate?        ← for 'incremental': delta       │
│    parentRevisionId                                   │
│    savedBy                                            │
│    contributors                                       │
├──────────────────────────────────────────────────────┤
│  PageYjsUpdate (per Yjs delta, high-frequency)        │
│    update            ← binary Yjs update              │
│    createdAt         ← TTL: 1 hour                    │
└──────────────────────────────────────────────────────┘
```

### `Page.body` and `Page.currentRevision`

`Page.body` is the canonical Markdown source — equal to the most
recent `Revision.body`. It's kept on `Page` for compatibility with
HTTP API consumers (search, export, plugins) that already read from
`Page.body`.

`Page.currentRevision` points to the latest `Revision` document, so
view-time rendering can fetch `Revision.renderedAst` (RFC-0002's
authoritative render artifact) without scanning the Revision
collection.

Both are updated atomically on save.

### `Page.yjsState`

A binary snapshot of the current Y.Doc state. Loaded by Hocuspocus
on the first connection to a page; updated periodically as edits flow
in. This is what makes editing resilient across server restarts.

```ts
Page {
  // ... existing fields
  body: string;                    // canonical Markdown (= latest Revision.body)
  currentRevision: ObjectId;       // latest Revision._id
  yjsState: Buffer | null;         // current Y.Doc state, base64 in Mongo
  yjsCheckpointAt: Date | null;    // last full snapshot timestamp
}
```

A null `yjsState` means "no live edit session has been initiated yet,
OR external edit has invalidated the live state"; Hocuspocus
initialises a fresh Y.Doc from `Page.body` in that case.

### `PageYjsUpdate` (high-frequency)

Each individual Yjs update (the binary delta from a single edit
operation) is appended here for short-term durability. Used to recover
from Hocuspocus crashes between `yjsState` checkpoints.

```ts
PageYjsUpdate {
  _id, pageId,
  update: Buffer,              // raw Yjs update payload
  createdAt: Date,
}

// Indexes
{ pageId: 1, createdAt: 1 }
{ createdAt: 1 } TTL, expireAfterSeconds: 3600  // 1 hour
```

**Compaction**: Every 100 updates or every 10 minutes (whichever
comes first), Hocuspocus computes a fresh `yjsState` snapshot, writes
it to `Page.yjsState`, and deletes the now-redundant `PageYjsUpdate`
entries up to that point. This keeps the collection bounded.

**TTL choice**: 1 hour is sufficient because Hocuspocus checkpoints
to `Page.yjsState` every 10 minutes; an update that's an hour old
is well past its useful recovery window. Tighter than the round-1
proposal of 1 day, which was conservative.

### `Revision` (low-frequency, on explicit save)

`Revision` is shared with RFC-0002. This RFC adds collaboration-
specific fields; RFC-0002 owns `renderedAst`, `metadata`, and
`rendererVersion`.

```ts
Revision {
  _id, pageId,
  parentRevisionId: ObjectId | null,
  type: 'snapshot' | 'incremental',

  body: string,                // Markdown at this revision (always present)
  yjsUpdate?: Buffer,          // For type='incremental': delta from parent's Y.Doc

  // RFC-0002 fields:
  renderedAst: object | null,
  rendererVersion: string,
  metadata: RevisionMetadata,

  // RFC-0003 fields:
  savedBy: UserRef,            // user who triggered the save
  contributors: UserRef[],     // users who edited since previous revision
  createdAt: Date,
  message?: string,            // optional save message
}
```

**Snapshot/incremental cadence**: every 10th revision is a `snapshot`
(stores full `body` plus a reset of the Y.Doc state); the 9 in between
are `incremental` (store the Yjs update from the previous revision
plus `body`).

Reading an old revision: `body` and `renderedAst` are always
present, so the UI doesn't need to replay. The `yjsUpdate` field on
`incremental` revisions is there for future use (per-character blame,
detailed diff), not for current display.

### Storage size estimate

For a page edited 100 times:

| Strategy | Storage |
|---|---|
| v1.x (full snapshot each revision) | 100 × ~10KB body = ~1MB |
| v2.1 (10 snapshots + 90 incrementals with body + yjsUpdate) | ~10KB × 100 + 500B × 90 = ~1.05MB body |
| v2.1 (incrementals without body, replay-on-read) | 10 × ~10KB + 90 × 500B = ~145KB body |

The **with-body-always** variant doesn't save much storage over v1.x
on the Markdown side, but `renderedAst` adds significant volume
(~30KB JSON per revision for typical pages, vs HTML which would
be slightly smaller). Net storage is *higher* than v1.x.

The win isn't storage — it's **read simplicity** (no replay needed
for either Markdown or AST) and **historical fidelity** (every
revision's exact rendered form is preserved per RFC-0002's choice).
A future optimisation could drop `renderedAst` from incremental
revisions and regenerate on demand from the nearest snapshot, but
that's deferred.

**Decision for v2.1**: keep `body` and `renderedAst` on every
revision. Optimise storage later if needed.

### Y.Doc garbage collection

Yjs documents accumulate tombstones (markers for deleted content)
over their lifetime. After many edits, the binary state can grow
large.

Hocuspocus's persistence layer is configured to call
`Y.encodeStateAsUpdate(ydoc)` (which compacts tombstones) on every
checkpoint, then store the compacted update as the new `yjsState`.
This keeps `yjsState` size bounded over time.

## Migration from v1.x revisions

Crowi v1.x stores every revision as a full-text snapshot. We do not
migrate these to the new format on upgrade.

### Phase A: v2.1 release — no migration

- Existing `Revision` documents remain in the v1.x schema (just
  `body`, no `renderedAst` / `type` / `parentRevisionId` etc.).
- Code paths that read revisions check for both shapes.
- New revisions created post-upgrade use the v2.1 shape.
- `renderedAst` is populated lazily by `crowi-admin renderer rebuild`
  (RFC-0002).

### Phase B: schema-unifying migration (post-v2.1)

Once RFC-0008's migration command framework lands, a separate
migration unifies the schema:

```bash
crowi-admin migrate --only=revisions-schema-unify --dry-run
crowi-admin migrate --only=revisions-schema-unify
```

This pass adds `type: 'snapshot'` and `contributors: [savedBy]` to
every v1 revision. It does NOT delta-compress historical revisions.

### Phase C: distant future

Crowi v3 may require schema-unified revisions and remove the v1.x
code path.

## Authentication flow

WebSocket auth is decoupled from HTTP session auth, using short-lived
tokens.

```
1. Browser opens /pages/<id>/edit
2. HTTP request: GET /api/pages/<id>/yjs-token
   - Verifies HTTP session
   - Checks user has edit permission on this page
   - Returns: { wsToken: "...", pageId, expiresAt }
   - wsToken is a JWT signed with a server secret,
     containing { userId, pageId, iat, exp } where exp = iat + 5 min
3. Browser opens wss://<host>/collab/<pageId>?token=<wsToken>
4. Hocuspocus onAuthenticate hook:
   - Verifies JWT signature
   - Verifies pageId in token matches connection target
   - Verifies user still has edit permission on page (DB lookup)
   - Verifies under 20-user limit for the page
   - Accepts or rejects
5. Connection accepted: Hocuspocus joins the user to the doc;
   Yjs sync begins; awareness exchange begins.
6. Hocuspocus calls presence.markEditing(pageId, userId)
   to inform RFC-0005's presence service. (No-op until RFC-0005
   lands in v2.2.)
```

### Why short-lived tokens, not cookies?

- WebSocket cookie semantics across origins are unreliable.
- Short-lived JWT keeps the auth surface narrow: revoking access
  takes at most 5 minutes.
- Aligns with the pattern Crowi will use for RFC-0005's presence
  service (read-permission-gated tokens).

### Read-only fallback

If a user lacks edit permission but has read permission, they don't
get a wsToken. The page renders without an editor; viewing only.

If a user has edit permission but the 20-user cap is reached, they
get a token marked `readonly: true`. The editor renders in read-only
mode; they see the live document update as others edit, but their
own input is disabled.

## Save semantics

### Save trigger

In v2.1, **explicit save only**. Users press a "Save" button. There is
no autosave.

**Rationale**: Crowi's culture (engineer-facing, Git-flavoured) values
explicit save points. Combined with Yjs (which means edits aren't
*lost* even without save — they live in `yjsState` and `PageYjsUpdate`),
explicit save is purely about creating a revision marker and
triggering the renderer pipeline.

Autosave can be added in a future RFC if needed; the Yjs layer already
provides the durability that autosave is usually invented to give.

### What happens on save

```
1. Client emits "save" intent to Hocuspocus (custom message).
2. Hocuspocus invokes Revision.prepareRevision(pageId, options)
   (the helper defined by RFC-0002).
3. prepareRevision begins a MongoDB transaction and:
   a. Reads the current Y.Doc state.
   b. Extracts current Markdown from Y.Text.
   c. Reads accumulated contributors from awareness session log.
   d. Creates a new Revision with body, type, contributors, etc.
   e. Runs the renderer pipeline (mode='save'):
      - parse → transform → render
      - produces renderedAst + metadata
      - updates PluginRenderCache for embeds inside the page
   f. Sets Revision.renderedAst, Revision.metadata,
      Revision.rendererVersion.
   g. Updates Page.body, Page.currentRevision, Page.yjsState.
4. Transaction commits.
5. pageEvent.emit('update', pageData, savedBy, bookmarkCount)
   for downstream listeners (render-cache invalidator for OTHER
   pages with backlinks, future RFC-0005 presence service, etc.).
6. Reply "save success" to client.

On transaction failure (any step):
- Roll back. No partial state.
- Reply "save failed" to client; user can retry.
- Y.Doc state in Hocuspocus memory is unchanged; no data lost.
```

This RFC defines steps 1, 2, 3a–3c, 3g, 5, 6. RFC-0002 defines the
internals of `prepareRevision` (steps 3d–3f).

**Synchronicity is contractual**: `prepareRevision` runs in the same
MongoDB transaction as the body update. The renderer pipeline runs
synchronously inside that transaction. This matters because:

- Yjs edits don't trigger renders. Only save does. So save must
  produce the authoritative render in one atomic step.
- A reader who lands on the page right after save MUST see the
  rendered output, not a stale one. The transaction guarantees this.

If `prepareRevision` becomes expensive enough that the transaction
holds locks too long, RFC-0002's `renderer:rebuild` command can be
adapted into a "stale revision" pattern (commit body, mark
`renderedAst` as null, render asynchronously). For v2.1 the
synchronous path is correct.

### Contributors tracking

Hocuspocus maintains a per-page, in-memory log of "userIds that
participated in awareness since the last save". On every awareness
update where a user is present in the doc, their userId is added.

On save, this log becomes `Revision.contributors`. After save, the
log is cleared.

If Hocuspocus restarts mid-session, the log is lost — the next save
will have an incomplete contributors list. This is acceptable: the
list is best-effort, not correctness-critical.

### The "whose save is it" question

A consequence of CRDT-based collaboration: when Alice presses save,
the document state may contain edits from Bob, Carol, and Dave too.
The revision is not purely "Alice's save".

We address this by reframing:

- `savedBy` is the user who **triggered the checkpoint**, not "the
  author of all changes since last revision".
- `contributors` lists everyone who participated.
- The revision history UI shows this honestly:
  > Rev #45 — checkpoint by Alice (with Bob, Carol)
  > 2 hours ago

This is closer to how Notion presents history than how Git presents it.
It accepts that "save" in a CRDT world is a checkpoint, not a commit.

### `pageEvent` contract

After successful save, the core emits a `pageEvent`:

```ts
pageEvent.emit('update', pageData, savedBy, bookmarkCount);

// On page deletion:
pageEvent.emit('delete', pageData, deletedBy);
```

Payload shape is fixed: `(pageData, user, bookmarkCount?)`. Listeners
include (from RFC-0002) the render-cache invalidator for pages with
backlinks, and (from RFC-0005, future) the presence service for the
"page updated" indicator.

**Listener execution order**: defined by registration order. New
listeners (e.g. RFC-0005's) MUST tolerate other listeners running
before them and MUST NOT block downstream listeners on their own
failures (each listener should catch its own errors).

## Edit mode contract with RFC-0002

The editor side of RFC-0002's `mode: 'edit'` semantic:

- The client editor parses Markdown for syntax highlighting (CodeMirror
  + lang-markdown) but does NOT invoke the server-side renderer
  pipeline.
- For async embeds (`@[card](url)`, `@[github-pr](url)`, etc.), the
  client renders a **placeholder** based on the registered embed's
  `reservation` (RFC-0002). No fetch, no cache lookup.
- If the user clicks the placeholder, the client fires a one-shot
  HTTP `POST /api/render/embed-preview` with the embed input. The
  server invokes the renderer with `mode: 'view'` (RFC-0002), which
  bypasses stale-while-revalidate. Result is shown in the editor
  in-place but does NOT modify the Y.Doc — it's purely a UI preview.

This contract guarantees that real-time editing never triggers
external API calls or cache writes.

For now (v2.1 minimal editor scope), the editor doesn't even render
inline placeholders for embeds — the raw Markdown `@[card](url)` text
is shown as-is, like any other Markdown source. The placeholder UI
is RFC-0004 territory. But the contract is documented here so RFC-0004
can build on it.

## Conflict and failure modes

### Network disconnection (client)

Yjs handles this: local edits accumulate in the browser's Y.Doc.
On reconnect, the client and server exchange state vectors and
converge. **No data loss**, no special Crowi handling needed.

UI feedback:
- Disconnected: subtle "Offline — changes will sync when reconnected"
  toast.
- Reconnecting: silent retry with exponential backoff (Hocuspocus
  client does this).
- Reconnected: brief "Reconnected" toast.

### Simultaneous edits to the same region

Yjs deterministically resolves these via CRDT position-based merge.
There is no "conflict" in the technical sense — both edits coexist
in the output, ordered by their generation timestamps.

The semantic issue (edits to the same word producing nonsense output)
is mitigated through visibility:

- **Real-time cursor display**: every connected user sees every other
  user's cursor position and selection, color-coded by user ID hash
  with a small username label next to the cursor.
- **Same-paragraph warning**: when two cursors are within the same
  paragraph (heuristic: same Markdown block-level node), a small
  hover indicator appears, e.g. "✏️ Alice is also editing here".

This mirrors Google Docs / Notion practice: real-time visibility
prevents most overlaps; explicit merge UI is not necessary at v2.1's
scale.

Explicit merge resolution is deferred to a possible future RFC
(see Open Question 2).

### Server-side direct Markdown edits

Scenario: an admin updates `Page.body` directly (via DB tool,
migration script, bulk-edit API). The Y.Doc in Hocuspocus is now
out of sync with `Page.body`.

Resolution policy: **DB wins, Y.Doc rebuilds**.

- The admin operation must also set `Page.yjsState = null`.
- The next Hocuspocus `onLoadDocument` sees `yjsState === null` and
  initialises a fresh Y.Doc from `Page.body`.
- All currently-connected editors of that page receive a `force-reload`
  message via Hocuspocus, with the reason "external change detected".
  Client shows: "This page was modified externally. Reloading..."
  The browser reloads the editor, discarding any in-flight changes
  that weren't synced before the admin edit.

This is a deliberately stark policy — admin direct edits are rare
and intentional. Tools that do bulk edits (e.g. `crowi-admin
wikilink-migrate` from RFC-0002) MUST follow this contract.

### Y.Doc corruption

If Hocuspocus's `onLoadDocument` fails to decode `Page.yjsState`,
the fallback is identical to the admin-edit case:

- Treat as `yjsState === null`.
- Rebuild Y.Doc from `Page.body`.
- Log a high-priority alert for the operator.

This is why `Page.body` is treated as the ultimate source of truth:
it's recoverable even if everything else fails.

### Save fails (DB transaction error)

- Hocuspocus replies "save failed" to the client.
- Y.Doc state is unchanged; user can press Save again.
- No partial revision is created.
- Other connected editors continue editing unaffected.

### Renderer pipeline fails inside save

Per RFC-0002 round 3, the renderer pipeline runs synchronously inside
`prepareRevision`. If a plugin throws during render:

- The save transaction rolls back. No revision is created.
- Hocuspocus replies "save failed: renderer error".
- The user can retry. If the failure is persistent (e.g. plugin bug
  with their content), they must either fix the content or contact
  an operator to disable the failing plugin.

If a plugin returns a soft error (`RenderResult.kind: 'error'`), the
save *succeeds* — the error placeholder is part of the rendered output
and gets persisted in `renderedAst`. The page renders with an error
indicator on the affected embed. This is the normal flow for things
like "GitHub API rate limited"; not a save failure.

### Plugin uninstall while page is being edited

If a renderer plugin is uninstalled while a page containing its
syntax is being edited, the editor itself is unaffected (it only
shows Markdown source). Render on next save falls back to plain
Markdown rendering for the now-unrecognised syntax. RFC-0002's cache
is invalidated as part of plugin uninstall (unconditional, regardless
of `--purge`).

### 20-user cap reached

The 21st user who attempts to edit receives a `readonly: true` token.
Their editor renders in read-only mode but receives live updates.

If a user disconnects, the next reader-mode user is not automatically
promoted; they must reload to attempt re-entry as an editor.

The 20-user limit is configurable via instance config
(`COLLAB_MAX_EDITORS_PER_PAGE`, default 20).

## Editor stack

CodeMirror 6 with the following extensions:

```ts
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { yCollab } from 'y-codemirror.next'
```

The editor is created with:

- `markdown()` — Markdown syntax parsing and highlighting.
- `syntaxHighlighting(defaultHighlightStyle)` — standard token colours.
- `lineNumbers()` — optional, configurable per user (default off).
- `history()` + `historyKeymap` — undo/redo (Yjs-aware via y-codemirror).
- `defaultKeymap` — standard text-editor operations (arrow keys,
  cmd/ctrl+z for undo, etc., platform-aware via CodeMirror).
- `yCollab(yText, awareness)` — Yjs sync and remote cursor rendering.

**Explicitly NOT included in v2.1:**

- No custom keybindings beyond CodeMirror defaults (Ctrl/Cmd+B, +I, +K
  etc. are not bound to anything). Custom keybinding design is deferred
  indefinitely — cross-platform binding choices (Mac vs Windows,
  conflicts with OS defaults like Mac's `Ctrl+B` cursor-left) need
  dedicated design work that no current RFC owns.
- No toolbar. No RFC owns this.
- No autocomplete sources (`@user`, `[[Page` triggers are inert in v2.1).
  → RFC-0004.
- No paste handlers for images/files. → RFC-0004.
- No drag-and-drop handlers. → RFC-0004.
- No slash commands. No RFC owns this.
- No Vim/Emacs mode.
- No source decoration (raw Markdown is displayed as-is, asterisks
  and all). Decided in round 1; not reopened.
- No inline embed placeholder rendering. The editor shows raw Markdown
  text for `@[card](url)` etc. RFC-0004 may add placeholder rendering
  on top of this.

### Awareness rendering

Remote cursors render via `y-codemirror.next`'s built-in support:

- Each remote user shown as a thin vertical line in their color.
- A small label with their username appears next to the cursor for
  ~2 seconds after they move it, then fades.
- Remote selections shown as a colored background range.
- User color is derived deterministically from `sha256(userId) → HSL`,
  so the same user has the same color across sessions.

## Multi-server coordination

For deployments running multiple api instances behind a load balancer:

- Hocuspocus's Redis extension provides pub/sub: when instance A
  receives a Yjs update, it broadcasts to instance B via Redis, which
  forwards to its connected clients.
- Sticky sessions are NOT required (any client can connect to any
  api instance).
- `Page.yjsState` persistence is the source of truth across restarts;
  Redis is for live cross-instance routing only.
- The 20-user cap is enforced via a Redis-stored counter per pageId,
  incremented on connect and decremented on disconnect.

Single-server deployments work identically but don't need the Redis
pub/sub layer; the Redis counter for the user cap still applies
(it falls open when `REDIS_URL` is unset).

> **Implementation note (Phase 8.5 + 9, v2.1 final):**
> `@hocuspocus/extension-redis` is attached **by the api process** in
> `packages/api/src/collab/attach.ts` when `crowi.redis !== null`
> (i.e. `REDIS_URL` is set). No code changes are required at deploy
> time; operators only need to point every api replica at the same
> Redis instance. Sticky sessions remain unnecessary as originally
> designed. See `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx`
> for the deployment recipe and `WS_TOKEN_SECRET` clustering rule.

## v2.1 release scope

In scope:

- Hocuspocus integration as a library attached to the api process
  (`@crowi/collab`, Phase 8.5).
- `Page` schema additions: `currentRevision`, `yjsState`,
  `yjsCheckpointAt`.
- `PageYjsUpdate` collection with TTL (1 hour).
- `Revision` schema additions for collaboration: `parentRevisionId`,
  `type`, `yjsUpdate`, `savedBy`, `contributors`, `message`.
  (Other Revision fields per RFC-0002.)
- HTTP endpoint for short-lived wsToken issuance.
- WebSocket auth via JWT.
- 20-user cap with read-only fallback.
- Redis pub/sub for multi-server deployments.
- Redis-based per-page user counter.
- CodeMirror 6 + lang-markdown + y-codemirror.next editor.
- Awareness rendering: remote cursors with user-colored labels.
- Same-paragraph warning indicator.
- Explicit "Save" button.
- Save flow integration: triggers RFC-0002's `Revision.prepareRevision`.
- Contributors tracking on save.
- "External edit detected" force-reload flow.
- `pageEvent.emit('update'|'delete')` contract.
- Hocuspocus → presence service `markEditing` call (no-op until
  RFC-0005 lands in v2.2; the call site is in scope, the receiver
  is not).
- Read-side soft-refresh when `pageEvent('update')` fires for a page
  being viewed.

Out of scope (deferred):

- Autosave.
- Toolbar (no RFC owns this).
- Custom keybindings (deferred indefinitely; no RFC owns this).
- Autocomplete: `@user`, `[[Page` (RFC-0004).
- Paste/D&D upload (RFC-0004).
- Slash commands (no RFC owns this).
- Markdown source decorations / Zenn-style rendering
  (rejected entirely; not deferred).
- Page-level viewer presence (RFC-0005).
- "Editing now" avatar indicator (RFC-0005).
- Explicit merge resolution UI for semantic conflicts.
- Inline comments.
- Suggestion / proposal mode (track changes).
- Per-character authorship / blame view.
- Editor-side inline placeholder rendering for embeds (RFC-0004).
- Schema-unifying migration of v1.x revisions (RFC-0008's framework).

## Resolved decisions

1. **Y.Doc structure** → Single `Y.Text` for Markdown content.
   Title/tags/comments not in the doc.
2. **WebSocket server** → Hocuspocus (open-source core).
3. **Persistence** → Hybrid: `Page.body` (canonical pointer) +
   `Page.yjsState` (live) + `PageYjsUpdate` (high-frequency increments,
   1-hour TTL) + `Revision` (low-frequency, snapshot/incremental, body
   always present alongside `renderedAst`).
4. **v1.x revision migration** → No migration in Phase A.
   Schema-unifying migration in Phase B post-v2.1, via RFC-0008's
   framework.
5. **Authentication** → Short-lived JWT wsToken issued by HTTP server,
   verified by Hocuspocus.
6. **Save trigger** → Explicit save only, no autosave.
7. **Save semantics** → Checkpoint model: `savedBy` is the triggering
   user, `contributors` lists all participants. Save invokes
   `Revision.prepareRevision` (RFC-0002) synchronously in one
   transaction.
8. **Conflict handling** → Real-time cursor visibility + same-paragraph
   warning. No explicit merge UI in v2.1.
9. **Server-side direct edits** → DB wins, Y.Doc rebuilds, connected
   clients force-reload with notification.
10. **Editor stack** → CodeMirror 6 + lang-markdown + y-codemirror.next.
    Minimal extension set; no custom keybindings/toolbar/autocomplete
    in v2.1.
11. **Markdown source rendering in editor** → Raw source displayed as-is.
    Zenn-style decoration explicitly rejected (not just deferred).
12. **User limit** → 20 simultaneous editors per page (configurable).
    21st+ user gets read-only mode.
13. **Multi-server coordination** → Redis pub/sub via Hocuspocus's
    Redis extension. No sticky sessions needed. *(Phase 9
    implementation: `@hocuspocus/extension-redis` is attached by the
    api process when `REDIS_URL` is set.)*
14. **`PageYjsUpdate` TTL** → 1 hour (round 1's 1 day was over-conservative).
15. **`bodyAtSave` in incremental revisions** → not needed;
    `Revision.body` is always present.
16. **Edit mode contract with RFC-0002** → Editor never invokes
    renderer pipeline. Embed placeholders are RFC-0004 territory;
    one-shot `view`-mode preview via dedicated HTTP endpoint when
    needed.
17. **Custom keybindings** → deferred indefinitely. No specific RFC
    owns this.

## Open questions

1. **Save message UI**. The `Revision.message` field is in the schema
   but no UI surfaces it in v2.1. Future RFC could add an optional
   commit-message-like prompt on save.

2. **Explicit merge resolution UI**. Some users may want a Git-like
   "your version vs their version" UI on save when semantic conflicts
   are detected. v2.1 ships without this; real-time cursor visibility
   covers most cases.

3. **Awareness performance ceiling**. The 20-user cap is intuition-
   based, not measured. Hocuspocus + Yjs awareness should scale much
   higher; we cap at 20 conservatively. After v2.1 ships, measure and
   adjust.

4. **Read-only fallback UX**. When the 21st user opens a page, do we
   (a) silently put them in read-only mode and show a banner, or
   (b) refuse the connection entirely? Lean (a).

5. **`PageYjsUpdate` compaction interval**. 100 updates or 10 minutes
   is a guess. Tune post-launch based on actual update rates.

6. **Stale `renderedAst` after force-reload**. When admin edits
   `Page.body` directly and clients are force-reloaded, the existing
   `Revision.renderedAst` may not match the new body. The admin's
   tool MUST also clear or rebuild `renderedAst` (via RFC-0002's
   `renderer:rebuild`). This is documented contract but easy to
   forget; should we add a runtime check that warns when `Page.body`
   ≠ latest `Revision.body`?

## Implementation plan (informational)

1. **Schema migrations**: add `currentRevision`, `yjsState`,
   `yjsCheckpointAt` to `Page`. Create `PageYjsUpdate` collection
   with TTL index. Extend `Revision` with `parentRevisionId`, `type`,
   `contributors`, `yjsUpdate`, `message`. (Other Revision fields
   per RFC-0002's migration.)
2. **Hocuspocus deployment**: attach Hocuspocus as a library to the
   api process via `@crowi/collab` (Phase 8.5). The api's `http.Server`
   handles `/collab/*` WebSocket upgrades directly; no reverse-proxy
   hop or separate process is required.
3. **wsToken endpoint**: implement `GET /api/pages/:id/yjs-token`
   with JWT signing.
4. **Hocuspocus hooks**: `onAuthenticate`, `onConnect`, `onLoadDocument`,
   `onStoreDocument`.
5. **Yjs persistence layer**: load from `Page.yjsState`, append updates
   to `PageYjsUpdate`, compact to `Page.yjsState` periodically.
6. **Save flow**: implement Hocuspocus custom "save" message handler
   that invokes `Revision.prepareRevision` (RFC-0002 contract).
7. **Contributors tracking**: in-memory awareness log per pageId,
   persisted to `Revision.contributors` on save.
8. **20-user cap**: Redis counter, `onConnect` check.
9. **External-edit reload flow**: `onLoadDocument` checks
   `yjsState === null` and signals connected clients to reload.
10. **`pageEvent` emission**: ensure `update` / `delete` events fire
    with `(pageData, user, bookmarkCount)` payload.
11. **`presence.markEditing` call site**: invoke from `onConnect` /
    `onDisconnect`. Receiver is a no-op stub until RFC-0005.
12. **Editor (browser-side)**: CodeMirror 6 build with minimal
    extensions; integrate `y-codemirror.next`.
13. **Awareness UI**: remote cursors with user-color labels;
    same-paragraph warning indicator.
14. **Save button + revision UI**: surface the new schema in the
    revision list view; show `contributors` honestly.
15. **End-to-end test**: two-browser test of common scenarios
    (simultaneous edits, disconnect/reconnect, save, force-reload,
    renderer pipeline integration).
16. **Multi-server smoke test**: spin up two api instances against the
    same Redis + Mongo, verify cross-instance sync. (Phase 9 implements
    cross-instance routing via `@hocuspocus/extension-redis`,
    auto-attached when `REDIS_URL` is set.)
17. **Documentation**: operator deployment guide (Hocuspocus process,
    Redis config); user guide for save/revision semantics.

Steps 1–11 are server-side and can be done in parallel with 12–14
(client-side). Step 15 is the integration gate before release.

## Supplement (editor-preview-reliability): external-edit invalidation + concurrent-save coalesce

This supplement records two mechanisms added on top of the round-2/round-3
collab redesign (server-doc save lock + desync anti-shrink + synced mount
gate + recovery buffer). It supersedes the original step-9 sketch
("`onLoadDocument` checks `yjsState === null` and signals connected clients
to reload"), which the round-2 review found insufficient on its own.

### G1 — in-process external-edit invalidation (single-instance)

**Problem.** An external write — `Page.updatePage` via REST, the MCP
`crowi_update_page` tool, or any in-process caller — nulls `Page.yjsState`
and bumps `Page.currentRevision`. But under `unloadImmediately: true` the
live Hocuspocus `Y.Doc` survives until its LAST connection drops. A
`crowi:force-reload` broadcast ALONE does not converge: a client that
reloads first re-attaches to the still-stale live doc (held by another
still-connected client), so connected editors' saves CONFLICT-loop until
everyone disconnects.

**Design.** The broadcast is paired with invalidation/drain as ONE
operation. `createCollabServer` now returns `{ hocuspocus, invalidator }`;
the api keeps the invalidator on its `AttachedCollab` handle, and
`Page.updatePage` calls `crowi.collabAttachment.invalidatePages([pageId],
'page-body-replaced')` AFTER the write commits (fire-and-forget; an absent
attachment or a thrown invalidation can never affect the HTTP write).

`invalidatePages` does, for each page with a live doc in THIS process:

1. **Tombstone the doc base** — write a sentinel (`INVALIDATED_DOC_BASE`)
   into the shared `docBaseRevisions` store. The save flow's compare-and-set
   early read (`docBase !== liveRevisionStr`) and its conditional pointer
   write both reject any in-flight save on the stale doc → `CONFLICT`. The
   sentinel can never equal a real revision id, so timing races can't make
   it match.
2. **Gate new connections** — mark the page in an `invalidatedPages`
   tombstone store (a time-bounded `Map<documentName, expiry>`). While a
   page is mid-drain, `onLoadDocument` skips re-recording a (now-advanced)
   real doc base — otherwise a new connection that races the drain would
   overwrite the sentinel and let a stale save match the live pointer. The
   external write already nulled `yjsState`, so the new connection
   re-materialises from the NEW `currentRevision` body regardless.
3. **Broadcast `crowi:force-reload`** to the live connections. The client
   already handles this (force-reload dialog + recovery-buffer snapshot +
   `window.location.reload()`); no new client mechanism is needed.
4. **Drain + force-close** — after a short grace
   (`DEFAULT_INVALIDATE_GRACE_MS`, 1.5 s), `hocuspocus.closeConnections
   (pageId)` kicks any client that ignored the broadcast. Under
   `unloadImmediately: true` the last close also destroys the live `Y.Doc`,
   so it can never be re-attached to; the tombstone is then cleared and the
   page returns to normal collab behaviour.

We deliberately do **not** in-place-replace the live `Y.Doc` with the
external body — merge semantics against unsaved co-edits is intractable. The
external edit is canonical; the user reloads (via the existing dialog) and
manually merges any unsaved local text recovered from the buffer.

### G2 — conditional coalesce of concurrent same-doc saves

**Problem.** Two concurrent `executeSave` on the SAME shared server doc both
read `docBase = R1`, both `prepareRevision`, then the compare-and-set loser
gets `CONFLICT`. But the content is identical (both snapshotted the same live
doc), so the reload is spurious and contradicts "co-editing never
false-CONFLICTs".

**Design.** On a CAS miss the save flow no longer immediately CONFLICTs. It
coalesces — returns the **winner's** `revisionId` as `crowi:save-ok` — ONLY
when BOTH conditions hold (otherwise it keeps the CONFLICT):

1. the in-process `docBaseRevisions` entry has advanced to the page's NEW
   live `currentRevision`. A same-process collab save advances the base on
   success; an out-of-band move (HTTP / other instance / admin CLI) never
   touches the in-process base, so this fails for an external edit → genuine
   `CONFLICT` (this is what keeps coalesce from masking a real divergence);
   AND
2. the new `currentRevision`'s `body` is byte-identical to the loser's
   extracted body.

On coalesce the pointer is NOT moved and `yjsState` / `PageYjsUpdate` rows
are untouched (the winner already owns them); the loser's just-created
`Revision` is tolerated as an unreferenced orphan (the orphan already occurs
today). Best-effort, the loser's trigger user is `$addToSet`-ed into the
winner revision's `contributors` (a metadata-only failure must not fail the
save-ok).

### Out of scope — multi-instance / out-of-process (known limitation)

The invalidator handle reaches only docs live in THIS api process. A live
collab doc on a DIFFERENT replica, or an out-of-process writer (an admin CLI
doing a DB-direct `Page.updatePage`), is NOT reachable. Converging those
requires a cross-instance invalidation channel — Redis pub/sub
(`collab:invalidate-page`) fanned to every replica's invalidator — which is
deferred (RFC-0003 §5b multi-instance is out of scope for alpha). Until then,
under a multi-instance deployment an external write during a live collab
session on another replica may leave connected clients editing stale content
until they manually reconnect. This is documented for operators in
`operations/realtime-collab` ("External edits during a live editing session").
