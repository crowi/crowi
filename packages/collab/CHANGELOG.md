# @crowi/collab

## 0.1.0-alpha.4

### Patch Changes

- 3ba4c69: Add the first writer for page history (RFC-0021 Phase 2a): every content save (page create, draft create, HTTP update/revert, collaborative editor save, and `crowi-admin replace url`) now assigns a page-local `historySequence` to its Revision, promoting the page's `historyTracking` to `ready` on its first tracked save. Sequence assignment runs as a separate, resumable step after the existing pointer write commits, never as part of it, so a crash between the two never fails the save — a background/operator repair pass recovers any interrupted assignment. `scanUnsequencedRevisions` now skips Revisions younger than a configurable grace window (`RepairScanOptions.minAgeMs`, default 10 minutes) and Revisions predating a page's tracking start, so it never races a still-in-flight assignment or mis-orders history. No request/response shape, status code, error body, or OpenAPI contract changes — this is purely additive bookkeeping invisible to end users.
- Updated dependencies [c1cb3d5]
  - @crowi/api-contract@2.0.0-alpha.15

## 0.1.0-alpha.3

### Patch Changes

- a899fdd: Fix a correctness hole where a live collaborative editor open before a page was renamed, soft-deleted, or reverted could still save its content afterwards, silently clobbering the renamed/deleted state instead of being rejected.
  The fix introduces a monotonic collab lifecycle epoch (`Page.collabLifecycleVersion`) that advances atomically with every rename/delete/revert/body-replace and is enforced at four boundaries — wsToken mint, WebSocket authentication, document load, and the atomic save compare-and-set — so a stale editor session is refused rather than allowed to overwrite the page, including across multiple api replicas.
  Rename/delete now also opens the existing reload-prompt dialog on any live editor for that page, and soft/hard delete purge the page's collaborative editing state (Yjs snapshot and pending updates) as defense-in-depth.
- Updated dependencies [d9eb1c0]
- Updated dependencies [a899fdd]
- Updated dependencies [f1bcd2b]
- Updated dependencies [29b3679]
- Updated dependencies [a32204f]
- Updated dependencies [b0e2c76]
- Updated dependencies [3b27a67]
  - @crowi/api-contract@2.0.0-alpha.8

## 0.1.0-alpha.2

### Minor Changes

- 6bbbecd: Harden the realtime collaborative editor against data loss and external-edit divergence. This is the full implementation of the reliability work: alpha.2 shipped only a small seed of external-edit invalidation under an over-scoped changeset, and the complete implementation (a ~5k-line overhaul across `@crowi/collab` and the api collab host) lands here.

  Guard the Yjs document state against shrink and loss: compaction never replaces a document with a smaller or empty state, the document's base revision is persisted so a reconnecting client re-materialises from the correct revision body, and an empty-load fallback rebuilds the doc from the stored revision instead of starting blank.

  External (REST / MCP / in-process) edits now invalidate a live collab session in the same api process: after the page commits, Crowi broadcasts a force-reload, tombstones the document so an in-flight stale save is rejected with a reload prompt instead of CONFLICT-looping, gates reconnects so they re-materialise from the new revision, and drains the stale connections (a force-reload was previously a no-op while any client stayed connected). Two concurrent same-process saves carrying a byte-identical body now coalesce into a single success with the loser recorded as a contributor, while a genuine divergence still surfaces as CONFLICT so the user reloads.

  Multi-instance / out-of-process external edits (a live doc on another replica, or an admin-CLI DB-direct edit) remain a documented limitation requiring a future cross-instance invalidation channel; a single api instance is recommended (see the realtime-collab operations doc).

## 0.1.0-alpha.1

### Patch Changes

- 27ef287: Fix v1-era pages getting corrupted when opened in the collaborative editor.
  Revision bodies were seeded into the Y.Text verbatim, but Crowi v1 saved
  bodies with CRLF (`\r\n`) line endings while CodeMirror 6 strips every `\r`
  when it builds its document. That left the Y.Text one character longer per
  line than the editor's view, and because y-codemirror.next maps positions
  1:1 between them, every subsequent edit landed at the wrong offset and
  progressively mangled the document (worse toward the end of the page).

  The `onLoadDocument` body seed now normalizes CRLF / lone CR to LF before
  inserting into the Y.Text, keeping it length-aligned with the editor.
  Markdown rendering is line-ending agnostic, so this is a no-op for
  already-LF (v2-authored) bodies. Pages that were already corrupted by a
  prior edit must be restored from a pre-corruption revision.

- Updated dependencies [0e9a07c]
  - @crowi/api-contract@2.0.0-alpha.1

## 0.1.0-alpha.0

### Patch Changes

- Updated dependencies [8d8e04d]
- Updated dependencies [c7443c4]
- Updated dependencies [ce294dd]
- Updated dependencies [ad0cc9b]
- Updated dependencies [32f5965]
- Updated dependencies [9c55f6c]
- Updated dependencies [548e0c8]
- Updated dependencies [a52d03f]
- Updated dependencies [a0f4ada]
- Updated dependencies [966d133]
- Updated dependencies [e7296c0]
- Updated dependencies [ec00876]
- Updated dependencies [8f12462]
- Updated dependencies [637f0c9]
- Updated dependencies [deb6a26]
- Updated dependencies [ea2b7db]
- Updated dependencies [ee935ad]
- Updated dependencies [b8c067b]
- Updated dependencies [ab063fe]
- Updated dependencies [87f35d4]
- Updated dependencies [be5fcee]
- Updated dependencies [088f922]
- Updated dependencies [97e6543]
- Updated dependencies [10ac192]
- Updated dependencies [9899d5f]
- Updated dependencies [4594ad2]
  - @crowi/api-contract@2.0.0-alpha.0
