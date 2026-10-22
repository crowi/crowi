---
"@crowi/api": minor
"@crowi/api-contract": minor
"@crowi/web": minor
---

While viewing a page, another user's comment now appears (or disappears) in the comment list in place, without a reload — the sibling of the live body soft-refresh, targeting the comment list instead of the body revision.

When someone else posts or deletes a comment on a page you are reading, your comment list updates silently: an added comment is appended and briefly highlighted with the same amber background as the section highlight (fading after a few seconds), and a deleted comment is removed. Your own posts never trigger the append or highlight — your own action already updated the list.

- The signal rides the already-open `/presence/<pageId>` WebSocket (no new connection): a `comment-changed` frame carries `{ pageId, changeType, commentId, actorUserId? }` — never the comment body, which is re-fetched from the grant-checked `GET /comments?page_id=`. `PresenceServerMessage` gains a third `comment-changed` member of its discriminated union (api-contract).
- Multi-instance deployments fan out across replicas via a dedicated `crowi:presence:comment-changed` Redis channel. It does not add a subscriber connection — it piggybacks the existing page-updated subscriber as a second channel. Single-instance dev works without Redis.
- `added` frames from your own account (`actorUserId === selfUserId`) are suppressed; `removed` frames always re-fetch (the deleter is not known at the model event layer, and a redundant idempotent re-fetch is harmless). The new-comment highlight is derived from a client-side seen-set diff, so the origin double-delivery and dropped frames never re-highlight an existing comment.
- Historical (`?revision_id=`) and draft views are structurally excluded — they never open a presence socket. The header's comment-count chip live-update is out of scope.
