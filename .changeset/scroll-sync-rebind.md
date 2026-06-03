---
'@crowi/web': patch
---

Fix one-way editor scroll sync in the page editor: scrolling the editor
no longer failed to move the preview. The collaborative editor remounts
its inner CodeMirror view (via `key`) once the realtime document becomes
ready, producing a fresh scroll element. The scroll-sync hook had bound
its editor→preview listener to the *original* element and never
re-bound, so after the ~100ms collab handshake that listener was dead
(preview→editor kept working because it dereferences the live editor
handle). The hook now re-binds when the editor view is recreated.
