# RFC-0004: Editor UX Enhancement

- **Status**: Draft (round 2 — detailed semantics, draft pages, integration with RFC-0002/0003)
- **Target**: Crowi 2.2 release (post v2.1 stabilisation)
- **Owner**: TBD
- **Last updated**: 2026-05-12
- **Depends on**: RFC-0001 (Plugin Architecture), RFC-0002 (Renderer Plugin Architecture, round 3.1), RFC-0003 (Real-time Collaborative Editing, round 2)
- **Related**: RFC-0005 (Page Presence), RFC-0006 (Editor Toolbar), RFC-0007 (Slash Commands)

## Summary

Add four editor productivity features on top of the minimal CodeMirror
6 editor from RFC-0003:

1. **Autocomplete** for `@user` mentions and `[[Page` wikilinks.
2. **Paste handling** for URLs (smart link wrapping) and images
   (upload + insertion).
3. **Drag-and-drop upload** for images and files.
4. **Draft pages** with a "creating pages" management view, replacing
   the v1.x "create-as-private-page" workaround for attaching files
   to new pages.

These were deliberately excluded from RFC-0003 to keep the v2.1
release scope tight. RFC-0004 layers on the features that turn the
editor from "usable" to "productive".

## Round 2 changes

- **Autocomplete trigger semantics** specified precisely (`@` requires
  trailing username character; `[[Page]]` closes with bracket pair;
  display vs insert text separation).
- **Image upload UX** detailed: filename auto-generation, percent
  progress, GitHub-style `![Uploading...]()` placeholder, no
  client-side deduplication.
- **Drag-and-drop position** uses the natural cursor (driven by
  browser's dragover behaviour) rather than computed coordinates.
- **Draft pages** added as a major scope item — replaces v1.x's
  "create page on edit start" workaround. Includes a creating-pages
  management view and same-path conflict handling.
- **Upload failure** is no longer click-to-retry; failed uploads show
  a static error placeholder. Retry is a future UX investment.
- **Autocomplete cache invalidation** uses a "refresh" affordance in
  the dropdown rather than aggressive TTL or WebSocket invalidation.
- **Mobile** explicitly excluded from autocomplete; toolbar (RFC-0006)
  is the eventual mobile-friendly path.
- **Toast notification utility** scoped into RFC-0004 as a shared
  component.
- **localStorage draft recovery** (v1 feature) is explicitly NOT
  implemented; Yjs persistence in RFC-0003 obviates it.
- **Mention notification timing** finalised: on save only (matches
  RFC-0002 round 3's metadata extraction).

## Goals

- **Autocomplete makes mentions and wikilinks effortless** — typing
  `@<char>` or `[[` opens a fast, keyboard-navigable picker.
- **Paste does the obvious right thing** — URLs become autolinks (or
  Markdown link if text is selected); images get uploaded and
  inserted with `![]()` syntax.
- **Drag-and-drop matches paste** — drop a file, get an upload +
  inserted reference, with progress feedback.
- **Draft pages enable file attachment to brand-new pages**, without
  the v1.x workaround of creating a private page on edit start.
- **Failures are clearly indicated**. Upload failure shows a static
  error placeholder; users can manually delete and retry.
- **Server-side cost is bounded**. Autocomplete queries are debounced
  and cached; uploads have size limits and rate limits.

## Non-goals (this RFC)

- **Toolbar** with formatting buttons. → RFC-0006.
- **Slash commands** (`/heading`, `/table`). → RFC-0007.
- **Custom keyboard shortcuts** (Ctrl+B/I/K). Cross-platform keybinding
  design needs a dedicated discussion; no current RFC owns this.
- **Plugin contributions to autocomplete**. v2.x autocomplete sources
  are fixed: user, page. Plugins cannot contribute completion sources.
- **Rich-text paste handling** (paste from Word/Google Docs as
  Markdown). Out of scope.
- **Multi-file upload UI** (drop zones, progress lists, bulk
  operations). v2.2 ships per-file independent uploads only.
- **Click-to-retry on upload failure**. v2.2 shows a static error;
  retry workflows are deferred.
- **localStorage / IndexedDB draft recovery**. Yjs (RFC-0003)
  provides server-side draft persistence; the v1 localStorage fallback
  is unnecessary.
- **publish → draft transition** for existing published pages.
  Draft is purely a "new page in progress" state in v2.2; existing
  page draft-revert is a future RFC.
- **Mobile autocomplete**. The mobile editor doesn't trigger `@` /
  `[[` completion UI. Mobile users insert mentions / wikilinks
  manually or use future toolbar buttons (RFC-0006).
- **Promoting drafts to be visible to other users before publish**.
  Drafts are author-only.

## Overview

```
┌────────── CodeMirror 6 editor (from RFC-0003) ──────────┐
│                                                         │
│   ─ @codemirror/autocomplete extension                  │  
│         ├─ user source        ◀──── /api/v2/users/...   │
│         └─ page source        ◀──── /api/v2/pages/...   │
│                                                         │
│   ─ paste handler                                       │
│         ├─ URL: insert autolink or Markdown link        │
│         ├─ image (blob): upload → insert ![](url)       │
│         └─ text/plain: default (insert as text)         │
│                                                         │
│   ─ drop handler                                        │
│         └─ file: upload → insert ![](url) or [name](url)│
│                                                         │
└─────────────────────────────────────────────────────────┘
                       │
                       │ HTTP
                       ▼
┌──────── Crowi HTTP server ──────────────────────────────┐
│   /api/v2/users/autocomplete?q=...                      │
│   /api/v2/pages/autocomplete?q=...                      │
│   /api/v2/attachments/upload (multipart)                │
│   /api/v2/pages/drafts          (list user's drafts)    │
│   /api/v2/pages/drafts (POST)   (create new draft)      │
│   /api/v2/pages/drafts/:id (DELETE) (cancel draft)      │
└─────────────────────────────────────────────────────────┘
```

All editor-side features are pure client + HTTP. Yjs sync (RFC-0003)
remains the channel for live content; paste/drop/autocomplete
produce regular Markdown text or trigger HTTP endpoints separately.

## Autocomplete

### Triggers

| Trigger | Source | Result |
|---|---|---|
| `@` + username character (alphanumeric, `_`, `-`) | User search | Inserts `@username` |
| `[[` followed by 1+ characters | Page search | Inserts `[[Page Name]]` (closing brackets included) |

**Why `@` + character, not bare `@`**: Crowi supports `@[card](url)`
embed syntax (RFC-0002). Triggering autocomplete on bare `@` would
flash a user dropdown every time someone types an embed. Requiring
at least one username-valid character (`@a`, `@1`, etc.) avoids this
conflict — embed syntax `@[` starts with `[` which is not a username
character, so the dropdown stays closed.

### Cancellation conditions

The dropdown closes when any of:
- User presses Escape.
- User clicks outside the dropdown.
- User types a character that ends the autocomplete sequence (e.g.
  whitespace, punctuation other than allowed in usernames).
- **The query returns zero results.** No "no results" UI — the
  dropdown simply closes. Users may be typing toward a Markdown
  pattern that incidentally starts with `@<char>` and don't need
  intrusive UI.
- The user typed a `]` or `]]` after `[[Page` (which would close the
  wikilink themselves; autocomplete steps out of the way).

### Trigger precondition

The trigger character must be preceded by start-of-line, whitespace,
or punctuation. `@` inside a word (e.g. inside an email address
`user@example.com`) does NOT trigger. `[[` only triggers when both
brackets are typed in sequence.

### Insertion behaviour

**User mention**:
- Dropdown shows: avatar + display name + `@username` slug, e.g.
  `[avatar] 山田太郎 (@yamada)`.
- Insertion text: `@yamada` (the canonical username only).
- View-time rendering (per RFC-0002 mention transform): renders as
  `[avatar] 山田太郎 (@yamada)` link.

This three-way separation — **display in dropdown / insert as
Markdown / render at view time** — is uniform: the Markdown source
stays short and portable; the dropdown and viewed page show full
context.

**Wikilink**:
- Dropdown shows: page path + page title (if different from path leaf)
  + last-modified date, e.g.
  `/docs/api/spec — "API Specification"  · 2 days ago`.
- Insertion text: `[[/docs/api/spec]]` (full canonical path,
  closing brackets included).
- View-time rendering (per RFC-0002 wikilink transform): renders as
  a link to the page.

Selecting from the dropdown inserts the full `[[Page]]` pattern with
closing brackets. If the user manually types `]]` after typing
`[[Page`, the dropdown closes (user is closing the link themselves).

`[[Page#section]]` anchors are NOT autocompleted in v2.2. The
`#section` part must be typed manually.

### Behaviour timing

1. User types `@a` (`@` followed by valid character).
2. After a 100ms debounce, the editor calls the user source.
3. Source returns up to 10 candidates.
4. Dropdown appears below the cursor.
5. User navigates with arrow keys, selects with Enter or Tab.
6. Insertion replaces `@a` with `@<username>`.

### Cache invalidation: "refresh" affordance

Autocomplete uses a client-side LRU cache (50 entries, 30s TTL). When
a new user joins or a new page is created, the cache may temporarily
miss them.

To address this without aggressive TTL or push-based invalidation,
the dropdown footer includes a small **"refresh" link**:

```
┌──────────────────────────────────────┐
│ [avatar] Alice  (@alice)             │
│ [avatar] Andrew (@andrew)            │
│ [avatar] Anna   (@anna)              │
├──────────────────────────────────────┤
│ 🔄 Refresh results                   │
└──────────────────────────────────────┘
```

Clicking it bypasses the LRU cache and re-queries the server. The
fresh result is cached normally afterward.

This solves the "Alice was just added but doesn't show up" case
without requiring background pub/sub or sub-second polling.

### HTTP API

```
GET /api/v2/users/autocomplete?q=<prefix>&limit=10
GET /api/v2/pages/autocomplete?q=<prefix>&limit=10

Response:
{
  results: Array<{
    id: string,
    label: string,        // canonical text inserted (username or page path)
    display: string,      // human-readable display name (for dropdown)
    avatar?: string,      // user only
    modifiedAt?: string,  // page only
    score: number,
  }>
}
```

Implementation notes:
- **Server-side matching**: prefix > substring > fuzzy. For users:
  match `username` (highest), display name, email-local-part. For
  pages: match path (highest), then title.
- **Permission filtering**: results filtered to entities the
  requesting user can see (read permission on page, visible user).
  Draft pages are excluded UNLESS the requester is the draft's author.
- **Rate limit**: 60 req/min/user. 429 → dropdown closes silently.

### Suppression contexts

Autocomplete is suppressed inside:
- Fenced code blocks (` ``` ` / inline ` ` `).
- Math blocks (`$$ ... $$`).
- Link label or URL portions of `[text](url)` syntax.

These suppressions use CodeMirror's syntax tree to detect context.

### Mobile

Autocomplete is **not active on mobile viewports** (heuristic: width
< 768px). Reasons: keyboard popups and overlapping dropdowns produce
poor UX; the future toolbar (RFC-0006) is the mobile-friendly
alternative for inserting mentions and wikilinks.

Mobile users can still type `@username` or `[[/docs/api]]` manually;
the saved Markdown is identical.

## Paste handling

CodeMirror exposes a paste event handler. We intercept it for three
data types.

### Plain URL paste

When the clipboard's `text/plain` content, after trimming whitespace
and trailing newlines, is exactly a single well-formed `http(s)://`
URL:

- **If text is selected**: replace selection with `[selected text](url)`.
- **If no selection, cursor outside link syntax**: insert the URL as
  plain text (it'll become an autolink at render time, per RFC-0002).
- **If cursor is inside `[](...)`**: insert as plain text (don't
  double-wrap).

This matches GitHub Issue editor behaviour.

### Image paste (clipboard image blob)

When the clipboard contains image data (screenshot, image copied from
another app):

1. **Filename**: auto-generated. Format: `pasted-{timestamp}.{ext}`
   (e.g. `pasted-1717891234.png`).
2. **Placeholder**: insert `![Uploading pasted-1717891234.png (0%)…](#)`
   at the cursor position.
3. **Upload**: POST to `/api/v2/attachments/upload`, streaming
   progress.
4. **Progress updates**: as upload progresses, edit the placeholder
   text in place (Yjs transaction) to update the percentage:
   `![Uploading pasted-1717891234.png (37%)…](#)`. Other collaborators
   see this update too.
5. **On success**: replace placeholder with
   `![pasted-1717891234.png](https://crowi.example/attachments/...)`.
6. **On failure**: replace placeholder with
   `![Upload failed: pasted-1717891234.png](#)`. The error remains in
   place; user can manually delete it and re-paste to retry.

### Progress percentage rendering

The percentage in the placeholder text updates as the upload
streams. Each update is a Yjs edit on the placeholder substring,
which means collaborators in the same page see the progress count
up too. This is intentional — it's a visible indicator that someone
is working on something.

If the percentage updates would create too much Yjs traffic, the
client throttles to update every ~5% increment or every 500ms,
whichever is less frequent.

### Other paste

Plain text and other clipboard content: handled by CodeMirror's
default paste behaviour. We don't intercept.

### Paste vs autocomplete

Pasting `[[` or `@` followed by characters does NOT trigger
autocomplete. Paste is treated as user intent to insert content
verbatim. Autocomplete only triggers on direct keyboard input.

### Image paste limits

- Max image size: 10 MB.
- Allowed types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`,
  `image/svg+xml`.
- Server-side virus scan: out of scope here (existing attachment
  infrastructure).
- No client-side deduplication: pasting the same image twice
  creates two attachments. If unwanted, the user deletes the
  duplicate manually (via attachment management UI, outside this RFC).

## Drag-and-drop upload

The editor's DOM accepts `dragenter`/`dragover`/`drop` events.

### Drop position

The cursor follows the user's mouse during dragover (CodeMirror's
default behaviour already provides this). On drop, files are
inserted at the current cursor position — no separate position
computation needed.

### Visual feedback

- On `dragenter` over the editor: a subtle border / overlay
  highlights the editor area to indicate the drop is valid.
- The cursor's normal position indicator shows where files will
  be inserted (already part of CodeMirror's default UX).
- On `drop`: highlight clears immediately; upload begins.

### Behaviour

For each dropped file:

1. Determine file kind:
   - Image MIME type → insert as `![filename](url)` after upload
   - Other → insert as `[filename](url)` after upload
2. Insert placeholder at cursor position:
   `![Uploading filename.png (0%)…](#)` or
   `[Uploading filename.pdf (0%)…](#)`.
3. POST to `/api/v2/attachments/upload` with progress streaming.
4. Update placeholder text with percentage (same as paste).
5. On success: replace with the final `![](url)` / `[](url)`.
6. On failure: replace with `![Upload failed: filename.png](#)` /
   `[Upload failed: filename.pdf](#)`.

Multiple files dropped at once: process serially, in the order the
OS reports them (typically Finder selection order on macOS, file
manager order on Linux/Windows). One placeholder per file, inserted
sequentially at cursor.

### Read-only mode

When the editor is in read-only mode (20-user cap reached per
RFC-0003, or the user lacks edit permission), drag-and-drop is
disabled:
- `dragenter` does not show the drop highlight.
- `drop` events are ignored.
- A toast appears: "You don't have edit permission for this page."

### D&D limits

- Per-file size: 50 MB.
- Per-operation file count: 5 files. Dropping more triggers a toast:
  "Drop up to 5 files at a time."
- File types: configurable per-instance, default allow-list:
  - Images: same as paste
  - Documents: `.pdf`, `.txt`, `.md`, `.csv`
  - Archives: `.zip`
  - Disallowed types: toast names the rejected type.

### Where the file ends up

Existing Crowi attachment storage (RFC-0001's `registerStorage`).
The upload endpoint returns the canonical attachment URL.

## Attachment upload endpoint

```
POST /api/v2/attachments/upload
Content-Type: multipart/form-data

Fields:
  file: <binary>
  pageId: <string>           // for permission check + organisation
  intent: 'paste' | 'dnd'    // for telemetry

Response 200:
{
  url: string,
  filename: string,
  mimeType: string,
  sizeBytes: number,
}

Response 4xx:
{
  error: 'too_large' | 'disallowed_type' | 'rate_limited' | 'no_permission',
  message: string,
  details?: { ... }
}
```

Rate limit: 20 uploads/minute/user. 429 with `Retry-After` header.
The client surfaces: "Upload limit reached. Try again in N seconds."

### `pageId` for new pages: see "Draft pages" below

The `pageId` field is required, even for brand-new pages. This is
enabled by the draft-page mechanism — new pages get a real `pageId`
the moment editing begins.

## Draft pages

To enable file uploads to brand-new pages without the v1.x
"create-as-private" workaround, v2.2 introduces a first-class draft
state.

### `Page.status`

```ts
Page {
  // ... existing fields
  status: 'draft' | 'published';
}
```

- New pages start as `draft`.
- They transition to `published` exactly once, when the author hits
  "Save" / "Publish" for the first time.
- The transition is one-way in v2.2. Published pages cannot revert to
  draft.

### Lifecycle

```
User clicks "New page" / "+ at path X"
  ↓
HTTP: POST /api/v2/pages/drafts { path: "X" }
  - Server checks: no other published page at X
  - Server checks: no other user's draft at X (else: conflict)
  - Server creates Page { path: X, status: 'draft', author: <user> }
  - Returns pageId
  ↓
Browser navigates to /pages/<pageId>/edit
  ↓
Yjs session begins (RFC-0003), only the author can connect
  ↓
User edits, attaches files, etc.
  - Attachments use the real pageId from the start
  - File uploads work normally
  ↓
User clicks "Save" / "Publish"
  ↓
Server transitions: status = 'published'
RFC-0003 save flow proceeds normally
The page is now visible to all who have read access
```

### Access control during draft

- The draft page is visible only to its author.
- Yjs sessions on a draft page reject connections from any user
  other than the author. This is a new check in RFC-0003's
  `onAuthenticate` hook: "if Page.status === 'draft', require
  userId === Page.author".
- Listings, search, and backlinks exclude draft pages — except for
  the author's own "Creating pages" view (below).

### Same-path conflict

If Alice creates a draft at `/docs/api`, and Bob tries to create a
new page at the same path:

```
Bob → POST /api/v2/pages/drafts { path: "/docs/api" }
   ← 409 Conflict {
       error: 'path_taken_by_draft',
       owner: { id, username, displayName },
       message: "This page is being created by @alice.",
     }

Bob's UI shows:
  "This page is being created by 山田太郎 (@yamada). 
   If you need to work on it, please contact them directly."

No "force takeover" or "merge" workflow. Resolution is out of band.
```

If Alice cancels her draft or publishes, the conflict clears
naturally (next POST attempt succeeds).

### Creating pages view

A new view, `/me/creating-pages` (or similar), lists the user's own
drafts:

```
Pages you're creating:
  /docs/api               (started 2 hours ago)            [Edit] [Cancel]
  /journal/2026-05-12     (started yesterday)              [Edit] [Cancel]
  /todo/sprint-23         (started 3 days ago)             [Edit] [Cancel]
```

- "Edit": navigates to the draft for continued editing.
- "Cancel": deletes the draft (with confirmation). Releases the path
  for someone else to create.

No automatic deletion: drafts persist indefinitely until the user
explicitly cancels or publishes. This trades disk for predictability
— users don't lose work, and the path-conflict mechanism gives
operators visibility into stuck drafts if needed.

### Schema and API

```
GET    /api/v2/pages/drafts            — list current user's drafts
POST   /api/v2/pages/drafts            — create a new draft at a path
                                          (body: { path, initialBody? })
DELETE /api/v2/pages/drafts/<pageId>   — cancel a draft (author only)
```

The existing page CRUD APIs accept a `status` field and filter
appropriately (a `GET /api/v2/pages/by-path/<path>` returns 404 for
drafts unless the requester is the author).

### No localStorage fallback

v1.x stored editing content in localStorage to recover from tab
crashes. v2.2 doesn't need this: Yjs persists `Page.yjsState` to the
server (RFC-0003) on every edit. Closing a tab and reopening the page
restores the live state from the server. Even cross-device editing
works.

The only edge case Yjs doesn't cover is editing while completely
offline; for that, Yjs's own `y-indexeddb` adapter could be added in
a future RFC, but it's not in v2.2 scope.

## Toast notification utility

Several features in this RFC need transient user-facing notifications
("Upload limit reached", "Drop up to 5 files at a time", "This page
was modified externally", etc.). Rather than each feature inventing
its own toast UI, RFC-0004 defines a minimal shared utility.

### Interface

```ts
notify.info(message: string, options?: NotifyOptions): NotifyHandle;
notify.warn(message: string, options?: NotifyOptions): NotifyHandle;
notify.error(message: string, options?: NotifyOptions): NotifyHandle;

interface NotifyOptions {
  durationMs?: number;  // default 4000 for info, 6000 for warn, 8000 for error
  action?: {
    label: string;
    onClick: () => void;
  };
  dismissible?: boolean; // default true
}

interface NotifyHandle {
  dismiss(): void;
  update(message: string, options?: NotifyOptions): void;
}
```

### Implementation scope

- A single global toast container in the page layout.
- Stacked toasts (up to 5 visible at once; older ones fade earlier).
- Animation: slide in from bottom-right, fade out.
- Per-toast colour by level (info: neutral, warn: yellow, error: red).
- Keyboard-dismissible with Escape.
- Respects `prefers-reduced-motion`.

This is a small utility; if a future RFC expands UI patterns into a
proper design system, the toast helper migrates there with no API
change.

## Failure modes

### Upload fails mid-operation

The placeholder is replaced with a static error marker:
`![Upload failed: <filename>](#)` or `[Upload failed: <filename>](#)`.

The user can manually delete the marker and try again. There is no
retry button in v2.2. Future UX investment may add one (out of scope).

### Network drops during paste/drop

Same as upload failure. Placeholder becomes error marker.

### Autocomplete query fails

Dropdown closes silently. No toast, no retry indicator. Autocomplete
is best-effort.

### Multiple uploads in flight simultaneously

Each placeholder is independent. To disambiguate when multiple files
are uploading with the same filename, the placeholder substring used
for replacement is keyed by upload ID (not filename), so the right
placeholder gets replaced regardless of order.

### Draft same-path conflict (covered above)

Returns 409 with owner info; UI displays the contact-the-owner
message.

### Draft author loses edit permission

Edge case: the author of a draft is later removed from the system,
or has their permissions reduced. The draft becomes orphaned.

Resolution: an administrator can reassign or delete orphaned drafts
via existing admin tooling. No automatic action.

## v2.2 release scope

In scope:

- Autocomplete extension on the RFC-0003 editor.
- `@` + character trigger; `[[` + character trigger.
- Dropdown UI with display/insert text separation.
- "Refresh results" affordance in dropdown.
- Mobile suppression of autocomplete.
- `GET /api/v2/users/autocomplete` endpoint.
- `GET /api/v2/pages/autocomplete` endpoint.
- Paste handler (URL + image with progress).
- Drag-and-drop handler with cursor-positioned drop.
- Read-only mode D&D suppression.
- `POST /api/v2/attachments/upload` endpoint with progress streaming.
- Draft page state: `Page.status: 'draft' | 'published'`.
- `POST /api/v2/pages/drafts` (create), `GET` (list), `DELETE`
  (cancel).
- Same-path draft conflict (409 with owner info).
- Author-only access to drafts (Yjs and HTTP).
- "Creating pages" management view.
- Listing/search exclusion of drafts (except author's view).
- Toast utility.

Out of scope (other RFCs or deferred):

- Toolbar (RFC-0006).
- Slash commands (RFC-0007).
- Custom keybindings.
- Rich-text paste from Office documents.
- Drop zones / multi-file upload UI.
- Plugin-contributed autocomplete sources.
- Click-to-retry on failed uploads.
- Published → draft revert.
- Section anchor autocomplete (`[[Page#section]]`).
- Mobile autocomplete UI.
- Automatic draft deletion / TTL.
- localStorage / IndexedDB offline editing.

## Resolved decisions

1. **`@` trigger**: requires at least one valid username character
   after `@`. Avoids conflict with `@[card](url)` embed syntax.
2. **`@a` returning zero results**: dropdown closes silently. No
   "no results" UI.
3. **Wikilink autocomplete**: inserts full `[[Page Name]]` with
   closing brackets. No section anchor support in v2.2.
4. **Display vs insert text**: dropdown shows
   `[avatar] DisplayName (@username)`; inserts `@username`.
   View-time rendering re-expands to the full display.
5. **Image paste filename**: auto-generated as
   `pasted-{timestamp}.{ext}`. No prompt.
6. **No client-side dedup**: pasting the same image twice uploads
   twice. User cleans up via attachment management.
7. **Placeholder format**: GitHub-style `![Uploading ...]()`,
   with live percentage updates.
8. **Upload failure**: static error placeholder, no click-to-retry
   in v2.2.
9. **Autocomplete cache refresh**: dropdown footer affordance, not
   aggressive TTL or pub/sub.
10. **Paste vs autocomplete**: paste never triggers autocomplete.
11. **D&D drop position**: cursor (driven by browser dragover),
    not computed coordinates.
12. **D&D multi-file order**: OS-reported order (Finder selection
    order on macOS).
13. **Draft pages**: new pages start as `draft`, transition to
    `published` on first save. One-way.
14. **Draft access**: author-only. Listings/search exclude drafts.
15. **Same-path conflict**: 409 with owner info; UI shows
    contact-the-owner message. No takeover.
16. **No automatic draft deletion**. Persist until user cancels or
    publishes.
17. **No localStorage recovery**. Yjs server-side state replaces it.
18. **Mention notification timing**: on save only (matches RFC-0002
    round 3's metadata extraction pipeline).
19. **Mobile autocomplete**: disabled. Toolbar (RFC-0006) is the
    eventual mobile-friendly alternative.
20. **Toast utility**: scoped into RFC-0004 as a shared helper.
21. **Accessibility**: ARIA combobox pattern for autocomplete,
    keyboard alternative (file picker button) for D&D. Implementation
    detail; not separately specified here.

## Open questions

1. **Page autocomplete: full path vs path-leaf insertion.** Currently
   we insert the full canonical path (`[[/docs/api/spec]]`) for
   unambiguity. Some users may prefer just `[[spec]]` if their
   wikilink resolution is namespace-aware. Defer until usage data
   indicates pain.

2. **D&D file type allow-list configuration.** Should the allow-list
   be a global instance setting, or per-user-group? v2.2 ships
   global only.

3. **Coordination with Renderer plugins for paste.** GitHub URL paste
   could plausibly trigger `@[card](url)` if the GitHub embed plugin
   is installed. Lean no for v2.2 — keep paste simple and
   predictable. Revisit if user demand emerges.

4. **Draft cleanup at scale.** If a Crowi instance accumulates
   thousands of abandoned drafts, the "Creating pages" view becomes
   unwieldy and disk usage grows. v2.2 trades this risk for
   predictability. A future RFC may add admin-side bulk-cleanup tools
   if needed.

5. **Cross-tab draft conflict for the same user.** If Alice opens
   `/docs/api`'s draft in two browser tabs, Yjs synchronisation
   handles concurrent edits correctly (per RFC-0003). But the
   "Creating pages" view in both tabs may show stale state. Lean:
   accept; eventual consistency on the listing view is fine.

6. **`[[Page]]` ambiguity when multiple pages share a path-leaf.**
   If two pages exist at `/team/api` and `/external/api`, typing
   `[[api]]` is ambiguous. The dropdown disambiguates by showing
   full path, but the inserted Markdown also uses full path. No
   ambiguity in storage; only in UX. Likely fine.

7. **Attachment URL vs canonical link in paste.** When pasting a URL
   that points to an existing Crowi attachment (e.g. user copied an
   image URL from an existing page), should we link to it or
   re-upload? Lean: link to it (avoid duplicate storage). Detection
   is non-trivial; defer.

## Implementation plan (informational)

1. **Toast utility**: implement the shared `notify` helper first;
   subsequent features depend on it.
2. **Draft page state**: schema migration to add `Page.status`;
   existing pages default to `'published'`. Update relevant queries
   to filter drafts.
3. **Draft endpoints**: `POST/GET/DELETE /api/v2/pages/drafts`.
4. **Creating pages view**: frontend route + listing UI.
5. **Same-path conflict response and UI**: 409 handling, owner
   info display.
6. **RFC-0003 auth hook update**: deny non-author connection to
   draft pages.
7. **Autocomplete**: add `@codemirror/autocomplete`, implement user
   and page sources, debounce, LRU cache, refresh affordance,
   mobile suppression, suppression contexts.
8. **Autocomplete HTTP endpoints**: implement with permission
   filtering and rate limiting.
9. **Paste handler**: URL detection, image blob detection with
   placeholder + progress updates.
10. **`POST /api/v2/attachments/upload`**: wrap existing storage with
    progress streaming.
11. **Drag-and-drop**: dragenter/dragover/drop handlers, file
    iteration, placeholder + progress updates.
12. **Read-only mode integration**: disable D&D when read-only.
13. **End-to-end tests**: paste URL with/without selection, paste
    image with progress, drop file (single and multi), drop in
    read-only mode, draft creation/publish/cancel, same-path
    conflict, autocomplete trigger/cancel scenarios.
14. **Documentation**: user-facing guide for draft pages, autocomplete,
    uploads. Operator-facing guide for rate limit + file-type config.
