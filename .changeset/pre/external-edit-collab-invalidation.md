---
"@crowi/api": patch
---

Make external edits and concurrent saves converge cleanly for the collaborative
editor.

External (REST / MCP / in-process) edits now invalidate a live collab session
in the same api process: after `Page.updatePage` commits (dropping
`Page.yjsState` + re-pointing `currentRevision`), Crowi broadcasts a
force-reload to connected editors, tombstones the document so an in-flight
stale save is rejected with a reload prompt instead of looping on CONFLICT,
gates reconnects so they re-materialise from the new revision body, and drains
the stale connections. Previously a force-reload alone was a no-op while any
client stayed connected (the live Y.Doc survived), so connected editors kept
CONFLICT-looping until everyone disconnected.

Two concurrent saves on the same shared document no longer false-CONFLICT: when
the compare-and-set loser carries a byte-identical body to the same-process
winner, the save coalesces and returns the winner's revision as a success (the
loser is recorded as a contributor). A genuine divergence (an external edit, or
a different body) still surfaces as CONFLICT so the user reloads.

Multi-instance / out-of-process external edits (a live doc on another replica,
or an admin-CLI DB-direct edit) remain a documented limitation — converging
those needs a future cross-instance invalidation channel; a single instance is
recommended (see the realtime-collab operations doc).
