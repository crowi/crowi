# RFC-0005: Page Presence & Header UI

- **Status**: Draft (round 2 — implementation feedback integrated, scope expanded to page header)
- **Target**: Crowi 2.2 release (alongside RFC-0004)
- **Owner**: TBD
- **Last updated**: 2026-05-17
- **Depends on**: RFC-0003 (Real-time Collaborative Editing), RFC-0004 (Editor UX Enhancement)
- **Implementation notes**: collab transport layer (ws noServer attach to api http.Server) and editor-side presence (CollabPresenceAvatars, CollabSameBlockWarning) are already implemented as part of RFC-0003 / RFC-0004 work. This RFC defines only the page-view-side presence and the header restructure.

## Summary

Two related changes to the page view:

1. **Live presence area** above the page title — shows users currently
   viewing the page in real time, with an indicator for users who are
   also editing.
2. **Page header meta-row restructure** — converts the existing meta
   row (updated-at, likes, seen, comments, backlinks) into a uniform
   set of clickable chips, separating the live "who's here now" signal
   from the historical "who has visited" signal.

These were combined into a single RFC because they affect the same
header area and share underlying UI patterns. Live presence on top,
historical metadata below, as visually distinct rows.

Editor-side presence (peer cursors, typing badges, same-block
warnings) is already implemented as part of RFC-0003 and is not
re-specified here.

## Round 2 changes

Round 1 assumed a separate Node.js process for presence with a
reverse proxy at `/presence/*`. That assumption is wrong now:

- **Transport**: The collab WebSocket already attaches to the api
  process's `http.Server` in noServer mode at `/collab` (landed during
  RFC-0003 / RFC-0004 work). Presence follows the same pattern at
  `/presence`, not a separate process.
- **Editing-flag integration**: cross-process pub/sub is unnecessary;
  collab and presence live in the same process and use direct function
  calls. The `packages/collab/src/presence.ts` `markEditing` stub is
  already in place as the integration point.
- **Editor-side presence**: out of scope here — already implemented
  per RFC-0003.
- **Scope expanded**: page header meta-row restructure (chip-ification
  of likes / seen / backlinks) joined this RFC, since live presence
  needs its own physical row above the page title to avoid being
  confused with the existing "seen users" avatar stack.
- **Anonymous viewer mode**: deferred to a future RFC, to be designed
  alongside Crowi's account-less share feature when that gets
  reimplemented.

## Goals

- **Live presence on the page view**: any user reading the page can
  see who else is reading right now, with editing users visually
  distinguished.
- **Clear separation of "now" vs "historically"**: live presence is a
  dedicated area above the title; "people who have ever viewed this
  page" becomes a compact chip below the title (was an avatar stack
  in v1.x — that stack is replaced).
- **Uniform meta-row chips**: likes, seen, comments, backlinks all
  become `[icon][count][label]` clickable chips with consistent
  interaction (modal or scroll).
- **No new infrastructure**. Use the existing api http.Server's ws
  noServer attach pattern (already proven for `/collab`). Share Redis
  with the editor-cap counter from RFC-0003.
- **Lightweight client cost**. Page viewers (not editors) do not load
  Yjs; presence is its own much smaller WebSocket channel.

## Non-goals (this RFC)

- **Editor-side presence UI** (peer cursors, typing indicators,
  same-block warnings). Already implemented in RFC-0003.
- **"Typing" vs "editor open" distinction**. v2.2 treats "editor is
  open" as the binary `isEditing` state. Per-keystroke typing
  indicators are a future enhancement.
- **Anonymous viewer mode** (opt-out from appearing in the live
  stack). Deferred until the account-less share feature is being
  reimplemented; the two should be designed together.
- **Read receipts** ("Alice read this page at 14:32"). Out of scope.
- **Recently-edited indicators in page lists**. Not part of
  presence; separate concern.
- **Cross-page presence dashboards**. Out of scope.
- **Following / subscription** to a user's activity. Out of scope.
- **Hover-to-jump-to-cursor** (Notion-style "hover an avatar, scroll
  to their cursor"). Future enhancement.
- **Edit count indicator** ("3 people editing now"). The avatar
  stack itself conveys this; no separate count.
- **Comment presence** ("Alice is replying to this comment").
  Comments don't exist as a feature yet.
- **Stable / accessible URLs for the modals** (e.g. linkable
  "people who liked this page" view). Modals are transient UI;
  permalinks are out of scope.

## Page header layout

The page header gets two new rows above the existing structure:

```
┌───────────────────────────────────────────────────────────────┐
│  [🏠 Home / crowi / rfc /]                       [👍 いいね済み] [🔔][📑][🔗][...]
├───────────────────────────────────────────────────────────────┤
│  0001-plugin-architecture                                [✏️ 編集] │
│                                                                │
│  [avatar] Sotaro Karasawa  [⏱ 5分前に更新]  [+1 1] いいね   2閲覧  [💬 2]コメント
│  [👁 閲覧者] [Alice avatar][Bob avatar]                       │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│  ## RFC-0001: Plugin Architecture                              │
│  ...                                                           │
└───────────────────────────────────────────────────────────────┘
```

Two distinct rows:

### Live presence row (NEW, above title)

```
[👁 閲覧者]  [avatar][avatar][avatar][+N]
```

- Shows users currently connected to the presence channel for this page.
- Users who are also editing get a small `✏️` badge overlaid on their
  avatar (corner badge).
- Up to 5 avatars visible; surplus collapses to `[+N]`.
- Click on `[+N]` opens a popover listing all current viewers with
  editing status.
- This row hides itself entirely if only the current user is present
  (no value in displaying yourself alone).

### Meta chip row (RESTRUCTURED, below title)

The existing meta row currently mixes an avatar (author), timestamps,
counts, and a separate "seen users" avatar stack. v2.2 restructures
it as:

```
[author avatar] Author Name  ·  ⏱ N分前に更新  ·  [+1 N] いいね  ·  [👁 N] 閲覧  ·  [💬 N] コメント  ·  [🔗 N] バックリンク
```

All counts on this row become `[icon][count][label]` chips with
uniform clickable behaviour:

| Chip | Click action | Data source |
|---|---|---|
| `+1 N いいね` | Open "Liked by" modal | `Page.liker` (data exists, modal/endpoint NEW) |
| `👁 N 閲覧` | Open "Seen by" modal | `Page.seenUsers` (existing modal repurposed) |
| `💬 N コメント` | Scroll to comments section | existing |
| `🔗 N バックリンク` | Scroll to backlinks list in footer | existing data, scroll behaviour NEW |

The non-clickable items (author avatar/name, last-updated timestamp)
remain as static elements at the start of the row.

**The historical "seen users" avatar stack from v1.x is removed**
in favour of the compact `[👁 N] 閲覧` chip. This avoids visual
ambiguity with the new live presence row above.

## Live presence

### Connection model

```
1. Browser opens /pages/<id>
2. HTTP request: GET /api/v2/pages/<id>/presence-token
   - Verifies HTTP session
   - Checks user has READ permission on the page
   - Returns: { token, pageId, selfUserId, expiresAt }
   - token is a short-lived JWT (5 min) with { userId, pageId, iat, exp }
3. Browser opens wss://<host>/presence/<pageId>?token=<token>
   - The api process's http.Server upgrades this to ws via noServer
     handler at /presence (analogous to /collab from RFC-0003)
4. Presence handler:
   - Verifies JWT signature and pageId match
   - Re-verifies read permission (DB lookup)
   - Registers viewer in Redis (TTL'd hash entry)
   - Broadcasts updated viewer list to all connected clients for this page
5. Client receives viewer list, renders avatar stack
6. Heartbeat every 15s refreshes the Redis TTL
7. On disconnect (clean or TTL expiry), entry is removed and viewer
   list re-broadcast
```

The `/presence` ws handler lives in the same Node.js process as
`/collab` and the HTTP API. No separate process, no reverse proxy
configuration.

### Editing-flag integration

When a user connects to `/collab` (RFC-0003), the same-process
collab module calls into presence directly:

```ts
// in packages/collab/...
onConnect: async ({ pageId, userId }) => {
  await presence.markEditing(pageId, userId);
}

onDisconnect: async ({ pageId, userId }) => {
  await presence.unmarkEditing(pageId, userId);
}
```

`presence.markEditing` updates the same Redis entry the presence
channel uses, setting `isEditing: true` for that user. The next
viewer-list broadcast reflects the change.

No Redis pub/sub channel is introduced for this; the call is
in-process. This is simpler than the round-1 design which assumed
cross-process coordination.

### Source of truth for "currently editing"

For a given page:

- **Live presence (viewing)**: Redis hash `presence:page:<pageId>:viewers`,
  field per userId, TTL 30s, refreshed by heartbeat.
- **Editing status**: derived from the existing editor-cap counter
  Redis Set `crowi:collab:editors:<pageId>` from RFC-0003 (TTL'd,
  refreshed by collab activity). When building a viewer list
  broadcast, presence joins the two: a viewer who is also in the
  editor Set gets `isEditing: true`.

This means stale editing flags resolve themselves via the existing
editor-cap Set TTL — no separate cleanup needed.

### State shape

```
Redis key: presence:page:<pageId>:viewers
Type: hash
Fields: userId → JSON {
  joinedAt: timestamp,
  lastHeartbeatAt: timestamp,
  // user identity fields denormalised for performance:
  username: string,
  displayName: string,
  avatarUrl: string,
}
TTL on field: 30s (refreshed on heartbeat)
```

`isEditing` is NOT stored here — it's computed at broadcast time by
checking the separate editor-cap Set. This avoids two sources of
truth for the same fact.

### Multi-instance coordination

For deployments with multiple api processes behind a load balancer:

- Hocuspocus extension-redis already handles cross-instance collab
  routing (RFC-0003).
- For presence, the same pattern applies: each api instance is the ws
  endpoint for a subset of viewers. Redis holds the canonical viewer
  state. When a viewer joins/leaves on instance A, A writes to Redis
  and publishes to a Redis pub/sub channel
  (`presence:page-updates`); instances B, C, ... subscribe and
  re-broadcast to their connected clients.

This is the same Redis-as-shared-state pattern as RFC-0003. No new
infrastructure.

### Permission boundary

Live presence broadcasts only include viewers who currently have read
permission. If a user's permission is revoked while they're viewing,
the next heartbeat detects this (presence handler caches read
permission with a 60s TTL per user-page pair) and disconnects them.
Their entry is removed from broadcasts.

A user who lost permission mid-session sees a "You no longer have
access to this page" page on the next interaction.

### Self in the stack

The current user appears in their own live presence stack — same
behaviour as Google Docs. Distinguished in the avatar popover by a
"(you)" label, but the avatar itself is rendered identically.

The rationale: presence shows "who is here including me", which is
the most uniform mental model.

### Anti-flicker delay

If a user joins and leaves within 3 seconds (page opened in a new
tab and immediately closed, redirect chain, etc.), their avatar
doesn't appear at all. The client delays adding new avatars to the
stack by 3 seconds; if the user has left before the delay completes,
the addition is skipped.

This is a client-side concern: the server broadcasts state changes
as they occur; the client smooths the UI.

### Editing badge

A user who is also editing has a small `✏️` badge in the corner of
their avatar. No animation in v2.2; the static badge is sufficient
to convey the state. Animation (typing dots) is a possible future
enhancement.

The badge derives from the `isEditing` field in the broadcast
payload, which presence computes by checking the editor-cap Set
(above).

### Mobile

On narrow viewports (< 768px), the live presence row collapses to a
single icon with a count: `[👁 N]`. Tapping expands a sheet listing
all current viewers with their editing status.

## Meta chip row

Restructures the existing meta row into uniform clickable chips.

### Layout

```
[author avatar] Sotaro Karasawa  ·  ⏱ 5分前に更新  ·  [+1 1] いいね  ·  [👁 2] 閲覧  ·  [💬 2] コメント  ·  [🔗 3] バックリンク
```

Two static elements at the start (author avatar/name, last-updated
time), then four chips with uniform interaction.

### Chip styling

- Background: subtle pill (matches existing UI tokens)
- Icon + count + label inline
- Hover: slight background lift to indicate clickability
- Disabled state when count = 0 (chip is rendered greyed, click is
  no-op or shows "No <thing> yet" tooltip)

### Click behaviours

#### `[+1 N] いいね`

Opens a modal: "Liked by" with a list of users who have liked this
page.

- Data: `Page.liker` array (existing; populated when users click the
  like button).
- Modal: new component, mirroring the existing "Seen by" modal in
  structure (avatar + name + link to profile).
- Endpoint: new `GET /api/v2/pages/<id>/likers` returns the list with
  pagination if needed.
- Permission: read access to the page is sufficient. Like-list is
  not private.

#### `[👁 N] 閲覧`

Opens a modal: "Seen by" with a list of users who have ever viewed
this page.

- Data: `Page.seenUsers` array (existing).
- Modal: the existing "+N more" dialog from v1.x is repurposed —
  same modal, now reachable via the chip rather than the avatar stack
  overflow.
- Endpoint: existing `GET /api/v2/pages/<id>/seen-users` (or whatever
  the current endpoint is named).
- Permission: read access.

#### `[💬 N] コメント`

Scrolls to the comments section of the page.

- No modal — comments are part of the page, just below the body.
- Smooth scroll with focus moved to the comments heading for a11y.

#### `[🔗 N] バックリンク`

Scrolls to the backlinks list in the page footer.

- Backlinks are already rendered in the page footer.
- The chip is a navigation shortcut for long pages.
- Smooth scroll with focus moved.

### Zero-count behaviour

When a count is 0:

- The chip is rendered greyed and is non-interactive.
- Tooltip on hover: "No likes yet" / "No views yet" / etc.

This keeps the row layout stable regardless of which counts have
data; users see "this page has no likes" rather than chip disappearing.

### Removed: historical seen avatar stack

The avatar stack that v1.x rendered for seen-users below the title
is removed. Its function (showing "who has read this") is replaced
by the `[👁 N] 閲覧` chip plus the modal.

This is a deliberate simplification: live presence above the title is
the primary "who's around" signal; historical seen is reduced to a
compact chip.

## HTTP and WS APIs

### `GET /api/v2/pages/<id>/presence-token`

Issues a short-lived presence token for the requesting user.

```
Response:
{
  token: string,        // JWT, 5 min expiry
  pageId: string,
  selfUserId: string,   // for client identifying itself in the stream
  expiresAt: string,
}

Errors:
  403 - no read permission
```

### `GET /api/v2/pages/<id>/likers`

NEW. Returns users who have liked the page.

```
Response:
{
  users: Array<{
    id: string,
    username: string,
    displayName: string,
    avatarUrl: string,
    likedAt: string,
  }>,
}
```

### WebSocket `/presence/<pageId>`

Authenticated via token query string (or initial message; choose
to match `/collab`'s pattern).

**Client → Server messages**:
```
{ type: "heartbeat" }
```

**Server → Client messages**:
```
{
  type: "viewers",
  viewers: Array<{
    userId: string,
    username: string,
    displayName: string,
    avatarUrl: string,
    isEditing: boolean,
    joinedAt: timestamp,
  }>
}
```

Server pushes the full viewer list on every change (join, leave,
isEditing toggle). For typical sizes (< 50 viewers per page) full
broadcasts are cheaper than diff updates and avoid state-sync bugs.

## Failure modes

### Presence handler fails to load

If the `/presence` attach handler isn't running (bug, deploy issue),
the page view falls back gracefully: the live presence row hides
itself if the WebSocket connection fails. The meta chip row continues
to function (HTTP-only).

### Permission revocation mid-session

The next heartbeat detects revocation (presence handler caches read
permission with 60s TTL). The user is disconnected from
`/presence/<pageId>`; their avatar disappears from other viewers'
stacks within seconds. When they next request a page, they see the
standard "no access" page.

### Stale isEditing flag

Not possible by design: `isEditing` is derived at broadcast time from
the editor-cap Set, which has its own TTL maintained by collab
activity. If collab dies, the Set entries expire; presence sees
"not editing" on the next broadcast.

### Multiple tabs from the same user

Each tab opens its own presence WebSocket. The presence backend
dedupes by userId for display: even with 3 tabs open, the user shows
up once in the viewer list. Their `isEditing` flag is true if any
of their tabs has the editor open.

### Like / seen modal data lag

If a user likes a page and immediately opens the "Liked by" modal,
the new like may not yet be visible (caching, eventual consistency).
This is acceptable; the modal also doesn't refresh in real time
while open.

### Backlinks chip click on a page with no footer backlinks

The backlinks count comes from the same data that renders the footer.
If for some reason the page has backlinks per the count but they
don't render in the footer (rendering bug, permission filtering
mid-scroll), the click scrolls to the empty footer area. The chip's
count and the footer are eventually consistent.

## v2.2 release scope

In scope:

- `/presence/<pageId>` ws noServer handler attached to api http.Server.
- `GET /api/v2/pages/<id>/presence-token` endpoint.
- Redis `presence:page:<pageId>:viewers` hash with TTL.
- Redis pub/sub for multi-instance coordination.
- `presence.markEditing` / `unmarkEditing` integration (called
  in-process by collab).
- isEditing computed at broadcast time from editor-cap Set.
- Live presence row above page title, with editing badge.
- Anti-flicker delay (3 seconds).
- Mobile collapse + expanded sheet.
- Self in the stack with "(you)" label in popover.
- Page header meta-row restructure into chips.
- Removal of v1.x seen-users avatar stack.
- `[+1 N] いいね` chip with "Liked by" modal.
- `GET /api/v2/pages/<id>/likers` endpoint.
- `[👁 N] 閲覧` chip with reused "Seen by" modal.
- `[💬 N] コメント` chip with scroll behaviour.
- `[🔗 N] バックリンク` chip with scroll behaviour.
- Zero-count greyed chip styling.

Out of scope (deferred):

- Anonymous viewer mode (paired with future account-less share RFC).
- Typing animation (vs static editing badge).
- Hover-to-jump-to-cursor.
- Read receipts.
- Edit count display ("3 people editing").
- Cross-page presence views.
- Following / subscriptions.
- Plugin-extensible presence.
- Stable / linkable URLs for the modals.

## Resolved decisions

1. **Deployment**: presence runs in the same api process as collab and
   the HTTP API, attached to the same http.Server at `/presence`.
   No separate process, no reverse proxy.
2. **Editing flag**: derived from existing editor-cap Set at broadcast
   time, not stored separately.
3. **Self in stack**: yes (Google Docs pattern).
4. **Editing badge**: static `✏️` corner badge. No typing animation
   in v2.2.
5. **Anonymous mode**: deferred to future RFC paired with account-less
   share.
6. **Page header restructure**: included in this RFC (one shared
   header area).
7. **v1.x seen-users avatar stack**: removed, replaced by chip + modal.
8. **Likes chip**: new modal + endpoint required; design parallels
   existing seen-users modal.
9. **Comments / backlinks chips**: scroll to existing in-page sections;
   no new modals.
10. **Zero-count chips**: rendered greyed and non-interactive, not
    hidden.
11. **Mobile**: collapse to `[👁 N]` chip + tap-to-expand sheet for
    presence row. Meta chips remain inline but may wrap.

## Open questions

1. **Editing-flag truth lag**. The editor-cap Set is refreshed by
   collab activity, but if collab activity is sparse (user typing
   only occasionally), the Set TTL may expire and re-add repeatedly,
   causing the editing badge to flicker. We should validate the
   editor-cap heartbeat interval matches presence's expectations.

2. **Live presence row visibility when alone**. The row hides itself
   when only the current user is present. Should it still hint "👁 you
   are here" or stay completely empty? Lean: completely empty; the
   browser tab itself already tells you you're here.

3. **Popover content for large viewer counts**. If 30 people are
   viewing, the popover gets long. Lean: cap the popover list at 20
   with a "and N others" footer. The detailed modal is out of scope
   for v2.2 (no UX demand yet).

4. **Likes chip auto-update on like**. When the user clicks the like
   button on the page, should the chip count update immediately
   (optimistic UI) or wait for server confirmation? Lean:
   optimistic; on failure, revert with a toast (uses RFC-0004's
   toast utility).

5. **Backlinks count source**. Currently the page footer renders
   backlinks computed at some point. Is the count in the chip the
   same source, or independently computed? Should be the same source
   to avoid divergence — confirm in implementation.

6. **Permission cache TTL tuning**. 60s cache of read permission per
   user-page may be too lenient (revocation takes up to 60s to
   propagate) or too tight (DB load). 60s is a guess; tune
   post-launch.

7. **Cross-process Redis pub/sub channel name**. Coordinate with
   RFC-0003's `crowi:collab:editors:<pageId>` naming convention for
   consistency. Lean: `crowi:presence:viewers:<pageId>` for the hash,
   `crowi:presence:updates` for the pub/sub channel.

## Implementation plan (informational)

1. **`/presence` ws attach**: mirror `/collab`'s noServer handler
   in the api process. Authentication via token query param.
2. **Token endpoint**: `GET /api/v2/pages/<id>/presence-token` with
   read-permission gate.
3. **Redis presence hash**: viewer state with TTL + heartbeat
   refresh.
4. **Multi-instance pub/sub**: Redis channel for cross-instance
   viewer-list broadcasts.
5. **In-process markEditing**: wire collab `onConnect` /
   `onDisconnect` to `presence.markEditing` / `unmarkEditing` (stub
   already in place per implementation feedback).
6. **isEditing derivation**: join presence hash with editor-cap Set
   at broadcast time.
7. **Permission check cache**: 60s TTL for read-permission per
   user-page.
8. **Anti-flicker delay**: client-side 3s wait before adding new
   avatars.
9. **Live presence row component**: above the page title, with
   editing badge + mobile collapse.
10. **`GET /api/v2/pages/<id>/likers`** endpoint.
11. **"Liked by" modal** component, mirroring existing "Seen by"
    modal.
12. **Chip components**: `[icon][count][label]` uniform style,
    clickable, with zero-state.
13. **Page header restructure**: replace existing meta row + remove
    v1.x seen-users avatar stack.
14. **Scroll-to-section behaviour**: comments and backlinks chips.
15. **End-to-end tests**: viewer join/leave, editing badge appears
    on collab connect, multi-tab dedup, permission revocation,
    multi-instance broadcast, modal data fetch, chip click
    behaviours.
16. **Documentation**: user-facing notes on the new header layout
    (especially "what happened to the seen avatars row").
