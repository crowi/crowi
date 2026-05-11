# RFC-0003: Real-time Collaborative Editing

- **Status**: Draft (round 1)
- **Target**: Crowi 2.1 release
- **Owner**: TBD
- **Last updated**: 2026-05-10
- **Depends on**: RFC-0001 (Plugin Architecture), RFC-0002 (Renderer Plugin Architecture)
- **Related**: RFC-0004 (Editor UX Enhancement, future), RFC-0005 (Page Presence, future)

## Summary

Add real-time collaborative editing to Crowi 2.1, using Yjs as the
synchronisation engine and Hocuspocus as the WebSocket backend. Multiple
users can edit the same page simultaneously; their changes converge
deterministically via CRDT semantics; the canonical Markdown source is
periodically materialised back to the `Page` document on explicit save.

This RFC covers the **synchronisation layer**, the **persistence
strategy**, the **editor stack**, and **save semantics**. It deliberately
excludes editor UX enhancements (toolbar, autocomplete, paste/D&D
upload, slash commands, keybindings) which are deferred to RFC-0004,
and page-level presence (avatar stack, viewer count) which is deferred
to RFC-0005.

## Goals

- **Real-time multi-user editing** with sub-second sync latency on a
  local network and acceptable latency over WAN.
- **No data loss during transient network failures**. Offline edits
  are buffered locally and synced on reconnect.
- **Deterministic convergence**. Two users editing simultaneously
  always end up seeing the same document state (CRDT property).
- **Markdown source as the canonical record**. The Yjs document is the
  live edit state; `Page.body` is the durable record updated on save.
- **Revision history preserved**. Explicit "save" creates revisions,
  with significantly reduced storage cost compared to v1.x.
- **Operates on existing Crowi infrastructure**. MongoDB for persistence,
  Redis for cross-server coordination — no new datastores.
- **Scales to 20 simultaneous editors per page**. Beyond that, additional
  users get a read-only view.

## Non-goals (this RFC)

- **Editor UX features**: toolbar, keyboard shortcuts beyond CodeMirror's
  defaults, slash commands, autocomplete (`@user`, `[[Page`), paste-image
  upload, drag-and-drop upload, Vim mode. All deferred to RFC-0004.
- **Markdown source "decoration" rendering** (e.g. showing `**bold**` as
  inline-styled but with the asterisks preserved, Zenn-style). Explicit
  decision: Crowi shows raw Markdown source in the editor, period.
  Non-engineer support is provided via a future toolbar (RFC-0004),
  not by hiding/styling the source.
- **Page-level presence UI**: viewer avatar stack on the read page,
  "editing now" indicators. Deferred to RFC-0005.
- **Explicit merge resolution UI** for conflicting edits. Real-time
  cursor visibility (this RFC) covers most cases; explicit merge UI is
  a future possibility (see Open Question 2).
- **Per-page-tree permissions for editing**. v2.1 inherits Crowi's
  existing page-level permission model unchanged.
- **Hot-reload of editor plugins**. The editor is a single fixed
  configuration in v2.1.

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
│  - Multi-server pub/sub via Redis ────┐   │
└──────────────────────┬────────────────┼───┘
                       │                │
                       ▼                ▼
              ┌──────────────┐  ┌──────────────┐
              │  MongoDB     │  │  Redis       │
              │  - Page      │  │  - pub/sub   │
              │  - PageRev   │  │  - wsTokens  │
              │  - YjsHist   │  └──────────────┘
              └──────────────┘
```

Two transport paths:

1. **HTTP** for everything that already exists: page CRUD, search, etc.
2. **WebSocket** for Yjs sync + awareness, terminated at Hocuspocus.

The HTTP layer remains the source of truth for `Page.body` (the
canonical Markdown). Yjs state is supplementary: it captures
in-progress edits and converges them; on save, the result is
materialised back to `Page.body`.

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
  metadata form). HTTP API is sufficient; no need for sub-second
  sync.
- **Inline comments**: not implemented in Crowi v1 either; out of
  scope. If added later, comments can join the same Y.Doc without
  breaking existing clients (Yjs is forward-compatible).

## WebSocket server: Hocuspocus

We adopt Hocuspocus (the production-grade Yjs server from the Tiptap
team) over `y-websocket` (the reference implementation).

**Rationale:**
- Built-in auth hooks (`onAuthenticate`, `onConnect`, `onLoadDocument`)
  that match our short-lived-token model directly.
- Built-in persistence hooks for loading from / writing to MongoDB.
- Built-in Redis extension for multi-server pub/sub.
- Built-in webhooks for save events (useful for triggering render —
  see "Save semantics").
- Active maintenance, broad production use in the Tiptap ecosystem.

We do not adopt Hocuspocus's commercial features (Hocuspocus Pro);
the open-source core is sufficient.

### Deployment

Hocuspocus runs as a separate Node.js process alongside the existing
Crowi HTTP server, sharing the same MongoDB and Redis. In small
deployments they may run in the same container; in larger deployments
they are split for independent scaling.

WebSocket endpoint: `wss://<crowi-host>/collab/`. The HTTP server
reverse-proxies `/collab/*` to Hocuspocus.

## Persistence strategy: hybrid

Three layers of persistence, each with different update cadence:

```
┌──────────────────────────────────────────┐
│  Page.body                                │  ← canonical Markdown
│  Page.yjsState                            │  ← current Y.Doc snapshot
│  PageRevision  (incremental + snapshot)   │  ← edit history
│  PageYjsUpdate (live edit increments)     │  ← high-frequency stream
└──────────────────────────────────────────┘
```

### `Page.body`

The canonical Markdown source. Updated **only on explicit save**.
HTTP API consumers (search, export, plugins, other servers) read from
here. This is the field that has existed in Crowi since v1.

### `Page.yjsState`

A binary snapshot of the current Y.Doc state. Loaded by Hocuspocus
on the first connection to a page; updated periodically as edits flow
in. This is what makes editing resilient across server restarts.

```ts
Page {
  // ... existing fields
  body: string;                    // canonical Markdown
  yjsState: Buffer | null;         // current Y.Doc state, base64 in Mongo
  yjsCheckpointAt: Date | null;    // last full snapshot timestamp
}
```

A null `yjsState` means "no live edit session has been initiated yet";
Hocuspocus initialises a fresh Y.Doc from `body` in that case.

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
{ createdAt: 1 } TTL, expireAfterSeconds: 86400  // 1 day
```

**Compaction**: Every 100 updates or every 10 minutes (whichever
comes first), Hocuspocus computes a fresh `yjsState` snapshot, writes
it to `Page.yjsState`, and deletes the now-redundant `PageYjsUpdate`
entries up to that point. This keeps the collection bounded.

### `PageRevision` (low-frequency)

Created **only on explicit save**. This is the user-facing history.

```ts
PageRevision {
  _id, pageId,
  parentRevisionId: ObjectId | null,
  type: 'snapshot' | 'incremental',

  // For type='snapshot':
  body?: string,               // full Markdown at this revision

  // For type='incremental':
  yjsUpdate?: Buffer,          // Yjs update from parent
  bodyAtSave?: string,         // resolved Markdown (for search/quick view)

  // Common fields:
  savedBy: UserRef,            // user who triggered the save
  contributors: UserRef[],     // users who edited since previous revision
  createdAt: Date,
  message?: string,            // optional save message
}
```

**Snapshot/incremental cadence**: every 10th revision is a `snapshot`
(stores full `body`); the 9 in between are `incremental` (store the
Yjs update from the previous revision plus a resolved `bodyAtSave`
for cheap reads).

Reading an old revision:
- `snapshot`: return `body` directly.
- `incremental`: return `bodyAtSave` for display. (The `yjsUpdate` is
  there for future use — e.g. exact char-level blame — but the UI
  reads `bodyAtSave` for simplicity.)

`bodyAtSave` is denormalised but acceptable: revisions are immutable
once created, so consistency isn't an ongoing concern.

### Storage size estimate

For a page edited 100 times:

| Strategy | Storage |
|---|---|
| v1.x (full snapshot each revision) | 100 × ~10KB = ~1MB |
| v2.1 (10 snapshots + 90 incrementals with bodyAtSave) | 10 × ~10KB + 90 × ~10.5KB = ~1.05MB |
| v2.1 (10 snapshots + 90 incrementals **without** bodyAtSave) | 10 × ~10KB + 90 × ~500B = ~145KB |

The **with-bodyAtSave** variant doesn't save much storage over v1.x.
The win is in read simplicity (no replay needed) and forward
compatibility — we can drop `bodyAtSave` and switch to pure replay in
a future version if storage cost becomes a concern.

**Decision for v2.1**: keep `bodyAtSave`. Optimise storage later if
needed.

### Y.Doc garbage collection

Yjs documents accumulate tombstones (markers for deleted content) over
their lifetime. After many edits, the binary state can grow large.

Hocuspocus's persistence layer is configured to call
`Y.encodeStateAsUpdate(ydoc)` (which compacts tombstones) on every
checkpoint, then store the compacted update as the new `yjsState`.
This keeps `yjsState` size bounded over time.

## Migration from v1.x revisions

Crowi v1.x stores every revision as a full-text snapshot. We do not
migrate these to the new format. Strategy:

### Phase A: v2.1 release — no migration

- Existing `PageRevision` documents remain in the v1.x schema.
- Code paths that read revisions check for both shapes:
  - v1.x shape: `{ body: string, ... }`
  - v2.1 shape: `{ type: 'snapshot'|'incremental', body?, yjsUpdate?, bodyAtSave?, ... }`
- New revisions created post-upgrade use the v2.1 shape.
- Zero migration risk, zero downtime, zero data loss.

### Phase B: post-v2.1 lightweight migration (optional)

A separate, optional command:

```bash
crowi-admin migrate --only=revisions-schema-unify --dry-run
crowi-admin migrate --only=revisions-schema-unify
```

This pass:
- Adds `type: 'snapshot'` to every v1 revision document.
- Adds `contributors: [savedBy]` (only the saver is known).
- Renames `body` field if necessary.
- Does NOT attempt to delta-compress historical revisions. The Phase B
  goal is *schema uniformity*, not space saving.

Runs in batches of 1000 documents with `bulkWrite`; expected runtime
~30 seconds per 10K revisions. Safe to run on a live system because
each document update is atomic and doesn't affect other parts of the
schema.

### Phase C: distant future

Eventually (Crowi v3?), require schema-unified revisions and remove
the v1.x code path. Out of scope for now.

## Authentication flow

WebSocket auth is decoupled from HTTP session auth, using short-lived
tokens.

```
1. Browser opens /pages/<id>/edit
2. HTTP request: GET /api/v2/pages/<id>/yjs-token
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
```

### Why short-lived tokens, not cookies?

- WebSocket cookie semantics across origins are unreliable.
- Short-lived JWT keeps the auth surface narrow: revoking access
  takes at most 5 minutes (we don't need real-time revocation for v2.1).
- Aligns with the existing pattern Crowi already uses for other
  WebSocket-like features (if any) — single auth model.

### Read-only fallback

If a user lacks edit permission but has read permission, they don't
get a wsToken. The page renders without an editor; viewing only.

If a user has edit permission but the 20-user cap is reached, they
get a token marked `readonly: true`. The editor renders in read-only
mode, and they see the live document update as others edit, but
their own input is disabled.

## Save semantics

### Save trigger

In v2.1, **explicit save only**. Users press a "Save" button. There is
no autosave.

**Rationale**: Crowi's culture (engineer-facing, Git-flavoured) values
explicit save points. Combined with Yjs (which means edits aren't
*lost* even without save — they live in `yjsState` and `PageYjsUpdate`),
explicit save is purely about creating a revision marker.

Autosave can be added in a future RFC if needed; the Yjs layer already
provides the durability that autosave is usually invented to give.

### What happens on save

```
1. Client emits "save" intent to Hocuspocus (custom message).
2. Hocuspocus:
   a. Reads the current Y.Doc state.
   b. Extracts current Markdown from Y.Text.
   c. Reads accumulated contributors from awareness session log.
   d. Begins a MongoDB transaction:
      - Update Page.body = current Markdown
      - Update Page.yjsState = encoded current state
      - Create PageRevision (incremental or snapshot based on counter)
      - Clear contributors session log for next round
   e. On transaction success:
      - Invoke render pipeline (RFC-0002): produce HTML + metadata.
      - Update Page.renderedHtml + Page.metadata.
      - Update PluginRenderCache for embeds (RFC-0002).
      - Emit PageHtmlUpdated event.
      - Reply "save success" to client.
   f. On transaction failure:
      - Reply "save failed" to client; user can retry.
      - Y.Doc state is unchanged; no data lost.
```

The render step (e) is **inside the save transaction's success path
but outside the DB transaction itself**. If render fails (e.g. a
plugin times out), the save itself succeeded; the cached HTML may be
stale but `Page.body` is correct. Subsequent renders will retry.

### Contributors tracking

Hocuspocus maintains a per-page, in-memory log of "userIds that
participated in awareness since the last save". On every awareness
update where a user is present in the doc, their userId is added.

On save, this log becomes `PageRevision.contributors`. After save, the
log is cleared.

If Hocuspocus restarts mid-session, the log is lost — the next save
will have an incomplete contributors list. This is acceptable: the
list is a "best-effort" record, not a correctness-critical field.

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
  The browser reloads the editor, loses any in-flight changes that
  weren't synced before the admin edit.

This is a deliberately stark policy — admin direct edits are rare
and intentional. Tools that do bulk edits (e.g.
`crowi-admin migrate --only=wikilink` from RFC-0002) MUST follow
this contract.

### Y.Doc corruption

If Hocuspocus's `onLoadDocument` fails to decode `Page.yjsState`
(e.g. file corruption, schema mismatch), the fallback is identical
to the admin-edit case:

- Treat as `yjsState === null`.
- Rebuild Y.Doc from `Page.body`.
- Log a high-priority alert for the operator.
- Editing history (intermediate Yjs states) is lost, but the latest
  canonical Markdown is preserved.

This is why `Page.body` is treated as the ultimate source of truth:
it's recoverable even if everything else fails.

### Save fails (DB transaction error)

- Hocuspocus replies "save failed" to the client.
- Y.Doc state is unchanged; user can press Save again.
- No partial revision is created.
- Other connected editors continue editing unaffected (their Y.Doc
  state hasn't changed).

### Plugin uninstall while page is being edited

If a renderer plugin is uninstalled while a page containing its
syntax is being edited, the editor itself is unaffected (it only
shows Markdown source). Render on next save falls back to plain
Markdown rendering for the now-unrecognised syntax. RFC-0002 cache
is invalidated as part of plugin uninstall.

### 20-user cap reached

The 21st user who attempts to edit receives a `readonly: true` token.
Their editor renders in read-only mode but receives live updates.

If a user disconnects, the next reader-mode user is not automatically
promoted; they must reload to attempt re-entry as an editor. This
keeps server logic simple.

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
  etc. are not bound to anything). RFC-0004 will design these with
  proper platform handling.
- No toolbar.
- No autocomplete sources (`@user`, `[[Page` triggers are inert in v2.1).
- No paste handlers for images/files.
- No drag-and-drop handlers.
- No slash commands.
- No Vim/Emacs mode.
- No source decoration (raw Markdown is displayed as-is, asterisks
  and all).

These are RFC-0004 territory.

### Awareness rendering

Remote cursors render via `y-codemirror.next`'s built-in support:

- Each remote user shown as a thin vertical line in their color.
- A small label with their username appears next to the cursor for
  ~2 seconds after they move it, then fades.
- Remote selections shown as a colored background range.
- User color is derived deterministically from `sha256(userId) → HSL`,
  so the same user has the same color across sessions.

## Multi-server coordination

For deployments running multiple Hocuspocus instances behind a load
balancer:

- Hocuspocus's Redis extension provides pub/sub: when instance A
  receives a Yjs update, it broadcasts to instance B via Redis, which
  forwards to its connected clients.
- Sticky sessions are NOT required (any client can connect to any
  Hocuspocus instance).
- `Page.yjsState` persistence is the source of truth across restarts;
  Redis is for live cross-instance routing only.
- The 20-user cap is enforced via a Redis-stored counter per pageId,
  incremented on connect and decremented on disconnect.

Single-server deployments work identically but don't need the Redis
pub/sub layer; the Redis counter for the user cap still applies.

## v2.1 release scope

In scope:

- Hocuspocus integration as a separate Node.js process.
- `Page.yjsState` + `PageYjsUpdate` schema additions.
- `PageRevision` schema upgrade (snapshot/incremental).
- `Page.body` materialised on explicit save.
- HTTP endpoint for short-lived wsToken issuance.
- WebSocket auth via JWT.
- 20-user cap with read-only fallback.
- Redis pub/sub for multi-server deployments.
- Redis-based per-page user counter.
- CodeMirror 6 + lang-markdown + y-codemirror.next editor.
- Awareness rendering: remote cursors with user-colored labels.
- Same-paragraph warning indicator.
- Explicit "Save" button with revision creation.
- Contributors tracking on save.
- "External edit detected" force-reload flow.
- Hocuspocus webhook → render pipeline (RFC-0002) integration.
- Read-side `PageHtmlUpdated` event for viewers of the page to soft-
  refresh.

Out of scope (deferred):

- Autosave.
- Toolbar (RFC-0004).
- Custom keybindings (RFC-0004).
- Autocomplete: `@user`, `[[Page` (RFC-0004).
- Paste/D&D upload (RFC-0004).
- Slash commands (RFC-0004).
- Markdown source decorations / Zenn-style rendering
  (rejected entirely; not deferred).
- Page-level viewer presence (RFC-0005).
- "Editing now" avatar indicator (RFC-0005).
- Explicit merge resolution UI for semantic conflicts.
- Inline comments.
- Suggestion / proposal mode (track changes).
- Per-character authorship / blame view.
- Schema-unifying migration of v1.x revisions (Phase B, post-v2.1).

## Resolved decisions

1. **Y.Doc structure** → Single `Y.Text` for Markdown content.
   Title/tags/comments not in the doc.
2. **WebSocket server** → Hocuspocus (open-source core).
3. **Persistence** → Hybrid: `Page.body` (canonical) +
   `Page.yjsState` (live) + `PageYjsUpdate` (high-frequency increments,
   1-day TTL) + `PageRevision` (low-frequency, snapshot/incremental).
4. **v1.x revision migration** → No migration in Phase A.
   Optional schema-unifying migration in Phase B post-v2.1.
5. **Authentication** → Short-lived JWT wsToken issued by HTTP server,
   verified by Hocuspocus.
6. **Save trigger** → Explicit save only, no autosave.
7. **Save semantics** → Checkpoint model: `savedBy` is the triggering
   user, `contributors` lists all participants since previous revision.
8. **Conflict handling** → Real-time cursor visibility + same-paragraph
   warning. No explicit merge UI in v2.1.
9. **Server-side direct edits** → DB wins, Y.Doc rebuilds, connected
   clients force-reload with notification.
10. **Editor stack** → CodeMirror 6 + lang-markdown + y-codemirror.next.
    Minimal extension set; no custom keybindings/toolbar/autocomplete
    in v2.1.
11. **Markdown source rendering in editor** → Raw source displayed as-is.
    Zenn-style decoration explicitly rejected (not just deferred).
    Non-engineer support comes from a future toolbar (RFC-0004), not
    from hiding source.
12. **User limit** → 20 simultaneous editors per page (configurable).
    21st+ user gets read-only mode.
13. **Multi-server coordination** → Redis pub/sub via Hocuspocus's
    Redis extension. No sticky sessions needed.

## Open questions

1. **`bodyAtSave` long-term**. Keeping `bodyAtSave` on every
   incremental revision gives us cheap reads but negates most of the
   delta-storage savings. Future option: drop `bodyAtSave` and require
   replay from the nearest snapshot. Defer until measured: if revision
   storage proves expensive in practice, this is the next lever.

2. **Explicit merge resolution UI**. Some users may want a Git-like
   "your version vs their version vs current merge — pick one" UI on
   save when semantic conflicts are detected. v2.1 ships without this;
   real-time cursor visibility likely covers most cases. If user
   feedback indicates pain, a future RFC could add this.

3. **Save message / commit message**. The `PageRevision.message` field
   is in the schema but no UI surfaces it in v2.1. Future RFC could
   add an optional commit-message-like prompt on save, especially for
   significant changes.

4. **Awareness performance ceiling**. The 20-user cap is intuition-
   based, not measured. Hocuspocus + Yjs awareness should scale much
   higher (50–100 users per doc); we cap at 20 conservatively. After
   v2.1 ships, measure actual sync latency under load and adjust the
   default.

5. **Read-only fallback UX**. When the 21st user opens a page, do we
   (a) silently put them in read-only mode and show a banner, or
   (b) refuse the connection entirely with "Try again later"? Lean (a)
   — read-only is still useful — but the UX wording matters and is
   deferred to implementation review.

6. **PageYjsUpdate compaction interval**. 100 updates or 10 minutes is
   a guess. Could be tuned post-launch based on actual update rates.

## Implementation plan (informational)

1. **Schema migrations**: add `yjsState`, `yjsCheckpointAt` to `Page`;
   create `PageYjsUpdate` collection with TTL index; extend
   `PageRevision` with `type`, `parentRevisionId`, `contributors`,
   `yjsUpdate`, `bodyAtSave`, `message`.
2. **Hocuspocus deployment**: containerise as separate process; wire
   into reverse proxy at `/collab/`.
3. **wsToken endpoint**: implement `GET /api/v2/pages/:id/yjs-token`
   with JWT signing.
4. **Hocuspocus auth hook**: implement `onAuthenticate`, `onConnect`,
   `onLoadDocument`, `onStoreDocument`.
5. **Yjs persistence layer**: load from `Page.yjsState`, append updates
   to `PageYjsUpdate`, compact to `Page.yjsState` periodically.
6. **Save flow**: implement `onSaveRequest` custom message; integrate
   with render pipeline (RFC-0002).
7. **Contributors tracking**: in-memory awareness log per pageId,
   persisted to `PageRevision.contributors` on save.
8. **20-user cap**: Redis counter, `onConnect` check.
9. **External-edit reload flow**: `onLoadDocument` checks
   `yjsState === null` and signals connected clients to reload.
10. **Editor (browser-side)**: CodeMirror 6 build with minimal
    extensions; integrate `y-codemirror.next`.
11. **Awareness UI**: remote cursors with user-color labels;
    same-paragraph warning indicator.
12. **Save button + revision UI**: surface the new schema in the
    revision list view; show `contributors` honestly.
13. **End-to-end test**: two-browser test of common scenarios
    (simultaneous edits, disconnect/reconnect, save, force-reload).
14. **Multi-server smoke test**: spin up two Hocuspocus instances
    against the same Redis + Mongo, verify cross-instance sync.
15. **Documentation**: operator deployment guide (Hocuspocus process,
    Redis config); user guide for save/revision semantics.

Steps 1–9 are server-side and can be done in parallel with 10–12
(client-side). Step 13 is the integration gate before release.
