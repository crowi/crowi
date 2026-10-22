---
"@crowi/api": patch
---

Fix rename so it promotes an untracked page to tracked history in place instead of silently skipping its history event.

A page created before history tracking existed, or otherwise never promoted by a content save, previously moved successfully on rename but recorded no `page_renamed` event and never became history-tracked — and in a subtree rename, such a member was reported as a failure even though its page moved correctly. Rename now checks the page's current revision pointer right before the move: if it is untracked but owns a valid revision, that page is promoted to tracked history in the same request, the move proceeds as an ordinary tracked rename, and the event is recorded. A page with no revision pointer, or whose pointer cannot be confirmed to belong to it, is left exactly as before — it still moves, just without gaining history tracking. A promotion that cannot complete safely (a transient conflict) is reported the same way other transient rename conflicts are, and retrying succeeds.
